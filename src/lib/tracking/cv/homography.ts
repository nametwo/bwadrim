import type { Mat3, Point, Rect } from "../types";
import { applyH, invert3, isConvex, mul3, rectCorners } from "../geometry";
import type { Rng } from "./rng";

// 호모그래피 추정: 정규화 DLT(4점 정확해 + 최소제곱), 시드 고정 RANSAC(MSAC 점수·적응 반복·국소 최적화),
// Levenberg–Marquardt 재투영 오차 정제, 형상 타당성 검사.
// 점 대응은 Float64Array 네 개(srcX, srcY, dstX, dstY)로 넘긴다 (V8 단형성 유지).

// ───────────────────────── 선형대수 ─────────────────────────

/**
 * 첨가행렬 M (n × (n+1), 행 우선)을 부분 피벗 가우스 소거로 풀어 x에 쓴다. M은 파괴된다.
 */
export function solveAugmented(M: Float64Array, n: number, x: Float64Array): boolean {
  const m = n + 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col * m + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * m + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (!(best > 1e-12)) return false;
    if (piv !== col) {
      for (let c = col; c < m; c++) {
        const t = M[col * m + c];
        M[col * m + c] = M[piv * m + c];
        M[piv * m + c] = t;
      }
    }
    const inv = 1 / M[col * m + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * m + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < m; c++) M[r * m + c] -= f * M[col * m + c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r * m + n];
    for (let c = r + 1; c < n; c++) s -= M[r * m + c] * x[c];
    x[r] = s / M[r * m + r];
    if (!Number.isFinite(x[r])) return false;
  }
  return true;
}

/**
 * 대칭 양정치 A x = b (Cholesky). A(n×n)는 보존, L 버퍼는 내부에서 쓴다.
 */
const cholL = new Float64Array(16 * 16);
export function solveSPD(A: Float64Array, b: Float64Array, n: number, x: Float64Array): boolean {
  const L = cholL;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 1e-300)) return false;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  // L y = b
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k];
    x[i] = s / L[i * n + i];
  }
  // Lᵀ x = y
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

/**
 * 대칭 행렬 고유분해 (순환 야코비). A는 파괴되고 대각에 고유값이 남는다.
 * V의 열 = 고유벡터. d = 고유값.
 */
export function jacobiEigen(
  A: Float64Array,
  n: number,
  V: Float64Array,
  d: Float64Array,
  maxSweeps = 60,
): void {
  V.fill(0, 0, n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale += A[i] * A[i];
  const tol = scale * 1e-30 + 1e-300;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off <= tol) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p];
          const akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k];
          const aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p];
          const vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) d[i] = A[i * n + i];
}

// ───────────────────────── 정규화 ─────────────────────────

/** Hartley 정규화: p' = s·(p − c), 평균 거리 √2 */
export interface NormXf {
  s: number;
  cx: number;
  cy: number;
}

function computeNorm(
  xs: Float64Array,
  ys: Float64Array,
  n: number,
  mask: Uint8Array | null,
  out: NormXf,
): boolean {
  let cx = 0;
  let cy = 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    cx += xs[i];
    cy += ys[i];
    m++;
  }
  if (m === 0) return false;
  cx /= m;
  cy /= m;
  let md = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    md += Math.hypot(xs[i] - cx, ys[i] - cy);
  }
  md /= m;
  if (!(md > 1e-9)) return false;
  out.s = Math.SQRT2 / md;
  out.cx = cx;
  out.cy = cy;
  return true;
}

function normMat(t: NormXf): Mat3 {
  return [t.s, 0, -t.s * t.cx, 0, t.s, -t.s * t.cy, 0, 0, 1];
}

function normMatInv(t: NormXf): Mat3 {
  return [1 / t.s, 0, t.cx, 0, 1 / t.s, t.cy, 0, 0, 1];
}

