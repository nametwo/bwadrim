import type { GrayImage, Mat3, Rect } from "../types";
import { invert3, mul3 } from "../geometry";
import { canonicalizeH, isFiniteH, solveSPD } from "./homography";

// 기준 ROI 템플릿과 현재 프레임의 직접 정렬 (Baker–Matthews 역합성 IC, 호모그래피 8자유도).
// - 템플릿은 그래디언트가 큰 픽셀만 골라(격자 분산) 샘플 수를 제한한다.
// - 밝기: 이득·편향(gain/bias)을 중앙값 기반으로 시작해 Tukey 가중으로 다듬는다 (조명·그림자에 둔감).
// - 가림: Tukey 가중 IRLS, 척도(MAD)는 반복마다 좁아진다.
// - 단계 제어: Levenberg–Marquardt — 강건 비용이 실제로 줄어드는 걸음만 받는다 (발산·엉뚱한 수렴 방지).
// 기준과 직접 맞추므로 체인 누적 드리프트가 없다 → 추적 중 매 프레임 정밀화에 쓴다.
//
// 템플릿 좌표 u = (q − c) / s  (q: ref 0단계 픽셀, c: ROI 중심, s: ROI 반폭) → u ∈ [-1, 1].
// 현재 단계 좌표 x = G·u,  G = S_l · H · N⁻¹.

export class AlignTemplate {
  /** 값을 뽑은 ref 피라미드 단계 */
  level = 0;
  n = 0;
  u = new Float32Array(0);
  v = new Float32Array(0);
  T = new Float32Array(0);
  /** 최급강하 영상 (n × 8) */
  sd = new Float32Array(0);
  /** q = s·u + c */
  s = 1;
  cx = 0;
  cy = 0;
}

/**
 * refLevel(ref 피라미드 level단계 영상)에서 roi(0단계 좌표) 안 샘플을 골라 템플릿을 만든다.
 * minGrad: 단계 픽셀당 그레이 그래디언트 크기 하한.
 */
