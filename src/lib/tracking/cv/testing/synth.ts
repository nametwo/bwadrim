import type { GrayImage, Mat3 } from "../../types";
import { invert3, mul3 } from "../../geometry";
import { Rng } from "../rng";

// 테스트용 합성 영상: 절차적 텍스처 + 알려진 호모그래피 워프 + 잡음.
// 라이브러리 코드는 이 파일을 import하지 않는다 (테스트·벤치 전용).

export interface TextureOptions {
  /** 도형 개수 */
  shapes?: number;
  /** 도형 크기 범위 (px) */
  minSize?: number;
  maxSize?: number;
  /** 저주파 배경 진폭 */
  bgAmplitude?: number;
  /** 배경 평균 밝기 */
  bgLevel?: number;
  /** 도형 대비 (0~1) */
  contrast?: number;
}

function valueNoise(w: number, h: number, cell: number, rng: Rng): Float32Array {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rng.next() * 2 - 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / cell;
    const iy = Math.floor(fy);
    let ty = fy - iy;
    ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = x / cell;
      const ix = Math.floor(fx);
      let tx = fx - ix;
      tx = tx * tx * (3 - 2 * tx);
      const a = g[iy * gw + ix];
      const b = g[iy * gw + ix + 1];
      const c = g[(iy + 1) * gw + ix];
      const d = g[(iy + 1) * gw + ix + 1];
      out[y * w + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

/** 부동소수 캔버스 → 8비트 */
export function toGray(f: Float32Array, w: number, h: number): GrayImage {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = Math.max(0, Math.min(255, Math.round(f[i])));
  return { width: w, height: h, data };
}

/**
 * "죽은 잎" 스타일 텍스처: 저주파 배경 + 임의 사각형/타원/선/점.
 * 2배 해상도로 그려 상자 필터로 줄여 계단 현상을 줄인다.
 */
export function makeTexture(w: number, h: number, seed: number, o: TextureOptions = {}): GrayImage {
  const rng = new Rng(seed);
  const S = 2;
  const W = w * S;
  const H = h * S;
  const shapes = o.shapes ?? Math.round((w * h) / 900);
  const minSize = (o.minSize ?? 4) * S;
  const maxSize = (o.maxSize ?? 40) * S;
  const bgA = o.bgAmplitude ?? 40;
  const bgL = o.bgLevel ?? 128;
  const contrast = o.contrast ?? 1;
  const f = new Float32Array(W * H);
  const n1 = valueNoise(W, H, 64 * S, rng);
  const n2 = valueNoise(W, H, 16 * S, rng);
  for (let i = 0; i < W * H; i++) f[i] = bgL + bgA * n1[i] + bgA * 0.35 * n2[i];

  for (let s = 0; s < shapes; s++) {
    const kind = rng.int(5);
    const cx = rng.range(0, W);
    const cy = rng.range(0, H);
    const sz = Math.exp(rng.range(Math.log(minSize), Math.log(maxSize)));
    const val = bgL + contrast * rng.range(-110, 110);
    const ang = rng.range(0, Math.PI);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const a = sz * rng.range(0.4, 1);
    const b = sz * rng.range(0.2, 1);
    const R = Math.ceil(Math.max(a, b) * 1.5) + 2;
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(W - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(H - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const u = dx * ca + dy * sa;
        const v = -dx * sa + dy * ca;
        let inside = false;
        if (kind === 0 || kind === 1) inside = Math.abs(u) <= a && Math.abs(v) <= b;
        else if (kind === 2) inside = (u * u) / (a * a) + (v * v) / (b * b) <= 1;
        else if (kind === 3) inside = Math.abs(v) <= Math.max(1.5 * S, b * 0.12) && Math.abs(u) <= a * 1.5;
        else inside = (u * u) / (a * a) + (v * v) / (b * b) <= 1 && (u * u) / (a * a * 0.25) + (v * v) / (b * b * 0.25) > 1;
        if (inside) f[y * W + x] = val;
      }
    }
  }
  // 상자 필터로 1/S 축소
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) s += f[(y * S + yy) * W + x * S + xx];
      out[y * w + x] = s / (S * S);
    }
  }
  return toGray(out, w, h);
}