/** 스케일 정규화: H[8] = 1 (가능하면), 아니면 프로베니우스 노름 1. 대표점 w > 0 이 되게 부호 조정 */
export function canonicalizeH(H: Mat3, px = 0, py = 0): Mat3 {
  let s = H[8];
  if (Math.abs(s) < 1e-10) {
    let nrm = 0;
    for (let i = 0; i < 9; i++) nrm += H[i] * H[i];
    s = Math.sqrt(nrm);
  }
  const out = H.map((v) => v / s);
  const w = out[6] * px + out[7] * py + out[8];
  if (w < 0) for (let i = 0; i < 9; i++) out[i] = -out[i];
  return out;
}

export function isFiniteH(H: Mat3 | null | undefined): H is Mat3 {
  if (!H || H.length !== 9) return false;
  for (let i = 0; i < 9; i++) if (!Number.isFinite(H[i])) return false;
  return true;
}

// ───────────────────────── 최소해 (4점) ─────────────────────────

const M89 = new Float64Array(8 * 9);
const X8 = new Float64Array(8);

/**
 * 4점 정확해 (h33 = 1). 좌표는 이미 정규화돼 있다고 가정 (원점 근처, 크기 ~1).
 * out[0..8]에 쓴다.
 */
function solve4(
  x: Float64Array,
  y: Float64Array,
  u: Float64Array,
  v: Float64Array,
  i0: number,
  i1: number,
  i2: number,
  i3: number,
  out: Float64Array,
): boolean {
  const M = M89;
  const ids = [i0, i1, i2, i3];
  for (let k = 0; k < 4; k++) {
    const i = ids[k];
    const xi = x[i];
    const yi = y[i];
    const ui = u[i];
    const vi = v[i];
    let r = k * 2 * 9;
    M[r] = xi;
    M[r + 1] = yi;
    M[r + 2] = 1;
    M[r + 3] = 0;
    M[r + 4] = 0;
    M[r + 5] = 0;
    M[r + 6] = -xi * ui;
    M[r + 7] = -yi * ui;
    M[r + 8] = ui;
    r += 9;
    M[r] = 0;
    M[r + 1] = 0;
    M[r + 2] = 0;
    M[r + 3] = xi;
    M[r + 4] = yi;
    M[r + 5] = 1;
    M[r + 6] = -xi * vi;
    M[r + 7] = -yi * vi;
    M[r + 8] = vi;
  }
  if (!solveAugmented(M, 8, X8)) return false;
  for (let k = 0; k < 8; k++) out[k] = X8[k];
  out[8] = 1;
  return true;
}

/** 두 사각형(4점) 사이 호모그래피. 퇴화면 null */
export function homographyFromQuads(src: Point[], dst: Point[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const sx = new Float64Array(4);
  const sy = new Float64Array(4);
  const dx = new Float64Array(4);
  const dy = new Float64Array(4);
  for (let i = 0; i < 4; i++) {
    sx[i] = src[i].x;
    sy[i] = src[i].y;
    dx[i] = dst[i].x;
    dy[i] = dst[i].y;
  }
  const ts: NormXf = { s: 1, cx: 0, cy: 0 };
  const td: NormXf = { s: 1, cx: 0, cy: 0 };
  if (!computeNorm(sx, sy, 4, null, ts) || !computeNorm(dx, dy, 4, null, td)) return null;
  for (let i = 0; i < 4; i++) {
    sx[i] = ts.s * (sx[i] - ts.cx);
    sy[i] = ts.s * (sy[i] - ts.cy);
    dx[i] = td.s * (dx[i] - td.cx);
    dy[i] = td.s * (dy[i] - td.cy);
  }
  // 세 점이 일직선이면 호모그래피가 정의되지 않는다 (방향 일치는 여기선 요구하지 않음)
  const tris = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ];
  for (const [a, b, c] of tris) {
    if (Math.abs(cross3(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c])) < 1e-6) return null;
    if (Math.abs(cross3(dx[a], dy[a], dx[b], dy[b], dx[c], dy[c])) < 1e-6) return null;
  }
  const h = new Float64Array(9);
  if (!solve4(sx, sy, dx, dy, 0, 1, 2, 3, h)) return null;
  const H = mul3(mul3(normMatInv(td), Array.from(h)), normMat(ts));
  return isFiniteH(H) ? canonicalizeH(H, src[0].x, src[0].y) : null;
}

// ───────────────────────── 최소제곱 DLT ─────────────────────────