export function buildAlignTemplate(
  refLevel: GrayImage,
  level: number,
  roi: Rect,
  maxSamples: number,
  minGrad = 2,
): AlignTemplate {
  const tpl = new AlignTemplate();
  tpl.level = level;
  tpl.cx = roi.x + roi.width / 2;
  tpl.cy = roi.y + roi.height / 2;
  tpl.s = Math.max(roi.width, roi.height) / 2;
  const sc = 1 << level;
  const W = refLevel.width;
  const H = refLevel.height;
  const d = refLevel.data;
  const x0 = Math.max(1, Math.ceil(roi.x / sc));
  const y0 = Math.max(1, Math.ceil(roi.y / sc));
  const x1 = Math.min(W - 2, Math.floor((roi.x + roi.width) / sc));
  const y1 = Math.min(H - 2, Math.floor((roi.y + roi.height) / sc));
  if (x1 <= x0 || y1 <= y0) return tpl;
  const npix = (x1 - x0 + 1) * (y1 - y0 + 1);
  // 모든 픽셀의 그래디언트 (가는 획도 놓치지 않게) → 크기 히스토그램으로 상위 ~4×maxSamples만 후보
  const mg2 = minGrad * minGrad;
  const mags = new Float32Array(npix);
  const HB = 256;
  const hist = new Uint32Array(HB);
  const HMAX = 128; // 그레이/px (이보다 크면 마지막 칸)
  let nAbove = 0;
  for (let y = y0, k = 0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++, k++) {
      const i = y * W + x;
      const gx = (d[i + 1] - d[i - 1]) * 0.5;
      const gy = (d[i + W] - d[i - W]) * 0.5;
      const m2 = gx * gx + gy * gy;
      mags[k] = m2;
      if (m2 < mg2) continue;
      nAbove++;
      hist[Math.min(HB - 1, Math.floor((Math.sqrt(m2) * HB) / HMAX))]++;
    }
  }
  if (nAbove === 0) return tpl;
  const want = Math.min(nAbove, 4 * maxSamples);
  let thrBin = 0;
  for (let b = HB - 1, acc = 0; b >= 0; b--) {
    acc += hist[b];
    if (acc >= want) {
      thrBin = b;
      break;
    }
  }
  const thrMag = Math.max(minGrad, (thrBin * HMAX) / HB);
  const thr2 = thrMag * thrMag;
  const cap = Math.min(nAbove, want + hist[thrBin] + 16);
  const cx = new Int32Array(cap);
  const cy = new Int32Array(cap);
  const cgx = new Float32Array(cap);
  const cgy = new Float32Array(cap);
  const cm = new Float32Array(cap);
  let nc = 0;
  for (let y = y0, k = 0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++, k++) {
      const m2 = mags[k];
      if (m2 < thr2 || m2 < mg2 || nc >= cap) continue;
      const i = y * W + x;
      cx[nc] = x;
      cy[nc] = y;
      cgx[nc] = (d[i + 1] - d[i - 1]) * 0.5;
      cgy[nc] = (d[i + W] - d[i - W]) * 0.5;
      cm[nc] = m2;
      nc++;
    }
  }
  if (nc === 0) return tpl;

  // 격자 분산 선택 (8×8 셀, 셀당 상한)
  const idx = new Uint32Array(nc);
  for (let i = 0; i < nc; i++) idx[i] = i;
  idx.sort((a, b) => cm[b] - cm[a] || a - b);
  const G = 8;
  const cellCap = Math.max(4, Math.ceil((maxSamples / (G * G)) * 2));
  const cnt = new Uint16Array(G * G);
  const sel = new Int32Array(Math.min(nc, maxSamples));
  let ns = 0;
  const cw = (x1 - x0 + 1) / G;
  const ch = (y1 - y0 + 1) / G;
  for (let k = 0; k < nc && ns < maxSamples; k++) {
    const i = idx[k];
    const gxc = Math.min(G - 1, Math.floor((cx[i] - x0) / cw));
    const gyc = Math.min(G - 1, Math.floor((cy[i] - y0) / ch));
    const c = gyc * G + gxc;
    if (cnt[c] >= cellCap) continue;
    cnt[c]++;
    sel[ns++] = i;
  }
  // 셀 상한 때문에 모자라면 남은 것 중 강한 순으로 채움
  if (ns < maxSamples && ns < nc) {
    const used = new Uint8Array(nc);
    for (let k = 0; k < ns; k++) used[sel[k]] = 1;
    for (let k = 0; k < nc && ns < maxSamples; k++) {
      const i = idx[k];
      if (!used[i]) sel[ns++] = i;
    }
  }

  tpl.n = ns;
  tpl.u = new Float32Array(ns);
  tpl.v = new Float32Array(ns);
  tpl.T = new Float32Array(ns);
  tpl.sd = new Float32Array(ns * 8);
  const k2u = tpl.s / sc; // d/du = d/dx_l · s / 2^l
  for (let k = 0; k < ns; k++) {
    const i = sel[k];
    const u = (cx[i] * sc - tpl.cx) / tpl.s;
    const v = (cy[i] * sc - tpl.cy) / tpl.s;
    const tu = cgx[i] * k2u;
    const tv = cgy[i] * k2u;
    tpl.u[k] = u;
    tpl.v[k] = v;
    tpl.T[k] = d[cy[i] * W + cx[i]];
    const o = k * 8;
    tpl.sd[o] = tu * u;
    tpl.sd[o + 1] = tu * v;
    tpl.sd[o + 2] = tu;
    tpl.sd[o + 3] = tv * u;
    tpl.sd[o + 4] = tv * v;
    tpl.sd[o + 5] = tv;
    tpl.sd[o + 6] = -tu * u * u - tv * u * v;
    tpl.sd[o + 7] = -tu * u * v - tv * v * v;
  }
  return tpl;
}

