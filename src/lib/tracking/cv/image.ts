import type { GrayImage, Mat3 } from "../types";
import { invert3 } from "../geometry";

// 그레이 이미지 기본 연산: 피라미드·블러·리사이즈·쌍선형 보간·원근 워프.
// 좌표 규약: 픽셀 (i, j)의 값은 좌표 (i, j)에 있다(픽셀 중심 = 정수 좌표).
// pyrDown은 dst(i) ↔ src(2i) (OpenCV와 동일) → 단계 l 좌표 = 0단계 좌표 / 2^l.

export type Pixels = Uint8Array | Uint8ClampedArray;

export function createImage(width: number, height: number): GrayImage {
  return { width, height, data: new Uint8Array(width * height) };
}

/** 크기가 같으면 그대로 재사용, 다르면 새로 할당 */
export function ensureImage(
  img: GrayImage | null | undefined,
  width: number,
  height: number,
): GrayImage {
  if (
    img &&
    img.width === width &&
    img.height === height &&
    img.data.length === width * height
  ) {
    return img;
  }
  return createImage(width, height);
}

export function copyImage(src: GrayImage, dst?: GrayImage | null): GrayImage {
  const out = ensureImage(dst, src.width, src.height);
  out.data.set(src.data.subarray(0, src.width * src.height));
  return out;
}

export function isValidImage(img: GrayImage | null | undefined): img is GrayImage {
  return (
    !!img &&
    Number.isInteger(img.width) &&
    Number.isInteger(img.height) &&
    img.width >= 16 &&
    img.height >= 16 &&
    !!img.data &&
    img.data.length >= img.width * img.height
  );
}

// ───────────── 스크래치 버퍼 (호출 1회 안에서만 쓰고 넘기지 않는다) ─────────────

let scratchU16 = new Uint16Array(0);
function getScratchU16(n: number): Uint16Array {
  if (scratchU16.length < n) scratchU16 = new Uint16Array(n);
  return scratchU16;
}

/** reflect-101 경계 (-1 → 1, n → n-2) */
function refl(i: number, n: number): number {
  if (i < 0) return -i < n ? -i : 0;
  if (i >= n) {
    const r = 2 * n - 2 - i;
    return r >= 0 ? r : n - 1;
  }
  return i;
}

/**
 * [1 4 6 4 1]/16 가우시안 후 1/2 다운샘플.
 * dst는 floor(w/2) × floor(h/2)여야 한다.
 */
export function pyrDown(src: GrayImage, dst: GrayImage): void {
  const sw = src.width;
  const sh = src.height;
  const dw = dst.width;
  const dh = dst.height;
  if (dw !== sw >> 1 || dh !== sh >> 1) throw new Error("pyrDown: 크기 불일치");
  const t = getScratchU16(dw * sh);
  pyrDownH(src.data, t, sw, sh, dw);
  pyrDownV(t, dst.data, dw, dh, sh);
}

/** 가로: 모든 행, 짝수 열만 */
function pyrDownH(s: Pixels, t: Uint16Array, sw: number, sh: number, dw: number): void {
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    const trow = y * dw;
    t[trow] = hEdge(s, row, 0, sw);
    let x = 1;
    for (; x < dw && 2 * x + 2 < sw; x++) {
      const i = row + 2 * x;
      t[trow + x] = s[i - 2] + 4 * s[i - 1] + 6 * s[i] + 4 * s[i + 1] + s[i + 2];
    }
    for (; x < dw; x++) t[trow + x] = hEdge(s, row, 2 * x, sw);
  }
}

/** 세로: 짝수 행만 */
function pyrDownV(t: Uint16Array, d: Pixels, dw: number, dh: number, sh: number): void {
  for (let y = 0; y < dh; y++) {
    const cy = 2 * y;
    const r0 = refl(cy - 2, sh) * dw;
    const r1 = refl(cy - 1, sh) * dw;
    const r2 = cy * dw;
    const r3 = refl(cy + 1, sh) * dw;
    const r4 = refl(cy + 2, sh) * dw;
    const drow = y * dw;
    for (let x = 0; x < dw; x++) {
      d[drow + x] = (t[r0 + x] + 4 * t[r1 + x] + 6 * t[r2 + x] + 4 * t[r3 + x] + t[r4 + x] + 128) >> 8;
    }
  }
}