const ATA = new Float64Array(81);
const EV = new Float64Array(81);
const ED = new Float64Array(9);
const ROW1 = new Float64Array(9);
const ROW2 = new Float64Array(9);

/**
 * 정규화 좌표 대응에서 대수 오차 최소 DLT: AᵀA의 최소 고유벡터.
 * mask가 있으면 mask[i]≠0만 쓴다. out[0..8].
 */
function dltNormalized(
  x: Float64Array,
  y: Float64Array,
  u: Float64Array,
  v: Float64Array,
  n: number,
  mask: Uint8Array | null,
  out: Float64Array,
): boolean {
  ATA.fill(0);
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    m++;
    const xi = x[i];
    const yi = y[i];
    const ui = u[i];
    const vi = v[i];
    ROW1[0] = -xi;
    ROW1[1] = -yi;
    ROW1[2] = -1;
    ROW1[3] = 0;
    ROW1[4] = 0;
    ROW1[5] = 0;
    ROW1[6] = ui * xi;
    ROW1[7] = ui * yi;
    ROW1[8] = ui;
    ROW2[0] = 0;
    ROW2[1] = 0;
    ROW2[2] = 0;
    ROW2[3] = -xi;
    ROW2[4] = -yi;
    ROW2[5] = -1;
    ROW2[6] = vi * xi;
    ROW2[7] = vi * yi;
    ROW2[8] = vi;
    for (let a = 0; a < 9; a++) {
      const r1 = ROW1[a];
      const r2 = ROW2[a];
      for (let b = a; b < 9; b++) ATA[a * 9 + b] += r1 * ROW1[b] + r2 * ROW2[b];
    }
  }
  if (m < 4) return false;
  for (let a = 0; a < 9; a++) for (let b = 0; b < a; b++) ATA[a * 9 + b] = ATA[b * 9 + a];
  jacobiEigen(ATA, 9, EV, ED);
  let k = 0;
  for (let i = 1; i < 9; i++) if (ED[i] < ED[k]) k = i;
  for (let i = 0; i < 9; i++) out[i] = EV[i * 9 + k];
  // 정규화 좌표 원점의 w가 양수가 되도록
  if (out[8] < 0) for (let i = 0; i < 9; i++) out[i] = -out[i];
  if (Math.abs(out[8]) > 1e-12) {
    const s = 1 / out[8];
    for (let i = 0; i < 9; i++) out[i] *= s;
  }
  for (let i = 0; i < 9; i++) if (!Number.isFinite(out[i])) return false;
  return true;
}

/**
 * 정규화 DLT (Hartley). n ≥ 4. mask가 있으면 선택된 점만. 실패하면 null.
 */
export function fitHomographyDLT(
  sx: Float64Array,
  sy: Float64Array,
  dx: Float64Array,
  dy: Float64Array,
  n: number,
  mask: Uint8Array | null = null,
): Mat3 | null {
  const ts: NormXf = { s: 1, cx: 0, cy: 0 };
  const td: NormXf = { s: 1, cx: 0, cy: 0 };
  if (!computeNorm(sx, sy, n, mask, ts) || !computeNorm(dx, dy, n, mask, td)) return null;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const nu = new Float64Array(n);
  const nv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    nx[i] = ts.s * (sx[i] - ts.cx);
    ny[i] = ts.s * (sy[i] - ts.cy);
    nu[i] = td.s * (dx[i] - td.cx);
    nv[i] = td.s * (dy[i] - td.cy);
  }
  const h = new Float64Array(9);
  if (!dltNormalized(nx, ny, nu, nv, n, mask, h)) return null;
  const H = mul3(mul3(normMatInv(td), Array.from(h)), normMat(ts));
  return canonicalizeH(H, ts.cx, ts.cy);
}

// ───────────────────────── RANSAC ─────────────────────────

export interface RansacParams {
  /** 재투영 허용 오차 (dst 픽셀) */
  threshold: number;
  maxIters: number;
  /** 적응 반복 종료 신뢰도 (예: 0.995) */
  confidence: number;
  /** 최소 반복 (적응 종료가 너무 이르지 않게) */
  minIters: number;
  /** 국소 최적화(인라이어 최소제곱 재추정) 반복 */
  loIters: number;
}