export interface AlignParams {
  maxIters: number;
  /** 수렴: 템플릿 꼭짓점 이동이 이 값(현재 단계 px) 미만 */
  epsilon: number;
  /** 보이는 샘플 비율 하한 */
  minVisible: number;
  /** Tukey 임계 = tukeyK · σ(MAD) */
  tukeyK: number;
  /** σ 하한 (그레이) */
  minSigma: number;
}

export const DEFAULT_ALIGN: AlignParams = {
  maxIters: 15,
  epsilon: 0.02,
  minVisible: 0.3,
  tukeyK: 4.685,
  minSigma: 2,
};

export interface AlignResult {
  ok: boolean;
  /** ref 0단계 → frame 0단계 */
  H: Mat3;
  /** 최종 위치에서 템플릿–현재 NCC (보이는 샘플) */
  ncc: number;
  /** 보이는 샘플 비율 */
  visible: number;
  iters: number;
  converged: boolean;
}

/**
 * 역합성 가우스–뉴턴 + Levenberg–Marquardt 단계 제어.
 * 비용 = Σ Tukey ρ(αI + β − T) + (안 보이는 샘플 × ρ 최대) — 비용이 줄어드는 단계만 받아들여
 * 가림·반복 무늬가 있어도 엉뚱한 곳으로 튀지 않는다.
 */
export class Aligner {
  private I = new Float32Array(0);
  private I2 = new Float32Array(0);
  private w = new Float32Array(0);
  private vis = new Uint8Array(0);
  private vis2 = new Uint8Array(0);
  private hist = new Uint32Array(256);
  private hist2 = new Uint32Array(256);
  private Hs = new Float64Array(64);
  private Hd = new Float64Array(64);
  private g = new Float64Array(8);
  private dp = new Float64Array(8);
  private Gf = new Float64Array(9);
  private gb = new Float64Array(2);

  private ensure(n: number): void {
    if (this.I.length >= n) return;
    this.I = new Float32Array(n);
    this.I2 = new Float32Array(n);
    this.w = new Float32Array(n);
    this.vis = new Uint8Array(n);
    this.vis2 = new Uint8Array(n);
  }

  /** G로 샘플 → (보이는 수). 결과는 I/vis 버퍼에 */
  private sample(tpl: AlignTemplate, G: Mat3, cur: GrayImage, I: Float32Array, vis: Uint8Array): number {
    const Gf = this.Gf;
    for (let k = 0; k < 9; k++) Gf[k] = G[k];
    return warpSampleKernel(Gf, tpl.u, tpl.v, tpl.n, cur.data, cur.width, cur.height, I, vis);
  }

