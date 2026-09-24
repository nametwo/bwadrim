import type { GrayImage, Rect } from "../types";
import { CornerList, detectFast, gridFilter, scoreCorners } from "./fast";
import { Pyramid, blur7, ensureImage, pyrDown, resizeBilinear, type Pixels } from "./image";
import { Rng } from "./rng";

// ORB (Rublee et al. 2011) 자체 구현:
//   √2 간격 스케일 피라미드 → FAST-9 + Harris 순위 + 격자 분산
//   → 강도 중심(intensity centroid) 방향 → 회전된 BRIEF 256비트.
// BRIEF 비교쌍은 OpenCV 학습 테이블을 쓰지 않고 시드 고정 PRNG로 등방 가우시안에서 뽑는다(BRIEF G II).

/** 디스크립터 길이 (32비트 단어 수, 256비트). 저장은 Int32Array (V8에서 부호 없는 값이 double로 새지 않게) */
export const DESC_WORDS = 8;
/** 패치 반지름 (단계 픽셀). 방향·BRIEF 모두 이 원 안만 본다 */
export const PATCH_RADIUS = 12;
/** 키포인트가 단계 이미지 가장자리에서 떨어져야 하는 거리 */
export const ORB_BORDER = PATCH_RADIUS + 2;

const N_PAIRS = 256;
const N_BINS = 32;
const PATTERN_SEED = 0x0b0ad12e;

// ───────────────────────── 비교쌍 패턴 ─────────────────────────

/** (x1, y1, x2, y2) × 256, 패치 좌표(실수, 회전 전) */
const PATTERN: Float64Array = buildPattern();

function buildPattern(): Float64Array {
  const rng = new Rng(PATTERN_SEED);
  const out = new Float64Array(N_PAIRS * 4);
  const sigma = (2 * PATCH_RADIUS + 1) / 5;
  const rmax = PATCH_RADIUS - 0.75; // 회전 후 반올림해도 원 안
  const sample = (): [number, number] => {
    for (;;) {
      const x = rng.gauss() * sigma;
      const y = rng.gauss() * sigma;
      if (x * x + y * y <= rmax * rmax) return [x, y];
    }
  };
  let n = 0;
  while (n < N_PAIRS) {
    const [x1, y1] = sample();
    const [x2, y2] = sample();
    // 너무 가까운 쌍은 잡음에 민감 → 버림
    if ((x1 - x2) ** 2 + (y1 - y2) ** 2 < 4) continue;
    // 기존 쌍과 거의 같은 쌍 버림 (정보 중복)
    let dup = false;
    for (let k = 0; k < n && !dup; k++) {
      const a = k * 4;
      const d1 = Math.abs(out[a] - x1) + Math.abs(out[a + 1] - y1);
      const d2 = Math.abs(out[a + 2] - x2) + Math.abs(out[a + 3] - y2);
      const e1 = Math.abs(out[a] - x2) + Math.abs(out[a + 1] - y2);
      const e2 = Math.abs(out[a + 2] - x1) + Math.abs(out[a + 3] - y1);
      if ((d1 < 1 && d2 < 1) || (e1 < 1 && e2 < 1)) dup = true;
    }
    if (dup) continue;
    out[n * 4] = x1;
    out[n * 4 + 1] = y1;
    out[n * 4 + 2] = x2;
    out[n * 4 + 3] = y2;
    n++;
  }
  return out;
}

/** 방향 bin별 정수 (dx, dy) 오프셋: [bin][pair*4 + (x1,y1,x2,y2)] */
const STEERED_XY: Int8Array = (() => {
  const out = new Int8Array(N_BINS * N_PAIRS * 4);
  for (let b = 0; b < N_BINS; b++) {
    const th = (b * 2 * Math.PI) / N_BINS;
    const c = Math.cos(th);
    const s = Math.sin(th);
    for (let k = 0; k < N_PAIRS; k++) {
      const p = k * 4;
      const o = b * N_PAIRS * 4 + p;
      for (let j = 0; j < 2; j++) {
        const x = PATTERN[p + j * 2];
        const y = PATTERN[p + j * 2 + 1];
        out[o + j * 2] = Math.round(x * c - y * s);
        out[o + j * 2 + 1] = Math.round(x * s + y * c);
      }
    }
  }
  return out;
})();