export const DEFAULT_RANSAC: RansacParams = {
  threshold: 3,
  maxIters: 1000,
  confidence: 0.995,
  minIters: 16,
  loIters: 3,
};

export interface RansacResult {
  /** src → dst (픽셀). 실패면 null */
  H: Mat3 | null;
  inliers: number;
  iterations: number;
}

/**
 * 버퍼 재사용 RANSAC. 모든 반복은 Hartley 정규화 좌표에서 돈다
 * (정규화가 닮음변환이라 dst 임계값은 s_d배만 하면 된다).
 */
export class HomographyRansac {
  private nx = new Float64Array(0);
  private ny = new Float64Array(0);
  private nu = new Float64Array(0);
  private nv = new Float64Array(0);
  private tmpMask = new Uint8Array(0);
  private hyp = new Float64Array(9);
  private best = new Float64Array(9);
  private lo = new Float64Array(9);
  private ts: NormXf = { s: 1, cx: 0, cy: 0 };
  private td: NormXf = { s: 1, cx: 0, cy: 0 };

  private ensure(n: number): void {
    if (this.nx.length >= n) return;
    const c = Math.max(n, this.nx.length * 2, 64);
    this.nx = new Float64Array(c);
    this.ny = new Float64Array(c);
    this.nu = new Float64Array(c);
    this.nv = new Float64Array(c);
    this.tmpMask = new Uint8Array(c);
  }

  /**
   * mask(길이 ≥ n)에 인라이어 표시를 쓴다.
   * hypotheses: 먼저 평가해 볼 후보(예: 예측 H, 픽셀 좌표).
   */
  run(
    sx: Float64Array,
    sy: Float64Array,
    dx: Float64Array,
    dy: Float64Array,
    n: number,
    p: RansacParams,
    rng: Rng,
    mask: Uint8Array,
    hypotheses?: (Mat3 | null)[],
  ): RansacResult {
    mask.fill(0, 0, n);
    if (n < 4) return { H: null, inliers: 0, iterations: 0 };
    this.ensure(n);
    const ts = this.ts;
    const td = this.td;
    if (!computeNorm(sx, sy, n, null, ts) || !computeNorm(dx, dy, n, null, td)) {
      return { H: null, inliers: 0, iterations: 0 };
    }
    const nx = this.nx;
    const ny = this.ny;
    const nu = this.nu;
    const nv = this.nv;
    for (let i = 0; i < n; i++) {
      nx[i] = ts.s * (sx[i] - ts.cx);
      ny[i] = ts.s * (sy[i] - ts.cy);
      nu[i] = td.s * (dx[i] - td.cx);
      nv[i] = td.s * (dy[i] - td.cy);
    }
    const t = p.threshold * td.s;
    const t2 = t * t;

    let bestCost = Infinity;
    let bestInl = 0;
    let haveBest = false;
    const best = this.best;
    const hyp = this.hyp;

    // 주어진 후보 먼저
    if (hypotheses) {
      const Tn = normMat(td);
      const Tsi = normMatInv(ts);
      for (const Hp of hypotheses) {
        if (!isFiniteH(Hp)) continue;
        const Hn = mul3(mul3(Tn, Hp), Tsi);
        const s = Math.abs(Hn[8]) > 1e-12 ? 1 / Hn[8] : 1;
        for (let k = 0; k < 9; k++) hyp[k] = Hn[k] * s;
        const c = this.cost(hyp, n, t2, bestCost);
        if (c < bestCost) {
          bestCost = c;
          best.set(hyp);
          haveBest = true;
          bestInl = this.countInliers(best, n, t2, null);
        }
      }
    }

    let iters = 0;
    let needed = p.maxIters;
    if (haveBest) needed = Math.max(p.minIters, adaptiveIters(bestInl, n, p.confidence, p.maxIters));
    let attempts = 0;
    const maxAttempts = p.maxIters * 3;
    while (iters < needed && attempts < maxAttempts) {
      attempts++;
      // 서로 다른 4개
      const i0 = rng.int(n);
      let i1 = rng.int(n);
      while (i1 === i0) i1 = rng.int(n);
      let i2 = rng.int(n);
      while (i2 === i0 || i2 === i1) i2 = rng.int(n);
      let i3 = rng.int(n);
      while (i3 === i0 || i3 === i1 || i3 === i2) i3 = rng.int(n);
      if (!goodSample(nx, ny, nu, nv, i0, i1, i2, i3)) continue;
      iters++;
      if (!solve4(nx, ny, nu, nv, i0, i1, i2, i3, hyp)) continue;
      const c = this.cost(hyp, n, t2, bestCost);
      if (c < bestCost) {
        bestCost = c;
        best.set(hyp);
        haveBest = true;
        bestInl = this.countInliers(best, n, t2, null);
        needed = Math.max(p.minIters, adaptiveIters(bestInl, n, p.confidence, p.maxIters));
      }
    }
    if (!haveBest) return { H: null, inliers: 0, iterations: iters };

    // 국소 최적화: 인라이어 전체로 DLT 재추정 → 점수가 나아지면 채택
    const tm = this.tmpMask;
    const lo = this.lo;
    for (let k = 0; k < p.loIters; k++) {
      const inl = this.countInliers(best, n, t2, tm);
      if (inl < 5) break;
      if (!dltNormalized(nx, ny, nu, nv, n, tm, lo)) break;
      const c = this.cost(lo, n, t2, Infinity);
      if (c < bestCost - 1e-12) {
        bestCost = c;
        best.set(lo);
      } else {
        break;
      }
    }
    const inliers = this.countInliers(best, n, t2, mask);
    const H = mul3(mul3(normMatInv(td), Array.from(best)), normMat(ts));
    return { H: canonicalizeH(H, ts.cx, ts.cy), inliers, iterations: iters };
  }