  /**
   * cur = 현재 프레임 피라미드의 curLevel단계 영상. H0 = ref→frame (0단계) 초기값.
   */
  align(tpl: AlignTemplate, cur: GrayImage, curLevel: number, H0: Mat3, p: AlignParams): AlignResult {
    const n = tpl.n;
    const fail: AlignResult = { ok: false, H: H0, ncc: 0, visible: 0, iters: 0, converged: false };
    if (n < 16 || !isFiniteH(H0)) return fail;
    this.ensure(n);
    const sc = 1 / (1 << curLevel);
    const Ninv: Mat3 = [tpl.s, 0, tpl.cx, 0, tpl.s, tpl.cy, 0, 0, 1];
    const S: Mat3 = [sc, 0, 0, 0, sc, 0, 0, 0, 1];
    let G = mul3(mul3(S, H0), Ninv);
    const minVis = Math.max(16, p.minVisible * n);

    // 초기 샘플·이득·편향 (중앙값 기반)
    let nv = this.sample(tpl, G, cur, this.I, this.vis);
    if (nv < minVis) return fail;
    const r0 = robustGainBias(this.I, tpl.T, this.vis, n, nv, this.hist, this.hist2);
    if (!(r0[0] > 0)) return fail;
    let alpha = clampGain(r0[0]);
    let beta = r0[1];

    let lambda = 1e-3;
    let converged = false;
    let it = 0;
    for (; it < p.maxIters; it++) {
      // 척도는 반복마다 다시 (정렬될수록 좁아짐 → 가림을 점점 확실히 버림).
      // 같은 반복 안에서는 같은 c로 현재·시도 비용을 비교한다.
      const med = medianAbsResidual(this.I, tpl.T, this.vis, n, nv, alpha, beta, this.hist);
      const c = p.tukeyK * Math.max(p.minSigma, 1.4826 * med);
      refineGainBias(this.I, tpl.T, this.vis, n, alpha, beta, c, this.gb);
      alpha = clampGain(this.gb[0]);
      beta = this.gb[1];
      const cost = tukeyCost(this.I, tpl.T, this.vis, n, alpha, beta, c);
      accumulateNormalKernel(this.I, tpl.T, this.vis, this.w, tpl.sd, n, alpha, beta, c, true, this.Hs, this.g);
      const Hs = this.Hs;
      let diag = 0;
      for (let r = 0; r < 8; r++) {
        for (let q = 0; q < r; q++) Hs[r * 8 + q] = Hs[q * 8 + r];
        diag += Hs[r * 9];
      }
      diag = diag / 8 + 1e-12;
      let accepted = false;
      for (let tries = 0; tries < 8; tries++) {
        const Hd = this.Hd;
        Hd.set(Hs);
        for (let r = 0; r < 8; r++) Hd[r * 9] += lambda * diag;
        if (!solveSPD(Hd, this.g, 8, this.dp)) {
          lambda *= 10;
          continue;
        }
        const dp = this.dp;
        const dH: Mat3 = [1 + dp[0], dp[1], dp[2], dp[3], 1 + dp[4], dp[5], dp[6], dp[7], 1];
        const inv = invert3(dH);
        const Gn = inv ? mul3(G, inv) : null;
        if (!Gn || !isFiniteH(Gn)) {
          lambda *= 10;
          continue;
        }
        const nv2 = this.sample(tpl, Gn, cur, this.I2, this.vis2);
        if (nv2 < minVis) {
          lambda *= 10;
          continue;
        }
        // 시도점의 이득·편향은 현재 값에서 매끄럽게 재추정 (중앙값은 계단식이라 비용 비교가 흔들린다)
        refineGainBias(this.I2, tpl.T, this.vis2, n, alpha, beta, c, this.gb);
        const a2 = clampGain(this.gb[0]);
        const b2 = this.gb[1];
        const cost2 = tukeyCost(this.I2, tpl.T, this.vis2, n, a2, b2, c);
        if (cost2 < cost) {
          // 수렴 판정: ΔH가 템플릿 꼭짓점을 현재 단계 px로 얼마나 움직이는지.
          // 감쇠가 큰(λ↑) 작은 걸음은 수렴이 아니다 → 감쇠가 작을 때만 인정
          const shift = cornerShift(dH) * unitScale(G);
          const smallDamping = lambda <= 1e-2;
          G = Gn;
          alpha = a2;
          beta = b2;
          nv = nv2;
          const tI = this.I;
          this.I = this.I2;
          this.I2 = tI;
          const tv = this.vis;
          this.vis = this.vis2;
          this.vis2 = tv;
          lambda = Math.max(lambda * 0.1, 1e-6);
          accepted = true;
          if (shift < p.epsilon && smallDamping) converged = true;
          break;
        }
        lambda *= 10;
      }
      if (!accepted) {
        // 더 줄일 수 없음 = 국소 최소
        converged = true;
        break;
      }
      if (converged) break;
    }

    const ncc = plainNcc(this.I, tpl.T, this.vis, n);
    const Sinv: Mat3 = [1 / sc, 0, 0, 0, 1 / sc, 0, 0, 0, 1];
    const Nm: Mat3 = [1 / tpl.s, 0, -tpl.cx / tpl.s, 0, 1 / tpl.s, -tpl.cy / tpl.s, 0, 0, 1];
    const H = canonicalizeH(mul3(mul3(Sinv, G), Nm), tpl.cx, tpl.cy);
    if (!isFiniteH(H)) return { ...fail, iters: it };
    return { ok: true, H, ncc, visible: nv / n, iters: it, converged };
  }
}

