import type { GrayImage } from "../types";

// FAST-9 코너 (Rosten & Drummond 2006) + 3×3 비최대 억제
// + Harris / Shi–Tomasi 점수 + 격자 분산(버킷) + 최소 거리 필터.

/** 코너 목록 (구조-배열). 용량은 필요할 때 늘어난다 */
export class CornerList {
  n = 0;
  x: Int32Array;
  y: Int32Array;
  score: Float32Array;

  constructor(capacity = 1024) {
    this.x = new Int32Array(capacity);
    this.y = new Int32Array(capacity);
    this.score = new Float32Array(capacity);
  }

  get capacity(): number {
    return this.x.length;
  }

  reserve(cap: number): void {
    if (cap <= this.x.length) return;
    const nc = Math.max(cap, this.x.length * 2);
    const x = new Int32Array(nc);
    const y = new Int32Array(nc);
    const s = new Float32Array(nc);
    x.set(this.x.subarray(0, this.n));
    y.set(this.y.subarray(0, this.n));
    s.set(this.score.subarray(0, this.n));
    this.x = x;
    this.y = y;
    this.score = s;
  }

  push(x: number, y: number, score: number): void {
    if (this.n >= this.x.length) this.reserve(this.n + 1);
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.score[this.n] = score;
    this.n++;
  }
}

let scoreMap = new Int32Array(0);
let candIdx = new Int32Array(0);

/** 원형 16비트 마스크에 연속 9개 이상 1이 있는지 */
function hasArc9(m: number): boolean {
  const d = (m | (m << 16)) >>> 0;
  let r = d & (d >>> 1);
  r &= r >>> 2;
  r &= r >>> 4;
  r &= d >>> 8;
  return r !== 0;
}

function pos(v: number): number {
  return v > 0 ? v : 0;
}

export interface Region {
  x0: number;
  y0: number;
  x1: number; // 미포함
  y1: number; // 미포함
}

/**
 * FAST-9 검출. 결과는 out에 추가(append)가 아니라 덮어쓴다.
 * 점수는 SAD형 (원 위 밝은/어두운 쪽 초과량 합의 최댓값) — NMS용.
 * border ≥ 3. region이 있으면 그 안(단계 좌표)만 본다.
 */
export function detectFast(
  img: GrayImage,
  threshold: number,
  border: number,
  out: CornerList,
  region?: Region | null,
  nonmax = true,
): number {
  const w = img.width;
  const h = img.height;
  const b = Math.max(3, border | 0);
  let x0 = b;
  let y0 = b;
  let x1 = w - b;
  let y1 = h - b;
  if (region) {
    x0 = Math.max(x0, Math.floor(region.x0));
    y0 = Math.max(y0, Math.floor(region.y0));
    x1 = Math.min(x1, Math.ceil(region.x1));
    y1 = Math.min(y1, Math.ceil(region.y1));
  }
  out.n = 0;
  if (x1 <= x0 || y1 <= y0) return 0;
  const n = w * h;
  if (scoreMap.length < n) scoreMap = new Int32Array(n);
  // 후보 수는 영역 픽셀 수를 넘지 않는다 → 커널 안에서 크기 검사 불필요
  const area = (x1 - x0) * (y1 - y0);
  if (candIdx.length < area) candIdx = new Int32Array(Math.max(area, 4096));
  const nc = fastScanKernel(img.data, w, x0, y0, x1, y1, threshold | 0, scoreMap, candIdx);
  out.reserve(nc);
  const kept = fastNmsKernel(scoreMap, candIdx, nc, w, nonmax, out.x, out.y, out.score);
  out.n = kept;
  return kept;
}