  /** MSAC 비용: Σ min(e², t²). bound를 넘으면 조기 종료 */
  private cost(h: Float64Array, n: number, t2: number, bound: number): number {
    const nx = this.nx;
    const ny = this.ny;
    const nu = this.nu;
    const nv = this.nv;
    const h0 = h[0];
    const h1 = h[1];
    const h2 = h[2];
    const h3 = h[3];
    const h4 = h[4];
    const h5 = h[5];
    const h6 = h[6];
    const h7 = h[7];
    const h8 = h[8];
    let c = 0;
    for (let i = 0; i < n; i++) {
      const x = nx[i];
      const y = ny[i];
      const w = h6 * x + h7 * y + h8;
      if (w <= 1e-9) {
        c += t2;
      } else {
        const iw = 1 / w;
        const ex = (h0 * x + h1 * y + h2) * iw - nu[i];
        const ey = (h3 * x + h4 * y + h5) * iw - nv[i];
        const e2 = ex * ex + ey * ey;
        c += e2 < t2 ? e2 : t2;
      }
      if (c >= bound) return c;
    }
    return c;
  }

  private countInliers(h: Float64Array, n: number, t2: number, mask: Uint8Array | null): number {
    const nx = this.nx;
    const ny = this.ny;
    const nu = this.nu;
    const nv = this.nv;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const x = nx[i];
      const y = ny[i];
      const w = h[6] * x + h[7] * y + h[8];
      let ok = false;
      if (w > 1e-9) {
        const ex = (h[0] * x + h[1] * y + h[2]) / w - nu[i];
        const ey = (h[3] * x + h[4] * y + h[5]) / w - nv[i];
        ok = ex * ex + ey * ey < t2;
      }
      if (mask) mask[i] = ok ? 1 : 0;
      if (ok) k++;
    }
    return k;
  }
}

function adaptiveIters(inl: number, n: number, conf: number, maxIters: number): number {
  const w = inl / n;
  if (w >= 1) return 1;
  const w4 = w * w * w * w;
  if (w4 < 1e-12) return maxIters;
  const denom = Math.log(1 - w4);
  if (!(denom < 0)) return maxIters;
  const k = Math.ceil(Math.log(1 - conf) / denom);
  return Math.min(maxIters, Math.max(1, k));
}