function clampGain(a: number): number {
  return Math.min(4, Math.max(0.25, a));
}

/** ΔH가 u-공간 꼭짓점 (±1, ±1)을 움직이는 최대 거리 */
function cornerShift(dH: Mat3): number {
  let shift = 0;
  for (let cyy = -1; cyy <= 1; cyy += 2) {
    for (let cxx = -1; cxx <= 1; cxx += 2) {
      const z = dH[6] * cxx + dH[7] * cyy + 1;
      const ex = (dH[0] * cxx + dH[1] * cyy + dH[2]) / z - cxx;
      const ey = (dH[3] * cxx + dH[4] * cyy + dH[5]) / z - cyy;
      shift = Math.max(shift, Math.hypot(ex, ey));
    }
  }
  return shift;
}

/** 보이는 샘플의 (비가중) NCC */
function plainNcc(I: Float32Array, T: Float32Array, vis: Uint8Array, n: number): number {
  let m = 0;
  let a = 0;
  let b = 0;
  let aa = 0;
  let bb = 0;
  let ab = 0;
  for (let k = 0; k < n; k++) {
    if (!vis[k]) continue;
    const x = I[k];
    const y = T[k];
    m++;
    a += x;
    b += y;
    aa += x * x;
    bb += y * y;
    ab += x * y;
  }
  if (m < 2) return 0;
  const ma = a / m;
  const mb = b / m;
  const va = aa / m - ma * ma;
  const vb = bb / m - mb * mb;
  return va > 1e-6 && vb > 1e-6 ? (ab / m - ma * mb) / Math.sqrt(va * vb) : 0;
}

/** Tukey 비용 (안 보이는 샘플은 ρ 최대값으로) */
function tukeyCost(
  I: Float32Array,
  T: Float32Array,
  vis: Uint8Array,
  n: number,
  alpha: number,
  beta: number,
  c: number,
): number {
  const c2 = c * c;
  const rmax = c2 / 6;
  const ic2 = 1 / c2;
  let s = 0;
  for (let k = 0; k < n; k++) {
    if (!vis[k]) {
      s += rmax;
      continue;
    }
    const e = alpha * I[k] + beta - T[k];
    const r = e * e * ic2;
    if (r >= 1) s += rmax;
    else {
      const q = 1 - r;
      s += rmax * (1 - q * q * q);
    }
  }
  return s;
}

/** Tukey 가중 평균·분산으로 이득·편향 재추정 → out = [α, β] */
function refineGainBias(
  I: Float32Array,
  T: Float32Array,
  vis: Uint8Array,
  n: number,
  a0: number,
  b0: number,
  c: number,
  out: Float64Array,
): void {
  const ic2 = 1 / (c * c);
  let sw = 0;
  let sI = 0;
  let sT = 0;
  let sII = 0;
  let sTT = 0;
  for (let k = 0; k < n; k++) {
    if (!vis[k]) continue;
    const e = a0 * I[k] + b0 - T[k];
    const r = e * e * ic2;
    if (r >= 1) continue;
    const q = 1 - r;
    const w = q * q;
    const x = I[k];
    const y = T[k];
    sw += w;
    sI += w * x;
    sT += w * y;
    sII += w * x * x;
    sTT += w * y * y;
  }
  if (!(sw > 1e-9)) {
    out[0] = a0;
    out[1] = b0;
    return;
  }
  const mI = sI / sw;
  const mT = sT / sw;
  const vI = sII / sw - mI * mI;
  const vT = sTT / sw - mT * mT;
  const a = vI > 1e-6 ? Math.sqrt(Math.max(vT, 1e-6) / vI) : a0;
  out[0] = a;
  out[1] = mT - a * mI;
}