/** FAST 스캔 커널: 코너 후보 인덱스를 cand에, 점수+1을 sm에 쓴다 */
function fastScanKernel(
  d: Uint8Array | Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t: number,
  sm: Int32Array,
  cand: Int32Array,
): number {
  // 원 16점 선형 오프셋 (시계 방향, 12시부터)
  const o0 = -3 * w;
  const o1 = -3 * w + 1;
  const o2 = -2 * w + 2;
  const o3 = -w + 3;
  const o4 = 3;
  const o5 = w + 3;
  const o6 = 2 * w + 2;
  const o7 = 3 * w + 1;
  const o8 = 3 * w;
  const o9 = 3 * w - 1;
  const o10 = 2 * w - 2;
  const o11 = w - 3;
  const o12 = -3;
  const o13 = -w - 3;
  const o14 = -2 * w - 2;
  const o15 = -3 * w - 1;
  let nc = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0, i = y * w + x0; x < x1; x++, i++) {
      const c = d[i];
      const hi = c + t;
      const lo = c - t;
      const p0 = d[i + o0];
      const p8 = d[i + o8];
      // 호 9개는 반드시 0·8 중 하나, 4·12 중 하나를 포함한다
      let bright = p0 > hi || p8 > hi ? 1 : 0;
      let dark = p0 < lo || p8 < lo ? 1 : 0;
      if ((bright | dark) === 0) continue;
      const p4 = d[i + o4];
      const p12 = d[i + o12];
      if (bright && !(p4 > hi || p12 > hi)) bright = 0;
      if (dark && !(p4 < lo || p12 < lo)) dark = 0;
      if ((bright | dark) === 0) continue;
      const v1 = d[i + o1];
      const v2 = d[i + o2];
      const v3 = d[i + o3];
      const v5 = d[i + o5];
      const v6 = d[i + o6];
      const v7 = d[i + o7];
      const v9 = d[i + o9];
      const v10 = d[i + o10];
      const v11 = d[i + o11];
      const v13 = d[i + o13];
      const v14 = d[i + o14];
      const v15 = d[i + o15];
      let s = 0;
      if (bright) {
        // (hi − v) >>> 31 = v > hi (분기 없는 비트 마스크)
        const m =
          ((hi - p0) >>> 31) |
          (((hi - v1) >>> 31) << 1) |
          (((hi - v2) >>> 31) << 2) |
          (((hi - v3) >>> 31) << 3) |
          (((hi - p4) >>> 31) << 4) |
          (((hi - v5) >>> 31) << 5) |
          (((hi - v6) >>> 31) << 6) |
          (((hi - v7) >>> 31) << 7) |
          (((hi - p8) >>> 31) << 8) |
          (((hi - v9) >>> 31) << 9) |
          (((hi - v10) >>> 31) << 10) |
          (((hi - v11) >>> 31) << 11) |
          (((hi - p12) >>> 31) << 12) |
          (((hi - v13) >>> 31) << 13) |
          (((hi - v14) >>> 31) << 14) |
          (((hi - v15) >>> 31) << 15);
        if (hasArc9(m)) {
          s =
            pos(p0 - hi) + pos(v1 - hi) + pos(v2 - hi) + pos(v3 - hi) +
            pos(p4 - hi) + pos(v5 - hi) + pos(v6 - hi) + pos(v7 - hi) +
            pos(p8 - hi) + pos(v9 - hi) + pos(v10 - hi) + pos(v11 - hi) +
            pos(p12 - hi) + pos(v13 - hi) + pos(v14 - hi) + pos(v15 - hi);
        }
      }
      if (dark) {
        const m =
          ((p0 - lo) >>> 31) |
          (((v1 - lo) >>> 31) << 1) |
          (((v2 - lo) >>> 31) << 2) |
          (((v3 - lo) >>> 31) << 3) |
          (((p4 - lo) >>> 31) << 4) |
          (((v5 - lo) >>> 31) << 5) |
          (((v6 - lo) >>> 31) << 6) |
          (((v7 - lo) >>> 31) << 7) |
          (((p8 - lo) >>> 31) << 8) |
          (((v9 - lo) >>> 31) << 9) |
          (((v10 - lo) >>> 31) << 10) |
          (((v11 - lo) >>> 31) << 11) |
          (((p12 - lo) >>> 31) << 12) |
          (((v13 - lo) >>> 31) << 13) |
          (((v14 - lo) >>> 31) << 14) |
          (((v15 - lo) >>> 31) << 15);
        if (hasArc9(m)) {
          const sd =
            pos(lo - p0) + pos(lo - v1) + pos(lo - v2) + pos(lo - v3) +
            pos(lo - p4) + pos(lo - v5) + pos(lo - v6) + pos(lo - v7) +
            pos(lo - p8) + pos(lo - v9) + pos(lo - v10) + pos(lo - v11) +
            pos(lo - p12) + pos(lo - v13) + pos(lo - v14) + pos(lo - v15);
          if (sd > s) s = sd;
        }
      }
      if (s === 0) continue; // 코너면 초과량 합은 항상 9 이상
      cand[nc++] = i;
      sm[i] = s + 1;
    }
  }
  return nc;
}