function cross3(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** 세 점 (a, b, c)의 방향이 src·dst에서 같고 둘 다 퇴화가 아닌지 */
function triOk(
  x: Float64Array,
  y: Float64Array,
  u: Float64Array,
  v: Float64Array,
  a: number,
  b: number,
  c: number,
): boolean {
  const s = cross3(x[a], y[a], x[b], y[b], x[c], y[c]);
  const d = cross3(u[a], v[a], u[b], v[b], u[c], v[c]);
  if (Math.abs(s) < 1e-3 || Math.abs(d) < 1e-3) return false;
  return s > 0 === d > 0;
}

/**
 * 4점 표본 검사: 세 점이 거의 일직선이면 퇴화, 그리고 방향(시계/반시계)이
 * src와 dst에서 같아야 한다 (거울상·꼬인 사각형 배제).
 */
function goodSample(
  x: Float64Array,
  y: Float64Array,
  u: Float64Array,
  v: Float64Array,
  i0: number,
  i1: number,
  i2: number,
  i3: number,
): boolean {
  return (
    triOk(x, y, u, v, i0, i1, i2) &&
    triOk(x, y, u, v, i0, i1, i3) &&
    triOk(x, y, u, v, i0, i2, i3) &&
    triOk(x, y, u, v, i1, i2, i3)
  );
}

// ───────────────────────── LM 정제 ─────────────────────────

const LM_A = new Float64Array(64);
const LM_A2 = new Float64Array(64);
const LM_B = new Float64Array(8);
const LM_X = new Float64Array(8);
const LM_H = new Float64Array(9);
const LM_T = new Float64Array(9);

/**
 * Levenberg–Marquardt로 순방향 재투영 오차 Σ|H(src) − dst|² 최소화.
 * mask가 있으면 선택된 점만. 정규화 좌표에서 h33 = 1로 8개 매개변수.
 */
export function refineHomographyLM(
  sx: Float64Array,
  sy: Float64Array,
  dx: Float64Array,
  dy: Float64Array,
  n: number,
  mask: Uint8Array | null,
  H0: Mat3,
  maxIters = 10,
): Mat3 {
  const ts: NormXf = { s: 1, cx: 0, cy: 0 };
  const td: NormXf = { s: 1, cx: 0, cy: 0 };
  let m = 0;
  for (let i = 0; i < n; i++) if (!mask || mask[i]) m++;
  if (m < 5) return H0;
  if (!computeNorm(sx, sy, n, mask, ts) || !computeNorm(dx, dy, n, mask, td)) return H0;
  const Hn = mul3(mul3(normMat(td), H0), normMatInv(ts));
  if (Math.abs(Hn[8]) < 1e-9) return H0;
  const h = LM_H;
  for (let k = 0; k < 9; k++) h[k] = Hn[k] / Hn[8];

  const evalCost = (hh: Float64Array): number => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      const x = ts.s * (sx[i] - ts.cx);
      const y = ts.s * (sy[i] - ts.cy);
      const w = hh[6] * x + hh[7] * y + 1;
      if (w <= 1e-9) return Infinity;
      const ex = (hh[0] * x + hh[1] * y + hh[2]) / w - td.s * (dx[i] - td.cx);
      const ey = (hh[3] * x + hh[4] * y + hh[5]) / w - td.s * (dy[i] - td.cy);
      c += ex * ex + ey * ey;
    }
    return c;
  };

  let cost = evalCost(h);
  if (!Number.isFinite(cost)) return H0;
  let lambda = 1e-3;
  const A = LM_A;
  const b = LM_B;
  for (let it = 0; it < maxIters; it++) {
    A.fill(0);
    b.fill(0);
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      const x = ts.s * (sx[i] - ts.cx);
      const y = ts.s * (sy[i] - ts.cy);
      const w = h[6] * x + h[7] * y + 1;
      const iw = 1 / w;
      const X = (h[0] * x + h[1] * y + h[2]) * iw;
      const Y = (h[3] * x + h[4] * y + h[5]) * iw;
      const rx = X - td.s * (dx[i] - td.cx);
      const ry = Y - td.s * (dy[i] - td.cy);
      const xw = x * iw;
      const yw = y * iw;
      // Jx = [xw, yw, iw, 0, 0, 0, -X xw, -X yw], Jy = [0, 0, 0, xw, yw, iw, -Y xw, -Y yw]
      const j6x = -X * xw;
      const j7x = -X * yw;
      const j6y = -Y * xw;
      const j7y = -Y * yw;
      // 대칭 누적 (상삼각)
      A[0] += xw * xw;
      A[1] += xw * yw;
      A[2] += xw * iw;
      A[6] += xw * j6x;
      A[7] += xw * j7x;
      A[9] += yw * yw;
      A[10] += yw * iw;
      A[14] += yw * j6x;
      A[15] += yw * j7x;
      A[18] += iw * iw;
      A[22] += iw * j6x;
      A[23] += iw * j7x;
      A[27] += xw * xw;
      A[28] += xw * yw;
      A[29] += xw * iw;
      A[30] += xw * j6y;
      A[31] += xw * j7y;
      A[36] += yw * yw;
      A[37] += yw * iw;
      A[38] += yw * j6y;
      A[39] += yw * j7y;
      A[45] += iw * iw;
      A[46] += iw * j6y;
      A[47] += iw * j7y;
      A[54] += j6x * j6x + j6y * j6y;
      A[55] += j6x * j7x + j6y * j7y;
      A[63] += j7x * j7x + j7y * j7y;
      b[0] += xw * rx;
      b[1] += yw * rx;
      b[2] += iw * rx;
      b[3] += xw * ry;
      b[4] += yw * ry;
      b[5] += iw * ry;
      b[6] += j6x * rx + j6y * ry;
      b[7] += j7x * rx + j7y * ry;
    }
    for (let r = 0; r < 8; r++) for (let c = 0; c < r; c++) A[r * 8 + c] = A[c * 8 + r];
    for (let k = 0; k < 8; k++) b[k] = -b[k];

    let improved = false;
    for (let tries = 0; tries < 6; tries++) {
      LM_A2.set(A);
      for (let k = 0; k < 8; k++) LM_A2[k * 9] = A[k * 9] * (1 + lambda) + 1e-12;
      if (!solveSPD(LM_A2, b, 8, LM_X)) {
        lambda *= 10;
        continue;
      }
      for (let k = 0; k < 8; k++) LM_T[k] = h[k] + LM_X[k];
      LM_T[8] = 1;
      const c = evalCost(LM_T);
      if (c < cost) {
        cost = c;
        h.set(LM_T);
        lambda = Math.max(lambda * 0.1, 1e-9);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
    let step = 0;
    for (let k = 0; k < 8; k++) step += LM_X[k] * LM_X[k];
    if (step < 1e-16) break;
  }
  const H = mul3(mul3(normMatInv(td), Array.from(h)), normMat(ts));
  return canonicalizeH(H, ts.cx, ts.cy);
}