/** 무늬 거의 없는 영상: 완만한 그라디언트 + 약한 잡음 */
export function makeFlat(w: number, h: number, seed: number, noise = 1.5): GrayImage {
  const rng = new Rng(seed);
  const f = new Float32Array(w * h);
  const n = valueNoise(w, h, 120, rng);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      f[y * w + x] = 120 + 30 * (x / w) + 12 * n[y * w + x] + rng.gauss() * noise;
    }
  }
  return toGray(f, w, h);
}

export interface PortRowOptions {
  /** 포트 간격 (px) */
  period: number;
  /** 포트 개수 */
  count: number;
  /** 고유한 라벨(비반복 무늬)을 행 아래 한쪽에 둘지 */
  uniqueLabel: boolean;
  seed: number;
}

/**
 * 반복 패턴: 똑같은 "LAN 포트" 여러 개가 한 줄로 늘어선 판.
 * 선택적으로 한 포트 아래에만 고유 라벨을 둔다.
 */
export function makePortRow(w: number, h: number, o: PortRowOptions): GrayImage {
  const rng = new Rng(o.seed);
  const S = 2;
  const W = w * S;
  const H = h * S;
  const f = new Float32Array(W * H).fill(170);
  // 판 위 약한 얼룩(현실감) — 반복을 깨지 않을 정도로 아주 약하게
  const n = valueNoise(W, H, 90 * S, rng);
  for (let i = 0; i < W * H; i++) f[i] += 4 * n[i];
  const P = o.period * S;
  const pw = P * 0.72;
  const ph = P * 0.62;
  const rowY = H * 0.45;
  const x0 = W / 2 - (P * (o.count - 1)) / 2;
  const fillRect = (ax: number, ay: number, bx: number, by: number, v: number) => {
    for (let y = Math.max(0, Math.floor(ay)); y < Math.min(H, Math.ceil(by)); y++) {
      for (let x = Math.max(0, Math.floor(ax)); x < Math.min(W, Math.ceil(bx)); x++) f[y * W + x] = v;
    }
  };
  for (let k = 0; k < o.count; k++) {
    const cx = x0 + k * P;
    // 포트 외곽(어두운 틀) + 내부 + 걸쇠 홈 + 핀 줄
    fillRect(cx - pw / 2, rowY - ph / 2, cx + pw / 2, rowY + ph / 2, 40);
    fillRect(cx - pw / 2 + 2 * S, rowY - ph / 2 + 2 * S, cx + pw / 2 - 2 * S, rowY + ph / 2 - 2 * S, 90);
    fillRect(cx - pw * 0.18, rowY + ph / 2 - 2 * S, cx + pw * 0.18, rowY + ph / 2 + 1 * S, 40);
    for (let p = 0; p < 4; p++) {
      const px = cx - pw * 0.3 + (p * pw * 0.6) / 3;
      fillRect(px - 0.8 * S, rowY - ph / 2 + 3 * S, px + 0.8 * S, rowY - ph / 2 + 6 * S, 220);
    }
    // 포트 위 LED 두 개
    fillRect(cx - pw * 0.35, rowY - ph / 2 - 5 * S, cx - pw * 0.2, rowY - ph / 2 - 3 * S, 230);
    fillRect(cx + pw * 0.2, rowY - ph / 2 - 5 * S, cx + pw * 0.35, rowY - ph / 2 - 3 * S, 60);
  }
  if (o.uniqueLabel) {
    // 가운데 포트 아래에 "글자" 비슷한 고유 무늬
    const cx = x0 + Math.floor(o.count / 2) * P;
    const ly = rowY + ph / 2 + 6 * S;
    for (let c = 0; c < 6; c++) {
      const gx = cx - pw * 0.8 + c * pw * 0.3;
      const hgt = (4 + rng.int(6)) * S;
      fillRect(gx, ly, gx + 1.5 * S, ly + hgt, 30);
      if (rng.next() < 0.6) fillRect(gx, ly + hgt * 0.4, gx + 4 * S, ly + hgt * 0.4 + 1.5 * S, 30);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) s += f[(y * S + yy) * W + x * S + xx];
      out[y * w + x] = s / (S * S);
    }
  }
  return toGray(out, w, h);
}