function hEdge(s: Pixels, row: number, cx: number, sw: number): number {
  return (
    s[row + refl(cx - 2, sw)] +
    4 * s[row + refl(cx - 1, sw)] +
    6 * s[row + cx] +
    4 * s[row + refl(cx + 1, sw)] +
    s[row + refl(cx + 2, sw)]
  );
}

/**
 * 7탭 이항 블러 [1 6 15 20 15 6 1]/64 (σ≈1.22). BRIEF 비교 전 잡음 억제용.
 * dst는 src와 같은 크기.
 */
export function blur7(src: GrayImage, dst: GrayImage): void {
  const w = src.width;
  const h = src.height;
  if (dst.width !== w || dst.height !== h) throw new Error("blur7: 크기 불일치");
  if (w < 8 || h < 8) {
    dst.data.set(src.data.subarray(0, w * h));
    return;
  }
  const t = getScratchU16(w * h);
  blur7H(src.data, t, w, h);
  blur7V(t, dst.data, w, h);
}

/** 가로 (중간값 ≤ 64·255 → Uint16) */
function blur7H(s: Pixels, t: Uint16Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < 3; x++) t[row + x] = h7Edge(s, row, x, w);
    for (let x = 3, i = row + 3; x < w - 3; x++, i++) {
      t[i] = s[i - 3] + s[i + 3] + 6 * (s[i - 2] + s[i + 2]) + 15 * (s[i - 1] + s[i + 1]) + 20 * s[i];
    }
    for (let x = w - 3; x < w; x++) t[row + x] = h7Edge(s, row, x, w);
  }
}

function blur7V(t: Uint16Array, d: Pixels, w: number, h: number): void {
  const w2 = 2 * w;
  const w3 = 3 * w;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (y >= 3 && y < h - 3) {
      for (let x = 0, i = row; x < w; x++, i++) {
        d[i] =
          (t[i - w3] + t[i + w3] + 6 * (t[i - w2] + t[i + w2]) + 15 * (t[i - w] + t[i + w]) + 20 * t[i] + 2048) >>
          12;
      }
    } else {
      const r0 = refl(y - 3, h) * w;
      const r1 = refl(y - 2, h) * w;
      const r2 = refl(y - 1, h) * w;
      const r4 = refl(y + 1, h) * w;
      const r5 = refl(y + 2, h) * w;
      const r6 = refl(y + 3, h) * w;
      for (let x = 0; x < w; x++) {
        d[row + x] =
          (t[r0 + x] +
            t[r6 + x] +
            6 * (t[r1 + x] + t[r5 + x]) +
            15 * (t[r2 + x] + t[r4 + x]) +
            20 * t[row + x] +
            2048) >>
          12;
      }
    }
  }
}

function h7Edge(s: Pixels, row: number, x: number, w: number): number {
  return (
    s[row + refl(x - 3, w)] +
    s[row + refl(x + 3, w)] +
    6 * (s[row + refl(x - 2, w)] + s[row + refl(x + 2, w)]) +
    15 * (s[row + refl(x - 1, w)] + s[row + refl(x + 1, w)]) +
    20 * s[row + x]
  );
}

let rsX0 = new Int32Array(0);
let rsWX = new Uint16Array(0);

/**
 * 쌍선형 축소/확대. 좌표 규약: src_x = dst_x * (sw/dw) (원점 정렬, pyrDown과 같은 계열).
 */
export function resizeBilinear(src: GrayImage, dst: GrayImage): void {
  const sw = src.width;
  const sh = src.height;
  const dw = dst.width;
  const dh = dst.height;
  const rx = sw / dw;
  const ry = sh / dh;
  if (rsX0.length < dw) {
    rsX0 = new Int32Array(dw);
    rsWX = new Uint16Array(dw);
  }
  for (let x = 0; x < dw; x++) {
    const fx = x * rx;
    let ix = Math.floor(fx);
    let wx = Math.round((fx - ix) * 256);
    if (ix >= sw - 1) {
      ix = sw - 2;
      wx = 256;
    }
    rsX0[x] = ix;
    rsWX[x] = wx;
  }
  const s = src.data;
  const d = dst.data;
  for (let y = 0; y < dh; y++) {
    const fy = y * ry;
    let iy = Math.floor(fy);
    let wy = Math.round((fy - iy) * 256);
    if (iy >= sh - 1) {
      iy = sh - 2;
      wy = 256;
    }
    const r0 = iy * sw;
    const r1 = r0 + sw;
    const drow = y * dw;
    const wy0 = 256 - wy;
    for (let x = 0; x < dw; x++) {
      const ix = rsX0[x];
      const wx = rsWX[x];
      const wx0 = 256 - wx;
      const top = s[r0 + ix] * wx0 + s[r0 + ix + 1] * wx;
      const bot = s[r1 + ix] * wx0 + s[r1 + ix + 1] * wx;
      d[drow + x] = (top * wy0 + bot * wy + 32768) >> 16;
    }
  }
}