// ───────────────────────── 검사·유틸 ─────────────────────────

/** 대응 오차 제곱 (src→dst). 무한원점이면 Infinity */
export function reprojError2(H: Mat3, x: number, y: number, u: number, v: number): number {
  const w = H[6] * x + H[7] * y + H[8];
  if (!(w > 1e-9)) return Infinity;
  const ex = (H[0] * x + H[1] * y + H[2]) / w - u;
  const ey = (H[3] * x + H[4] * y + H[5]) / w - v;
  return ex * ex + ey * ey;
}

/** H 아래에서 인라이어 표시·개수 */
export function countInliers(
  H: Mat3,
  sx: Float64Array,
  sy: Float64Array,
  dx: Float64Array,
  dy: Float64Array,
  n: number,
  threshold: number,
  mask: Uint8Array | null,
): number {
  const t2 = threshold * threshold;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const ok = reprojError2(H, sx[i], sy[i], dx[i], dy[i]) < t2;
    if (mask) mask[i] = ok ? 1 : 0;
    if (ok) k++;
  }
  return k;
}

/** 두 호모그래피가 rect 꼭짓점을 얼마나 다르게 보내는지 (최대 거리, px) */
export function maxCornerDistance(A: Mat3, B: Mat3, r: Rect): number {
  let m = 0;
  for (const c of rectCorners(r)) {
    const a = applyH(A, c);
    const b = applyH(B, c);
    if (!a || !b) return Infinity;
    m = Math.max(m, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return m;
}

/** 점 집합의 볼록 껍질 넓이 (monotone chain). mask가 있으면 선택된 점만 */
export function hullArea(xs: Float64Array, ys: Float64Array, n: number, mask: Uint8Array | null): number {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) if (!mask || mask[i]) pts.push({ x: xs[i], y: ys[i] });
  if (pts.length < 3) return 0;
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export interface SanityLimits {
  /** 워프된 ROI 넓이 / 원래 넓이 하한·상한 */
  minAreaRatio: number;
  maxAreaRatio: number;
  /** 워프된 사각형 내각 하한 (도). 상한은 180 − 이 값 */
  minAngleDeg: number;
  /** 워프된 사각형 최장 변 / 최단 변 상한 (원래 사각형 비율로 나눈 값) */
  maxEdgeRatio: number;
  /** 꼭짓점 w(원근 분모) 최대/최소 비 상한 — 극단적 원근 배제 */
  maxWRatio: number;
}

export const DEFAULT_SANITY: SanityLimits = {
  minAreaRatio: 1 / 16,
  maxAreaRatio: 16,
  minAngleDeg: 25,
  maxEdgeRatio: 6,
  maxWRatio: 3,
};

export interface SanityResult {
  ok: boolean;
  reason: string;
  areaRatio: number;
  quad: Point[] | null;
}

/** 워프된 ROI의 형상 타당성 검사 */
export function checkHomography(H: Mat3, roi: Rect, lim: SanityLimits = DEFAULT_SANITY): SanityResult {
  const fail = (reason: string, areaRatio = 0, quad: Point[] | null = null): SanityResult => ({
    ok: false,
    reason,
    areaRatio,
    quad,
  });
  if (!isFiniteH(H)) return fail("nan");
  const corners = rectCorners(roi);
  let wmin = Infinity;
  let wmax = -Infinity;
  const quad: Point[] = [];
  for (const c of corners) {
    const w = H[6] * c.x + H[7] * c.y + H[8];
    wmin = Math.min(wmin, w);
    wmax = Math.max(wmax, w);
    const p = applyH(H, c);
    if (!p) return fail("behind");
    quad.push(p);
  }
  if (!(wmin > 0) || wmax / wmin > lim.maxWRatio) return fail("perspective", 0, quad);
  if (!isConvex(quad)) return fail("nonconvex", 0, quad);
  // 방향 보존 (거울상 배제): 원래 사각형과 같은 부호
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    a += p.x * q.y - q.x * p.y;
  }
  a /= 2;
  const a0 = roi.width * roi.height;
  if (!(a > 0)) return fail("flipped", 0, quad);
  const ratio = a / a0;
  if (ratio < lim.minAreaRatio || ratio > lim.maxAreaRatio) return fail("area", ratio, quad);
  const minCos = Math.cos((lim.minAngleDeg * Math.PI) / 180);
  let emin = Infinity;
  let emax = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = quad[(i + 3) % 4];
    const p1 = quad[i];
    const p2 = quad[(i + 1) % 4];
    const ax = p0.x - p1.x;
    const ay = p0.y - p1.y;
    const bx = p2.x - p1.x;
    const by = p2.y - p1.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (!(la > 1e-6 && lb > 1e-6)) return fail("degenerate", ratio, quad);
    const cos = (ax * bx + ay * by) / (la * lb);
    if (Math.abs(cos) > minCos) return fail("angle", ratio, quad);
    // 변 i = quad[i] → quad[i+1]. 원래 변 길이로 나눠 비교 (가로·세로 비가 다른 ROI 대응)
    const rel = lb / (i % 2 === 0 ? roi.width : roi.height);
    emin = Math.min(emin, rel);
    emax = Math.max(emax, rel);
  }
  if (emax / emin > lim.maxEdgeRatio) return fail("edges", ratio, quad);
  return { ok: true, reason: "", areaRatio: ratio, quad };
}

/** 역행렬 래퍼 (정규화 포함) */
export function invertH(H: Mat3): Mat3 | null {
  const inv = invert3(H);
  return inv ? canonicalizeH(inv) : null;
}