/** stride별 선형 오프셋 캐시: [bin*512 + pair*2 + j] */
const offsetCache = new Map<number, Int32Array>();

function steeredOffsets(stride: number): Int32Array {
  let o = offsetCache.get(stride);
  if (o) return o;
  o = new Int32Array(N_BINS * N_PAIRS * 2);
  for (let b = 0; b < N_BINS; b++) {
    for (let k = 0; k < N_PAIRS; k++) {
      const src = b * N_PAIRS * 4 + k * 4;
      const dst = b * N_PAIRS * 2 + k * 2;
      o[dst] = STEERED_XY[src + 1] * stride + STEERED_XY[src];
      o[dst + 1] = STEERED_XY[src + 3] * stride + STEERED_XY[src + 2];
    }
  }
  if (offsetCache.size > 32) offsetCache.clear();
  offsetCache.set(stride, o);
  return o;
}

/** 원형 패치의 행별 반폭 */
const UMAX: Int32Array = (() => {
  const r = PATCH_RADIUS;
  const u = new Int32Array(r + 1);
  for (let v = 0; v <= r; v++) u[v] = Math.floor(Math.sqrt(r * r - v * v) + 0.5);
  // 대칭 보정 (u[v]가 v에 대해 대칭인 원이 되도록)
  for (let v = r, v0 = 0; v >= Math.floor(r * Math.SQRT1_2 + 1); v--) {
    while (u[v0] === u[v0 + 1]) v0++;
    u[v] = v0;
    v0++;
  }
  return u;
})();

/** 강도 중심 방향 (라디안, atan2(m01, m10)). 호출측이 경계를 보장 */
export function icAngle(d: Pixels, w: number, x: number, y: number): number {
  const r = PATCH_RADIUS;
  const c = y * w + x;
  let m01 = 0;
  let m10 = 0;
  for (let u = -r; u <= r; u++) m10 += u * d[c + u];
  for (let v = 1; v <= r; v++) {
    let vsum = 0;
    const um = UMAX[v];
    const up = c + v * w;
    const dn = c - v * w;
    for (let u = -um; u <= um; u++) {
      const a = d[up + u];
      const b = d[dn + u];
      vsum += a - b;
      m10 += u * (a + b);
    }
    m01 += v * vsum;
  }
  return Math.atan2(m01, m10);
}

export function angleToBin(angle: number): number {
  return Math.round((angle * N_BINS) / (2 * Math.PI)) & (N_BINS - 1);
}

/** 회전 BRIEF: 블러된 단계 이미지에서 256비트 → desc[outOff..outOff+8) */
export function computeDescriptor(
  blurred: GrayImage,
  x: number,
  y: number,
  bin: number,
  desc: Int32Array,
  outOff: number,
): void {
  const d = blurred.data;
  const o = steeredOffsets(blurred.width);
  const c = y * blurred.width + x;
  let base = bin * N_PAIRS * 2;
  for (let w = 0; w < DESC_WORDS; w++) {
    let word = 0;
    for (let bit = 0; bit < 32; bit++, base += 2) {
      // a < b ⟺ (a − b)의 부호 비트 (분기 없음)
      word |= ((d[c + o[base]] - d[c + o[base + 1]]) >>> 31) << bit;
    }
    desc[outOff + w] = word;
  }
}

// ───────────────────────── 스케일 피라미드 ─────────────────────────

/**
 * √2 간격 피라미드. 짝수 단계는 배율 2 피라미드(LK용)를 그대로 공유하고,
 * 홀수 단계는 0단계를 1/√2로 리사이즈한 뒤 pyrDown으로 만든다.
 * 단계 l 좌표 × scaleX[l] = 0단계 좌표.
 */
export class ScalePyramid {
  readonly levels: GrayImage[] = [];
  readonly blurred: GrayImage[] = [];
  readonly scaleX = new Float64Array(16);
  readonly scaleY = new Float64Array(16);
  private odd: GrayImage[] = [];
  private blurBufs: GrayImage[] = [];
  private blurredValid: boolean[] = [];
  count = 0;