/**
 * 3×3 비최대 억제 커널. 앞쪽(인덱스 작은) 이웃보다는 커야, 뒤쪽 이웃보다는 크거나 같아야 산다
 * → 결정적 타이브레이크. 끝나면 점수 맵을 0으로 되돌린다.
 */
function fastNmsKernel(
  sm: Int32Array,
  cand: Int32Array,
  nc: number,
  w: number,
  nonmax: boolean,
  ox: Int32Array,
  oy: Int32Array,
  os: Float32Array,
): number {
  let n = 0;
  for (let k = 0; k < nc; k++) {
    const i = cand[k];
    const s = sm[i];
    if (
      nonmax &&
      (sm[i - w - 1] >= s ||
        sm[i - w] >= s ||
        sm[i - w + 1] >= s ||
        sm[i - 1] >= s ||
        sm[i + 1] > s ||
        sm[i + w - 1] > s ||
        sm[i + w] > s ||
        sm[i + w + 1] > s)
    ) {
      continue;
    }
    ox[n] = i % w;
    oy[n] = (i / w) | 0;
    os[n] = s;
    n++;
  }
  for (let k = 0; k < nc; k++) sm[cand[k]] = 0;
  return n;
}

/**
 * 코너 점수 재계산: 블록(2r+1)² 안의 Sobel 그래디언트 구조 텐서.
 * kind 'harris' → det − k·tr², 'mineig' → 최소 고유값 (Shi–Tomasi).
 * 점수 단위: 픽셀당 (그레이/px)². 가장자리에서 r+2 안쪽이어야 한다.
 */
export function scoreCorners(
  img: GrayImage,
  list: CornerList,
  kind: "harris" | "mineig",
  radius = 3,
  k = 0.04,
): void {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const r = radius;
  const norm = 1 / (64 * (2 * r + 1) * (2 * r + 1));
  for (let c = 0; c < list.n; c++) {
    const cx = list.x[c];
    const cy = list.y[c];
    if (cx < r + 1 || cy < r + 1 || cx >= w - r - 1 || cy >= h - r - 1) {
      list.score[c] = 0;
      continue;
    }
    let a = 0;
    let b = 0;
    let cc = 0;
    for (let dy = -r; dy <= r; dy++) {
      let i = (cy + dy) * w + cx - r;
      for (let dx = -r; dx <= r; dx++, i++) {
        const gx =
          d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1];
        const gy =
          d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1];
        a += gx * gx;
        b += gx * gy;
        cc += gy * gy;
      }
    }
    a *= norm;
    b *= norm;
    cc *= norm;
    if (kind === "harris") {
      const tr = a + cc;
      list.score[c] = a * cc - b * b - k * tr * tr;
    } else {
      const half = (a - cc) * 0.5;
      list.score[c] = (a + cc) * 0.5 - Math.sqrt(half * half + b * b);
    }
  }
}

let sortIdx = new Uint32Array(0);
let cellCount = new Uint16Array(0);
let sortKeys = new Float64Array(0);
const f32 = new Float32Array(1);
const f32bits = new Int32Array(f32.buffer);

/**
 * 점수 내림차순 인덱스 (동점이면 원래 순서) — 결정적.
 * 비교 함수 정렬 대신 (점수 비트, 인덱스)를 한 Float64 키로 묶어 네이티브 숫자 정렬.
 */