export interface RenderOptions {
  /** 초표본 격자 한 변 (1 = 안 함) */
  supersample?: number;
  /** 가우시안 잡음 σ */
  noise?: number;
  /** 밝기 이득·편향 */
  gain?: number;
  bias?: number;
  /** 월드 밖 채움 값 */
  fill?: number;
  rng?: Rng;
}

/**
 * world(0단계 픽셀) → frame 호모그래피 V로 프레임을 렌더링 (역매핑 + 쌍선형 + 초표본).
 */
export function renderView(world: GrayImage, V: Mat3, w: number, h: number, o: RenderOptions = {}): GrayImage {
  const inv = invert3(V);
  if (!inv) throw new Error("singular view");
  const ss = o.supersample ?? 2;
  const noise = o.noise ?? 0;
  const gain = o.gain ?? 1;
  const bias = o.bias ?? 0;
  const fill = o.fill ?? 128;
  const rng = o.rng ?? new Rng(12345);
  const W = world.width;
  const H = world.height;
  const d = world.data;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss - 0.5;
          const py = y + (sy + 0.5) / ss - 0.5;
          const Z = inv[6] * px + inv[7] * py + inv[8];
          const X = (inv[0] * px + inv[1] * py + inv[2]) / Z;
          const Y = (inv[3] * px + inv[4] * py + inv[5]) / Z;
          if (Z > 0 && X >= 0 && Y >= 0 && X < W - 1 && Y < H - 1) {
            const ix = Math.floor(X);
            const iy = Math.floor(Y);
            const fx = X - ix;
            const fy = Y - iy;
            const i = iy * W + ix;
            acc += d[i] * (1 - fx) * (1 - fy) + d[i + 1] * fx * (1 - fy) + d[i + W] * (1 - fx) * fy + d[i + W + 1] * fx * fy;
          } else {
            acc += fill;
          }
        }
      }
      let v = (acc / (ss * ss)) * gain + bias;
      if (noise > 0) v += rng.gauss() * noise;
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { width: w, height: h, data: out };
}

export interface CamParams {
  /** 이동 (px) */
  tx?: number;
  ty?: number;
  /** 회전 (라디안) */
  rot?: number;
  /** 배율 */
  scale?: number;
  /** 원근 기울임 (1/px 단위의 작은 값, 예: 0.0008) */
  px?: number;
  py?: number;
  /** 변환 중심 */
  cx: number;
  cy: number;
}

/**
 * 중심 (cx, cy) 기준: 원근 → 배율·회전 → 이동. 반환값은 입력 좌표 → 출력 좌표.
 */
export function camHomography(p: CamParams): Mat3 {
  const s = p.scale ?? 1;
  const r = p.rot ?? 0;
  const c = Math.cos(r) * s;
  const sn = Math.sin(r) * s;
  const Tm: Mat3 = [1, 0, -p.cx, 0, 1, -p.cy, 0, 0, 1];
  const P: Mat3 = [1, 0, 0, 0, 1, 0, p.px ?? 0, p.py ?? 0, 1];
  const RS: Mat3 = [c, -sn, 0, sn, c, 0, 0, 0, 1];
  const Tp: Mat3 = [1, 0, p.cx + (p.tx ?? 0), 0, 1, p.cy + (p.ty ?? 0), 0, 0, 1];
  return mul3(Tp, mul3(RS, mul3(P, Tm)));
}

/** 가우시안 잡음 추가 (제자리) */
export function addNoise(img: GrayImage, sigma: number, rng: Rng): void {
  for (let i = 0; i < img.data.length; i++) {
    img.data[i] = Math.max(0, Math.min(255, Math.round(img.data[i] + rng.gauss() * sigma)));
  }
}