  /** 최소 변: 패치 경계를 빼고도 특징점이 들어갈 여유 */
  static readonly MIN_SIDE = 2 * ORB_BORDER + 8;

  build(base: Pyramid, nLevels: number): void {
    let n = 0;
    const w0 = base.width;
    const h0 = base.height;
    for (let l = 0; l < nLevels && l < 16; l++) {
      let img: GrayImage;
      let sx: number;
      let sy: number;
      if ((l & 1) === 0) {
        const k = l >> 1;
        if (k >= base.length) break;
        img = base.levels[k];
        sx = sy = 1 << k;
      } else if (l === 1) {
        const w1 = Math.round(w0 * Math.SQRT1_2);
        const h1 = Math.round(h0 * Math.SQRT1_2);
        if (w1 < ScalePyramid.MIN_SIDE || h1 < ScalePyramid.MIN_SIDE) break;
        this.odd[0] = ensureImage(this.odd[0], w1, h1);
        resizeBilinear(base.levels[0], this.odd[0]);
        img = this.odd[0];
        sx = w0 / w1;
        sy = h0 / h1;
      } else {
        const j = (l - 1) >> 1;
        const prev = this.odd[j - 1];
        const w = prev.width >> 1;
        const h = prev.height >> 1;
        if (w < ScalePyramid.MIN_SIDE || h < ScalePyramid.MIN_SIDE) break;
        this.odd[j] = ensureImage(this.odd[j], w, h);
        pyrDown(prev, this.odd[j]);
        img = this.odd[j];
        sx = this.scaleX[l - 2] * 2;
        sy = this.scaleY[l - 2] * 2;
      }
      if (img.width < ScalePyramid.MIN_SIDE || img.height < ScalePyramid.MIN_SIDE) break;
      this.levels[l] = img;
      this.scaleX[l] = sx;
      this.scaleY[l] = sy;
      this.blurredValid[l] = false;
      n++;
    }
    this.count = n;
  }

  /** l단계 블러 이미지 (필요할 때 한 번만 계산) */
  getBlurred(l: number): GrayImage {
    if (!this.blurredValid[l]) {
      const img = this.levels[l];
      this.blurBufs[l] = ensureImage(this.blurBufs[l], img.width, img.height);
      blur7(img, this.blurBufs[l]);
      this.blurred[l] = this.blurBufs[l];
      this.blurredValid[l] = true;
    }
    return this.blurred[l];
  }
}

// ───────────────────────── 특징점 집합 ─────────────────────────

export class OrbFeatures {
  n = 0;
  /** 0단계 좌표 */
  x = new Float32Array(0);
  y = new Float32Array(0);
  level = new Uint8Array(0);
  angle = new Float32Array(0);
  score = new Float32Array(0);
  desc = new Int32Array(0);

  constructor(capacity = 512) {
    this.reserve(capacity);
  }

  get capacity(): number {
    return this.x.length;
  }

  reserve(cap: number): void {
    if (cap <= this.x.length) return;
    const nc = Math.max(cap, this.x.length * 2, 16);
    const n = this.n;
    const x = new Float32Array(nc);
    const y = new Float32Array(nc);
    const level = new Uint8Array(nc);
    const angle = new Float32Array(nc);
    const score = new Float32Array(nc);
    const desc = new Int32Array(nc * DESC_WORDS);
    x.set(this.x.subarray(0, n));
    y.set(this.y.subarray(0, n));
    level.set(this.level.subarray(0, n));
    angle.set(this.angle.subarray(0, n));
    score.set(this.score.subarray(0, n));
    desc.set(this.desc.subarray(0, n * DESC_WORDS));
    this.x = x;
    this.y = y;
    this.level = level;
    this.angle = angle;
    this.score = score;
    this.desc = desc;
  }

  /** src의 i번째 특징을 끝에 추가 */
  pushFrom(src: OrbFeatures, i: number): void {
    if (this.n >= this.x.length) this.reserve(this.n + 1);
    const j = this.n++;
    this.x[j] = src.x[i];
    this.y[j] = src.y[i];
    this.level[j] = src.level[i];
    this.angle[j] = src.angle[i];
    this.score[j] = src.score[i];
    this.desc.set(src.desc.subarray(i * DESC_WORDS, (i + 1) * DESC_WORDS), j * DESC_WORDS);
  }
}