export function sortByScore(list: CornerList): Uint32Array {
  const n = list.n;
  if (sortIdx.length < n) {
    sortIdx = new Uint32Array(Math.max(n, 1024));
    sortKeys = new Float64Array(Math.max(n, 1024));
  }
  const idx = sortIdx.subarray(0, n);
  const s = list.score;
  if (n > 65536) {
    for (let i = 0; i < n; i++) idx[i] = i;
    idx.sort((a, b) => s[b] - s[a] || a - b);
    return idx;
  }
  const keys = sortKeys.subarray(0, n);
  for (let i = 0; i < n; i++) {
    // float32 비트 패턴은 양수에서 값과 단조 → 음수·0은 맨 뒤로
    f32[0] = s[i];
    const b = s[i] > 0 ? f32bits[0] : 0;
    keys[i] = (0x7fffffff - b) * 65536 + i;
  }
  keys.sort();
  for (let i = 0; i < n; i++) idx[i] = keys[i] % 65536;
  return idx;
}

/**
 * 격자 버킷: 셀마다 최대 perCell개, 전체 maxN개. 점수 높은 순. out에 결과.
 * minScore 이하는 버린다.
 */
export function gridFilter(
  list: CornerList,
  out: CornerList,
  region: Region,
  cellSize: number,
  perCell: number,
  maxN: number,
  minScore = -Infinity,
): number {
  const idx = sortByScore(list);
  const cw = Math.max(1, cellSize);
  const ncx = Math.max(1, Math.ceil((region.x1 - region.x0) / cw));
  const ncy = Math.max(1, Math.ceil((region.y1 - region.y0) / cw));
  if (cellCount.length < ncx * ncy) cellCount = new Uint16Array(ncx * ncy);
  cellCount.fill(0, 0, ncx * ncy);
  out.reserve(Math.min(maxN, list.n));
  let n = 0;
  for (let k = 0; k < idx.length && n < maxN; k++) {
    const i = idx[k];
    const s = list.score[i];
    if (!(s > minScore)) break;
    const x = list.x[i];
    const y = list.y[i];
    let cx = Math.floor((x - region.x0) / cw);
    let cy = Math.floor((y - region.y0) / cw);
    if (cx < 0) cx = 0;
    else if (cx >= ncx) cx = ncx - 1;
    if (cy < 0) cy = 0;
    else if (cy >= ncy) cy = ncy - 1;
    const cell = cy * ncx + cx;
    if (cellCount[cell] >= perCell) continue;
    cellCount[cell]++;
    out.x[n] = x;
    out.y[n] = y;
    out.score[n] = s;
    n++;
  }
  out.n = n;
  return n;
}

let occ = new Int32Array(0);

/**
 * 최소 거리 필터 (goodFeaturesToTrack 방식): 점수 높은 순으로 받아들이되
 * 이미 받은 점과 minDist 미만이면 버린다. out에 결과.
 */
export function minDistanceFilter(
  list: CornerList,
  out: CornerList,
  width: number,
  height: number,
  minDist: number,
  maxN: number,
  minScore = -Infinity,
): number {
  const idx = sortByScore(list);
  // 셀 대각선 < minDist → 한 셀에 점 하나만 들어간다. 이웃 ±2셀 검사
  const cs = Math.max(0.5, minDist / Math.SQRT2);
  const gw = Math.ceil(width / cs) + 1;
  const gh = Math.ceil(height / cs) + 1;
  if (occ.length < gw * gh) occ = new Int32Array(gw * gh);
  occ.fill(-1, 0, gw * gh);
  const md2 = minDist * minDist;
  out.reserve(Math.min(maxN, list.n));
  let n = 0;
  for (let k = 0; k < idx.length && n < maxN; k++) {
    const i = idx[k];
    const s = list.score[i];
    if (!(s > minScore)) break;
    const x = list.x[i];
    const y = list.y[i];
    const gx = Math.floor(x / cs);
    const gy = Math.floor(y / cs);
    let ok = true;
    for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2) && ok; yy++) {
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
        const j = occ[yy * gw + xx];
        if (j >= 0) {
          const ddx = out.x[j] - x;
          const ddy = out.y[j] - y;
          if (ddx * ddx + ddy * ddy < md2) {
            ok = false;
            break;
          }
        }
      }
    }
    if (!ok) continue;
    occ[gy * gw + gx] = n;
    out.x[n] = x;
    out.y[n] = y;
    out.score[n] = s;
    n++;
  }
  out.n = n;
  return n;
}