/**
 * G로 템플릿 점을 현재 영상에 투영해 쌍선형 샘플 → I, vis. 보이는 점 수를 돌려준다.
 */
function warpSampleKernel(
  G: Float64Array,
  uu: Float32Array,
  vv: Float32Array,
  n: number,
  cd: Uint8Array | Uint8ClampedArray,
  W: number,
  Hh: number,
  I: Float32Array,
  vis: Uint8Array,
): number {
  const g0 = G[0];
  const g1 = G[1];
  const g2 = G[2];
  const g3 = G[3];
  const g4 = G[4];
  const g5 = G[5];
  const g6 = G[6];
  const g7 = G[7];
  const g8 = G[8];
  const xmax = W - 1;
  const ymax = Hh - 1;
  let nv = 0;
  for (let k = 0; k < n; k++) {
    const u = uu[k];
    const v = vv[k];
    const z = g6 * u + g7 * v + g8;
    if (!(z > 1e-9)) {
      vis[k] = 0;
      continue;
    }
    const iz = 1 / z;
    const x = (g0 * u + g1 * v + g2) * iz;
    const y = (g3 * u + g4 * v + g5) * iz;
    if (!(x >= 0 && y >= 0 && x < xmax && y < ymax)) {
      vis[k] = 0;
      continue;
    }
    const ix = x | 0;
    const iy = y | 0;
    const fx = x - ix;
    const fy = y - iy;
    const i = iy * W + ix;
    const a = cd[i];
    const b = cd[i + 1];
    const c = cd[i + W];
    const d = cd[i + W + 1];
    I[k] = a + fx * (b - a) + fy * (c - a + fx * (a - b - c + d));
    vis[k] = 1;
    nv++;
  }
  return nv;
}

/**
 * 중앙값·MAD 기반 이득·편향: α = MAD(T)/MAD(I), β = med(T) − α·med(I).
 * 값이 0~255라 히스토그램으로 O(n).
 */
function robustGainBias(
  I: Float32Array,
  T: Float32Array,
  vis: Uint8Array,
  n: number,
  nv: number,
  hI: Uint32Array,
  hT: Uint32Array,
): [number, number] {
  hI.fill(0);
  hT.fill(0);
  for (let k = 0; k < n; k++) {
    if (!vis[k]) continue;
    hI[clampByte(I[k])]++;
    hT[clampByte(T[k])]++;
  }
  const mI = histMedian(hI, nv);
  const mT = histMedian(hT, nv);
  hI.fill(0);
  hT.fill(0);
  for (let k = 0; k < n; k++) {
    if (!vis[k]) continue;
    hI[clampByte(Math.abs(I[k] - mI))]++;
    hT[clampByte(Math.abs(T[k] - mT))]++;
  }
  const dI = Math.max(0.5, histMedian(hI, nv));
  const dT = Math.max(0.5, histMedian(hT, nv));
  const alpha = dT / dI;
  return [alpha, mT - alpha * mI];
}

function clampByte(v: number): number {
  const b = Math.round(v);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

function histMedian(h: Uint32Array, total: number): number {
  const half = total / 2;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += h[b];
    if (acc >= half) return b;
  }
  return 255;
}

/** |αI + β − T|의 중앙값 (0.5 그레이 단위 히스토그램) */
function medianAbsResidual(
  I: Float32Array,
  T: Float32Array,
  vis: Uint8Array,
  n: number,
  nv: number,
  alpha: number,
  beta: number,
  hist: Uint32Array,
): number {
  hist.fill(0);
  for (let k = 0; k < n; k++) {
    if (!vis[k]) continue;
    const e = alpha * I[k] + beta - T[k];
    let b = Math.floor((e < 0 ? -e : e) * 2);
    if (b > 255) b = 255;
    hist[b]++;
  }
  let acc = 0;
  const half = nv / 2;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= half) return (b + 0.5) * 0.5;
  }
  return 64;
}