/**
 * 쌍선형 보간. 호출측이 0 ≤ x < w-1, 0 ≤ y < h-1을 보장해야 한다.
 */
export function bilinear(data: Pixels, w: number, x: number, y: number): number {
  const ix = x | 0;
  const iy = y | 0;
  const fx = x - ix;
  const fy = y - iy;
  const i = iy * w + ix;
  const a = data[i];
  const b = data[i + 1];
  const c = data[i + w];
  const d = data[i + w + 1];
  return a + fx * (b - a) + fy * (c - a + fx * (a - b - c + d));
}

/** 경계 밖이면 NaN을 돌려주는 안전한 보간 (가장자리 1px 포함) */
export function sampleSafe(img: GrayImage, x: number, y: number): number {
  const w = img.width;
  const h = img.height;
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return NaN;
  const cx = x >= w - 1 ? w - 1.000001 : x;
  const cy = y >= h - 1 ? h - 1.000001 : y;
  return bilinear(img.data, w, cx, cy);
}

/**
 * 원근 워프: dst(x) = src(H⁻¹ x). H는 src → dst.
 * 원본 밖은 fill. 테스트 합성과 initialH 가상 이전 프레임 생성에 쓴다.
 */
export function warpPerspective(
  src: GrayImage,
  H: Mat3,
  dst: GrayImage,
  fill = 0,
): void {
  const inv = invert3(H);
  const d = dst.data;
  if (!inv) {
    d.fill(fill);
    return;
  }
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const dw = dst.width;
  const dh = dst.height;
  const xmax = sw - 1;
  const ymax = sh - 1;
  for (let y = 0; y < dh; y++) {
    let X = inv[1] * y + inv[2];
    let Y = inv[4] * y + inv[5];
    let W = inv[7] * y + inv[8];
    const row = y * dw;
    for (let x = 0; x < dw; x++) {
      if (W > 1e-12) {
        const sx = X / W;
        const sy = Y / W;
        if (sx >= 0 && sy >= 0 && sx <= xmax && sy <= ymax) {
          const cx = sx >= xmax ? xmax - 1e-6 : sx;
          const cy = sy >= ymax ? ymax - 1e-6 : sy;
          d[row + x] = (bilinear(s, sw, cx, cy) + 0.5) | 0;
        } else {
          d[row + x] = fill;
        }
      } else {
        d[row + x] = fill;
      }
      X += inv[0];
      Y += inv[3];
      W += inv[6];
    }
  }
}

/**
 * 가우시안 피라미드 (배율 2). levels[0]은 입력의 복사본이다
 * (호출측이 프레임 버퍼를 재사용해도 이전 프레임이 보존되도록).
 */
export class Pyramid {
  readonly levels: GrayImage[] = [];
  private count = 0;

  get length(): number {
    return this.count;
  }

  get width(): number {
    return this.count > 0 ? this.levels[0].width : 0;
  }

  get height(): number {
    return this.count > 0 ? this.levels[0].height : 0;
  }

  level(i: number): GrayImage {
    return this.levels[i];
  }

  /** 최소 변 길이 minSide 이상인 단계까지만 만든다 */
  build(src: GrayImage, nLevels: number, minSide = 12): void {
    const w = src.width;
    const h = src.height;
    this.levels[0] = ensureImage(this.levels[0], w, h);
    this.levels[0].data.set(src.data.subarray(0, w * h));
    let n = 1;
    for (let l = 1; l < nLevels; l++) {
      const prev = this.levels[l - 1];
      const lw = prev.width >> 1;
      const lh = prev.height >> 1;
      if (lw < minSide || lh < minSide) break;
      this.levels[l] = ensureImage(this.levels[l], lw, lh);
      pyrDown(prev, this.levels[l]);
      n++;
    }
    this.count = n;
  }

  /** 다른 피라미드 내용을 복사 */
  copyFrom(other: Pyramid): void {
    for (let l = 0; l < other.count; l++) {
      this.levels[l] = copyImage(other.levels[l], this.levels[l]);
    }
    this.count = other.count;
  }
}
