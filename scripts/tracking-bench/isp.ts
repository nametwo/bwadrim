// 폰 ISP 흉내 (센서 → 톤 곡선은 렌더러 LUT에서, 여기서는 그 뒤 8bit 감마 영역 처리):
//   시간 잡음 제거(TNR) — 움직임 적응 재귀 필터(움직임 보상 없음): 작은 차이는 이전 출력과 섞고, 큰 차이(움직임)는 새 값.
//     → 정지 화면 잡음은 줄지만 대비 낮은 가장자리는 움직일 때 끌린다(잔상·번짐).
//   언샤프 마스크 샤프닝 — 가장자리에 밝고 어두운 테(halo)가 생긴다. 작은 차이(잡음)는 코어링으로 뺀다.
//
// 결정적·조각 독립: 카메라 프레임 i의 출력은 항상 i−window…i의 원시 프레임으로만 계산한다(시작은 원시 i−window).
// 그래서 작업자가 어느 프레임부터 렌더하든 같은 바이트가 나온다. 원시 프레임은 LRU로 재사용.
import type { CameraFrame } from "./render";

export interface IspSpec {
  /** 톤 곡선 (렌더러 LUT에 합쳐짐): 감마(sRGB 뒤 추가 거듭제곱), S커브 세기, 암부 들어올림 */
  tone?: { gamma?: number; s?: number; lift?: number };
  /** 언샤프 마스크: 흐림 σ(스트림 px), 세기, 코어링 문턱(계조) */
  sharpen?: { sigma: number; amount: number; threshold?: number };
  /** TNR: 새 프레임 가중 alpha(정지 영역), 움직임 판정 차이 lo→hi(계조, 3x3 평균 |차이|), 창 길이(프레임) */
  tnr?: { alpha: number; lo: number; hi: number; window?: number };
}

/** 시각 → 30fps 카메라 프레임 번호 */
export function cameraIndex(t: number, fps: number): number {
  return Math.round(t * fps);
}

export class IspPipeline {
  private raw = new Map<number, CameraFrame>();
  private tmp = new Float32Array(0);
  private tmp2 = new Float32Array(0);

  constructor(
    readonly spec: IspSpec,
    /** 카메라 프레임 i의 원시 렌더 (톤 LUT까지 적용된 8bit) */
    private readonly renderRaw: (i: number) => CameraFrame,
  ) {}

  private getRaw(i: number): CameraFrame {
    let f = this.raw.get(i);
    if (!f) {
      f = this.renderRaw(i);
      this.raw.set(i, f);
      const keep = (this.spec.tnr?.window ?? 6) + 3;
      if (this.raw.size > keep) {
        const drop = [...this.raw.keys()].sort((a, b) => a - b).slice(0, this.raw.size - keep);
        for (const k of drop) this.raw.delete(k);
      }
    }
    return f;
  }