/** Tukey(또는 Huber) 가중 JᵀWJ (상삼각)·JᵀWe 누적. 가중치는 wt에 기록 */
function accumulateNormalKernel(
  I: Float32Array,
  T: Float32Array,
  vis: Uint8Array,
  wt: Float32Array,
  sd: Float32Array,
  n: number,
  alpha: number,
  beta: number,
  c: number,
  tukey: boolean,
  Hs: Float64Array,
  gv: Float64Array,
): void {
  Hs.fill(0);
  gv.fill(0);
  const ic2 = 1 / (c * c);
  for (let k = 0; k < n; k++) {
    if (!vis[k]) {
      wt[k] = 0;
      continue;
    }
    const e = alpha * I[k] + beta - T[k];
    const ae = e < 0 ? -e : e;
    let ww: number;
    if (tukey) {
      const q = 1 - e * e * ic2;
      ww = ae < c ? q * q : 0;
    } else {
      ww = ae <= c ? 1 : c / ae;
    }
    wt[k] = ww;
    if (ww === 0) continue;
    const o = k * 8;
    const d0 = sd[o];
    const d1 = sd[o + 1];
    const d2 = sd[o + 2];
    const d3 = sd[o + 3];
    const d4 = sd[o + 4];
    const d5 = sd[o + 5];
    const d6 = sd[o + 6];
    const d7 = sd[o + 7];
    const s0 = d0 * ww;
    const s1 = d1 * ww;
    const s2 = d2 * ww;
    const s3 = d3 * ww;
    const s4 = d4 * ww;
    const s5 = d5 * ww;
    const s6 = d6 * ww;
    const s7 = d7 * ww;
    gv[0] += s0 * e;
    gv[1] += s1 * e;
    gv[2] += s2 * e;
    gv[3] += s3 * e;
    gv[4] += s4 * e;
    gv[5] += s5 * e;
    gv[6] += s6 * e;
    gv[7] += s7 * e;
    Hs[0] += s0 * d0;
    Hs[1] += s0 * d1;
    Hs[2] += s0 * d2;
    Hs[3] += s0 * d3;
    Hs[4] += s0 * d4;
    Hs[5] += s0 * d5;
    Hs[6] += s0 * d6;
    Hs[7] += s0 * d7;
    Hs[9] += s1 * d1;
    Hs[10] += s1 * d2;
    Hs[11] += s1 * d3;
    Hs[12] += s1 * d4;
    Hs[13] += s1 * d5;
    Hs[14] += s1 * d6;
    Hs[15] += s1 * d7;
    Hs[18] += s2 * d2;
    Hs[19] += s2 * d3;
    Hs[20] += s2 * d4;
    Hs[21] += s2 * d5;
    Hs[22] += s2 * d6;
    Hs[23] += s2 * d7;
    Hs[27] += s3 * d3;
    Hs[28] += s3 * d4;
    Hs[29] += s3 * d5;
    Hs[30] += s3 * d6;
    Hs[31] += s3 * d7;
    Hs[36] += s4 * d4;
    Hs[37] += s4 * d5;
    Hs[38] += s4 * d6;
    Hs[39] += s4 * d7;
    Hs[45] += s5 * d5;
    Hs[46] += s5 * d6;
    Hs[47] += s5 * d7;
    Hs[54] += s6 * d6;
    Hs[55] += s6 * d7;
    Hs[63] += s7 * d7;
  }
}

/** G가 u-공간 단위 길이를 현재 단계 px 몇 개로 보내는지 (원점 근방, 평균) */
function unitScale(G: Mat3): number {
  const z0 = G[8];
  const x0 = G[2] / z0;
  const y0 = G[5] / z0;
  const zx = G[6] + G[8];
  const zy = G[7] + G[8];
  const dx = Math.hypot((G[0] + G[2]) / zx - x0, (G[3] + G[5]) / zx - y0);
  const dy = Math.hypot((G[1] + G[2]) / zy - x0, (G[4] + G[5]) / zy - y0);
  const s = (dx + dy) / 2;
  return Number.isFinite(s) ? s : 1;
}