export interface OrbParams {
  /** 전체 목표 개수 (단계별로 1/scale 비례 배분) */
  nFeatures: number;
  /** 사용할 스케일 단계 수 (피라미드에 있는 만큼까지) */
  nLevels: number;
  fastThreshold: number;
  /** 코너가 모자라면 이 값으로 다시 검출 */
  minFastThreshold: number;
  /** 격자 셀 크기 (단계 픽셀) */
  cellSize: number;
}

export const DEFAULT_ORB_PARAMS: OrbParams = {
  nFeatures: 500,
  nLevels: 5,
  fastThreshold: 18,
  minFastThreshold: 7,
  cellSize: 24,
};

/** ORB 추출기. 내부 버퍼를 재사용하므로 인스턴스를 오래 들고 쓸 것 */
export class OrbExtractor {
  private raw = new CornerList(4096);
  private sel = new CornerList(1024);

  /**
   * region(0단계 좌표)이 있으면 키포인트를 그 안에서만 뽑는다.
   * 결과는 out 끝에 추가된다(append). 추가된 개수를 돌려준다.
   */
  extract(sp: ScalePyramid, p: OrbParams, out: OrbFeatures, region?: Rect | null): number {
    const nl = Math.min(p.nLevels, sp.count);
    if (nl <= 0) return 0;
    let wsum = 0;
    for (let l = 0; l < nl; l++) wsum += 1 / sp.scaleX[l];
    const start = out.n;
    for (let l = 0; l < nl; l++) {
      const img = sp.levels[l];
      const sx = sp.scaleX[l];
      const sy = sp.scaleY[l];
      const want = Math.round((p.nFeatures * (1 / sx)) / wsum);
      if (want <= 0) continue;
      const reg = {
        x0: ORB_BORDER,
        y0: ORB_BORDER,
        x1: img.width - ORB_BORDER,
        y1: img.height - ORB_BORDER,
      };
      if (region) {
        reg.x0 = Math.max(reg.x0, Math.floor(region.x / sx));
        reg.y0 = Math.max(reg.y0, Math.floor(region.y / sy));
        reg.x1 = Math.min(reg.x1, Math.ceil((region.x + region.width) / sx));
        reg.y1 = Math.min(reg.y1, Math.ceil((region.y + region.height) / sy));
      }
      if (reg.x1 - reg.x0 < 2 || reg.y1 - reg.y0 < 2) continue;
      let nRaw = detectFast(img, p.fastThreshold, ORB_BORDER, this.raw, reg);
      if (nRaw < want && p.minFastThreshold < p.fastThreshold) {
        nRaw = detectFast(img, p.minFastThreshold, ORB_BORDER, this.raw, reg);
      }
      if (nRaw === 0) continue;
      scoreCorners(img, this.raw, "harris", 3);
      const cs = Math.max(8, p.cellSize);
      const ncells =
        Math.ceil((reg.x1 - reg.x0) / cs) * Math.ceil((reg.y1 - reg.y0) / cs);
      const perCell = Math.max(2, Math.ceil((2 * want) / Math.max(1, ncells)));
      const nSel = gridFilter(this.raw, this.sel, reg, cs, perCell, want, 0);
      if (nSel === 0) continue;

      out.reserve(out.n + nSel);
      const blurred = sp.getBlurred(l);
      const w = img.width;
      for (let k = 0; k < nSel; k++) {
        const x = this.sel.x[k];
        const y = this.sel.y[k];
        const ang = icAngle(img.data, w, x, y);
        const j = out.n++;
        out.x[j] = x * sx;
        out.y[j] = y * sy;
        out.level[j] = l;
        out.angle[j] = ang;
        out.score[j] = this.sel.score[k];
        computeDescriptor(blurred, x, y, angleToBin(ang), out.desc, j * DESC_WORDS);
      }
    }
    return out.n - start;
  }
}