  /** 카메라 프레임 i의 ISP 출력 */
  frame(i: number): CameraFrame {
    const cur = this.getRaw(i);
    const W = cur.width;
    const H = cur.height;
    const N = W * H;
    const nch = cur.planes.length;
    const planes: Float32Array[] = cur.planes.map((p) => Float32Array.from(p));
    const tn = this.spec.tnr;
    if (tn && tn.alpha < 1) {
      const win = tn.window ?? 6;
      // 창 시작: 크기가 같은 가장 이른 프레임 (방향 전환이면 거기서 끊김)
      let start = i;
      for (let j = i - 1; j >= i - win; j--) {
        const f = this.getRaw(j);
        if (f.width !== W || f.height !== H) break;
        start = j;
      }
      if (start < i) {
        const acc: Float32Array[] = this.getRaw(start).planes.map((p) => Float32Array.from(p));
        for (let j = start + 1; j <= i; j++) {
          const f = j === i ? cur : this.getRaw(j);
          this.tnrStep(acc, f.planes, W, H, tn);
        }
        for (let c = 0; c < nch; c++) planes[c] = acc[c];
      }
    }
    const sh = this.spec.sharpen;
    if (sh && sh.amount > 0) for (let c = 0; c < nch; c++) this.unsharp(planes[c], W, H, sh);
    const out: Uint8Array[] = planes.map((p) => {
      const o = new Uint8Array(N);
      for (let k = 0; k < N; k++) {
        const v = Math.round(p[k]);
        o[k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      return o;
    });
    return { width: W, height: H, planes: out };
  }

  /** acc ← acc + w·(new − acc), w = alpha..1 (움직임 판정은 휘도(첫 평면) 3x3 평균 |차이|) */
  private tnrStep(acc: Float32Array[], cur: Uint8Array[], W: number, H: number, tn: NonNullable<IspSpec["tnr"]>): void {
    const N = W * H;
    if (this.tmp.length !== N) {
      this.tmp = new Float32Array(N);
      this.tmp2 = new Float32Array(N);
    }
    const d = this.tmp;
    const m = this.tmp2;
    const a0 = acc[0];
    const c0 = cur[0];
    for (let k = 0; k < N; k++) d[k] = Math.abs(c0[k] - a0[k]);
    // 3x3 평균 (가로 → 세로)
    for (let y = 0; y < H; y++) {
      const r = y * W;
      for (let x = 0; x < W; x++) {
        const l = x > 0 ? d[r + x - 1] : d[r + x];
        const rr = x < W - 1 ? d[r + x + 1] : d[r + x];
        m[r + x] = (l + d[r + x] + rr) / 3;
      }
    }
    const lo = tn.lo;
    const span = Math.max(1e-6, tn.hi - tn.lo);
    for (let y = 0; y < H; y++) {
      const up = y > 0 ? (y - 1) * W : y * W;
      const dn = y < H - 1 ? (y + 1) * W : y * W;
      const r = y * W;
      for (let x = 0; x < W; x++) {
        const md = (m[up + x] + m[r + x] + m[dn + x]) / 3;
        let s = (md - lo) / span;
        s = s <= 0 ? 0 : s >= 1 ? 1 : s * s * (3 - 2 * s);
        const w = tn.alpha + (1 - tn.alpha) * s;
        for (let c = 0; c < acc.length; c++) {
          const a = acc[c];
          a[r + x] += w * (cur[c][r + x] - a[r + x]);
        }
      }
    }
  }

  /** p ← p + amount·coring(p − G_σ p) */
  private unsharp(p: Float32Array, W: number, H: number, sh: NonNullable<IspSpec["sharpen"]>): void {
    const blur = gaussian(p, W, H, sh.sigma);
    const thr = sh.threshold ?? 0;
    for (let k = 0; k < p.length; k++) {
      let d = p[k] - blur[k];
      if (thr > 0) {
        // 부드러운 코어링: |d| < thr → 0, 그 위로 선형
        const ad = Math.abs(d);
        d = ad <= thr ? 0 : Math.sign(d) * (ad - thr * (thr / ad));
      }
      p[k] += sh.amount * d;
    }
  }
}

/** 분리형 가우시안 (가장자리 복제) — 새 배열 */
export function gaussian(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= W ? W - 1 : x + i;
        v += k[i + r] * src[o + xx];
      }
      tmp[o + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= H ? H - 1 : y + i;
        v += k[i + r] * tmp[yy * W + x];
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

/**
 * ISP 톤 곡선 (sRGB 부호화 값 e∈[0,1] → e′). 렌더러 톤 LUT에서 sRGB 뒤·대비 앞에 끼운다.
 * gamma: e^(1/γ) 방향 추가 (γ>1이면 중간톤이 밝아짐), s: S커브(중간 대비↑, 양끝 압축), lift: 암부 들어올림.
 */
export function ispTone(e: number, t: NonNullable<IspSpec["tone"]>): number {
  let v = e;
  if (t.gamma && t.gamma !== 1) v = Math.pow(v, 1 / t.gamma);
  if (t.s) {
    const x = 2 * v - 1; // −1..1
    v = 0.5 + 0.5 * (x + t.s * x * (1 - x * x) * 1.5);
  }
  if (t.lift) v = t.lift + (1 - t.lift) * v;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
