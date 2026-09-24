import type { GrayImage, Mat3, Rect } from "../types";
import { localScale } from "../geometry";
import { bilinear, type Pyramid } from "./image";

// 광도 검증: 기준 ROI를 성긴 격자로 샘플링해 두고, 후보 H로 현재 프레임에서 같은 점을 뽑아
// 블록별 NCC를 본다 (조명의 이득·편향 변화에 불변).
// 무늬 있는 블록이 전부(거의) 맞아야 통과 → 반복 패턴에서 옆 복제본으로 튀면
// 복제본에 없는 고유한 부분(라벨·가장자리)의 블록이 틀려서 걸러진다.
// 스케일 차이는 피라미드 단계 선택으로 맞춘다(흐림 정도를 양쪽에서 비슷하게).

export interface VerifyResult {
  /** 보이는 모든 샘플의 NCC */
  ncc: number;
  /** 무늬 있는 블록 수 (ref 기준) */
  blocksTextured: number;
  /** 무늬 있고 충분히 보이는 블록 수 */
  blocksVisible: number;
  /** 그중 NCC ≥ blockGood 인 블록 수 */
  blocksGood: number;
  /** good / visible (visible = 0이면 0) */
  fracGood: number;
  /** 보이는 무늬 블록 중 최소 NCC (없으면 −1) */
  minBlock: number;
  /** 보이는 샘플 비율 */
  visibleFrac: number;
  refLevel: number;
  curLevel: number;
}

export function emptyVerify(): VerifyResult {
  return {
    ncc: 0,
    blocksTextured: 0,
    blocksVisible: 0,
    blocksGood: 0,
    fracGood: 0,
    minBlock: -1,
    visibleFrac: 0,
    refLevel: 0,
    curLevel: 0,
  };
}

export interface VerifyBuildParams {
  /** 목표 샘플 수 */
  samples: number;
  /** 한 변 블록 수 (B × B 블록) */
  blocks: number;
  /** 블록 표준편차가 이 이상이어야 '무늬 있음' */
  minStd: number;
}

export const DEFAULT_VERIFY_BUILD: VerifyBuildParams = {
  samples: 900,
  blocks: 6,
  minStd: 5,
};

export interface AmbiguityCriteria {
  /** 전체 NCC 하한 */
  ncc: number;
  /** 좋은 블록 비율 하한 */
  fracGood: number;
  /** 블록 NCC가 이 이상이면 좋은 블록 */
  blockGood: number;
  /** 최소 블록 NCC 하한 */
  minBlock: number;
}

export interface RepeatScanResult {
  ambiguous: boolean;
  /** 가장 강한 2차 봉우리 이동량 (0단계 px) */
  shiftX: number;
  shiftY: number;
  score: number;
  /** 전역 NCC ≥ 0.4인 2차 봉우리들 (dx, dy, …) 점수 내림차순 — 재검출 때 '옆 복제본보다 나은가' 비교용 */
  peaks: number[];
}

export class VerifyModel {
  roi: Rect = { x: 0, y: 0, width: 0, height: 0 };
  gx = 0;
  gy = 0;
  n = 0;
  B = 6;
  nBlocks = 36;
  spacing = 1;
  baseLevel = 0;
  qx = new Float64Array(0);
  qy = new Float64Array(0);
  blk = new Uint16Array(0);
  blockSize = new Uint16Array(0);
  vals: Float32Array[] = [];
  textured: Uint8Array[] = [];
  nTextured: number[] = [];
  /** 마지막 evaluate의 블록별 NCC (무늬 없거나 안 보이면 NaN) — 진단용 */
  blockNcc = new Float32Array(0);
  private acc = new Float64Array(0);

  static build(refPyr: Pyramid, roi: Rect, p: VerifyBuildParams = DEFAULT_VERIFY_BUILD): VerifyModel {
    const m = new VerifyModel();
    m.roi = { ...roi };
    const spacing = Math.sqrt((roi.width * roi.height) / p.samples);
    m.gx = Math.max(p.blocks * 2, Math.round(roi.width / spacing));
    m.gy = Math.max(p.blocks * 2, Math.round(roi.height / spacing));
    m.n = m.gx * m.gy;
    m.B = p.blocks;
    m.nBlocks = p.blocks * p.blocks;
    const sx = roi.width / m.gx;
    const sy = roi.height / m.gy;
    m.spacing = Math.max(sx, sy);
    m.baseLevel = Math.max(0, Math.min(refPyr.length - 1, Math.floor(Math.log2(m.spacing)) - 1));
    m.qx = new Float64Array(m.n);
    m.qy = new Float64Array(m.n);
    m.blk = new Uint16Array(m.n);
    m.blockSize = new Uint16Array(m.nBlocks);
    for (let j = 0, k = 0; j < m.gy; j++) {
      for (let i = 0; i < m.gx; i++, k++) {
        m.qx[k] = roi.x + (i + 0.5) * sx;
        m.qy[k] = roi.y + (j + 0.5) * sy;
        const b = Math.floor((j * p.blocks) / m.gy) * p.blocks + Math.floor((i * p.blocks) / m.gx);
        m.blk[k] = b;
        m.blockSize[b]++;
      }
    }
    m.acc = new Float64Array(m.nBlocks * 6);
    m.blockNcc = new Float32Array(m.nBlocks);
    for (let l = 0; l < refPyr.length; l++) {
      const img = refPyr.levels[l];
      const sc = 1 / (1 << l);
      const vals = new Float32Array(m.n);
      const xm = img.width - 1.001;
      const ym = img.height - 1.001;
      for (let k = 0; k < m.n; k++) {
        const x = Math.min(xm, Math.max(0, m.qx[k] * sc));
        const y = Math.min(ym, Math.max(0, m.qy[k] * sc));
        vals[k] = bilinear(img.data, img.width, x, y);
      }
      const s1 = new Float64Array(m.nBlocks);
      const s2 = new Float64Array(m.nBlocks);
      for (let k = 0; k < m.n; k++) {
        s1[m.blk[k]] += vals[k];
        s2[m.blk[k]] += vals[k] * vals[k];
      }
      const tex = new Uint8Array(m.nBlocks);
      let nt = 0;
      for (let b = 0; b < m.nBlocks; b++) {
        const c = m.blockSize[b];
        if (c < 4) continue;
        const mean = s1[b] / c;
        const v = s2[b] / c - mean * mean;
        if (v >= p.minStd * p.minStd) {
          tex[b] = 1;
          nt++;
        }
      }
      m.vals[l] = vals;
      m.textured[l] = tex;
      m.nTextured[l] = nt;
    }
    return m;
  }

  /** H의 국소 스케일로 (ref 단계, 현재 단계)를 고른다 */
  chooseLevels(H: Mat3, curLevels: number): [number, number] {
    const c = { x: this.roi.x + this.roi.width / 2, y: this.roi.y + this.roi.height / 2 };
    const k = localScale(H, c, Math.max(1, this.spacing));
    let e = Number.isFinite(k) && k > 0 ? Math.round(Math.log2(k)) : 0;
    if (e > 3) e = 3;
    if (e < -3) e = -3;
    let lr = this.baseLevel + Math.max(0, -e);
    let lc = this.baseLevel + Math.max(0, e);
    lr = Math.min(lr, this.vals.length - 1);
    lc = Math.min(lc, curLevels - 1);
    return [lr, lc];
  }

  /**
   * 후보 H(ref → frame 0단계)를 현재 피라미드에서 검증한다.
   * levels를 주면 단계 선택을 강제한다 ([ref, cur]).
   */
  evaluate(
    cur: Pyramid,
    H: Mat3,
    blockGood: number,
    out: VerifyResult,
    levels?: [number, number],
  ): VerifyResult {
    const [lr, lc] = levels ?? this.chooseLevels(H, cur.length);
    const img = cur.levels[lc];
    const W = img.width;
    const Hh = img.height;
    const d = img.data;
    const sc = 1 / (1 << lc);
    const vals = this.vals[lr];
    const tex = this.textured[lr];
    const acc = this.acc;
    acc.fill(0);
    const h0 = H[0] * sc;
    const h1 = H[1] * sc;
    const h2 = H[2] * sc;
    const h3 = H[3] * sc;
    const h4 = H[4] * sc;
    const h5 = H[5] * sc;
    const h6 = H[6];
    const h7 = H[7];
    const h8 = H[8];
    const xm = W - 1;
    const ym = Hh - 1;
    let nv = 0;
    let gA = 0;
    let gB = 0;
    let gAA = 0;
    let gBB = 0;
    let gAB = 0;
    for (let k = 0; k < this.n; k++) {
      const qx = this.qx[k];
      const qy = this.qy[k];
      const w = h6 * qx + h7 * qy + h8;
      if (!(w > 1e-9)) continue;
      const x = (h0 * qx + h1 * qy + h2) / w;
      const y = (h3 * qx + h4 * qy + h5) / w;
      if (!(x >= 0 && y >= 0 && x < xm && y < ym)) continue;
      const b = bilinear(d, W, x, y);
      const a = vals[k];
      const o = this.blk[k] * 6;
      acc[o] += 1;
      acc[o + 1] += a;
      acc[o + 2] += b;
      acc[o + 3] += a * a;
      acc[o + 4] += b * b;
      acc[o + 5] += a * b;
      nv++;
      gA += a;
      gB += b;
      gAA += a * a;
      gBB += b * b;
      gAB += a * b;
    }
    let vis = 0;
    let good = 0;
    let minB = 2;
    this.blockNcc.fill(NaN);
    for (let b = 0; b < this.nBlocks; b++) {
      if (!tex[b]) continue;
      const o = b * 6;
      const c = acc[o];
      if (c < 0.6 * this.blockSize[b] || c < 4) continue;
      vis++;
      const ma = acc[o + 1] / c;
      const mb = acc[o + 2] / c;
      const va = acc[o + 3] / c - ma * ma;
      const vb = acc[o + 4] / c - mb * mb;
      const cov = acc[o + 5] / c - ma * mb;
      // 현재 쪽이 평평하면(무늬가 사라짐) 불일치로 본다
      const r = va > 1e-6 && vb > 1 ? cov / Math.sqrt(va * vb) : 0;
      this.blockNcc[b] = r;
      if (r >= blockGood) good++;
      if (r < minB) minB = r;
    }
    let ncc = 0;
    if (nv >= 8) {
      const ma = gA / nv;
      const mb = gB / nv;
      const va = gAA / nv - ma * ma;
      const vb = gBB / nv - mb * mb;
      const cov = gAB / nv - ma * mb;
      ncc = va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : 0;
    }
    out.ncc = ncc;
    out.blocksTextured = this.nTextured[lr];
    out.blocksVisible = vis;
    out.blocksGood = good;
    out.fracGood = vis > 0 ? good / vis : 0;
    out.minBlock = vis > 0 ? minB : -1;
    out.visibleFrac = nv / this.n;
    out.refLevel = lr;
    out.curLevel = lc;
    return out;
  }

  /**
   * 빠른 전역 NCC: l단계 영상에서 (ref px 기준 이동 dx, dy) 위치의 샘플과 비교.
   * stride개마다 한 샘플. 보이는 샘플이 절반 미만이면 −2.
   */
  quickNcc(img: GrayImage, l: number, dx: number, dy: number, stride: number): number {
    const vals = this.vals[l];
    const W = img.width;
    const Hh = img.height;
    const d = img.data;
    const sc = 1 / (1 << l);
    const ox = dx * sc;
    const oy = dy * sc;
    const xm = W - 1;
    const ym = Hh - 1;
    let nv = 0;
    let nt = 0;
    let A = 0;
    let B = 0;
    let AA = 0;
    let BB = 0;
    let AB = 0;
    for (let k = 0; k < this.n; k += stride) {
      nt++;
      const x = this.qx[k] * sc + ox;
      const y = this.qy[k] * sc + oy;
      if (!(x >= 0 && y >= 0 && x < xm && y < ym)) continue;
      const b = bilinear(d, W, x, y);
      const a = vals[k];
      nv++;
      A += a;
      B += b;
      AA += a * a;
      BB += b * b;
      AB += a * b;
    }
    if (nv < nt * 0.5 || nv < 8) return -2;
    const ma = A / nv;
    const mb = B / nv;
    const va = AA / nv - ma * ma;
    const vb = BB / nv - mb * mb;
    return va > 1e-6 && vb > 1e-6 ? (AB / nv - ma * mb) / Math.sqrt(va * vb) : 0;
  }

  /**
   * 기준 프레임 자기유사성 검사: ROI를 평행이동시킨 위치 중 (자기 자신 근처를 제외하고)
   * 검증을 통과할 만큼 비슷한 곳이 있으면 ambiguous. 반복 패턴(포트·차단기·키패드) 대비.
   * 후보 이동량 = (1) 거친 단계 NCC 지도의 국소 최대 + (2) 호출측이 준 후보(특징 쌍둥이 변위).
   * 후보마다 단계를 내려가며 ±1칸 정밀화 → 기준 단계에서 블록 검증.
   * minShift: 제외할 주 봉우리 반경 (0단계 px).
   */
  scanRepeats(
    refPyr: Pyramid,
    minShift: number,
    crit: AmbiguityCriteria,
    extraShifts: ArrayLike<number> | null = null,
  ): RepeatScanResult {
    const res: RepeatScanResult = { ambiguous: false, shiftX: 0, shiftY: 0, score: -1, peaks: [] };
    const peakList: { s: number; dx: number; dy: number }[] = [];
    const nLev = Math.min(refPyr.length, this.vals.length);
    const lv = Math.min(this.baseLevel, nLev - 1);
    const minSide = Math.min(this.roi.width, this.roi.height);
    // 거친 단계: ROI 짧은 변이 12px 이상 남는 가장 거친 단계 (잔무늬 반복은 특징 쌍둥이 후보가 잡는다)
    let L = Math.floor(Math.log2(Math.max(1, minSide / 12)));
    L = Math.max(lv, Math.min(L, nLev - 1, 3));
    const img = refPyr.levels[L];
    const W = img.width;
    const Hh = img.height;
    const step = 1 << L;
    // 거친 단계에서 ROI 픽셀 수 정도만 샘플
    const areaL = (this.roi.width / step) * (this.roi.height / step);
    const stride = Math.max(1, Math.floor(this.n / Math.max(64, Math.min(256, areaL))));
    const cxl = (this.roi.x + this.roi.width / 2) / step;
    const cyl = (this.roi.y + this.roi.height / 2) / step;
    const dx0 = Math.ceil(-cxl);
    const dx1 = Math.floor(W - 1 - cxl);
    const dy0 = Math.ceil(-cyl);
    const dy1 = Math.floor(Hh - 1 - cyl);
    const mw = dx1 - dx0 + 1;
    const mh = dy1 - dy0 + 1;
    const cands: number[] = []; // (dx, dy) ref px 쌍
    if (mw > 0 && mh > 0) {
      // 샘플별 정수 위치·쌍선형 가중치 (정수 이동이면 소수부가 그대로라 한 번만 계산)
      const ns = Math.ceil(this.n / stride);
      const ix = new Int32Array(ns);
      const iy = new Int32Array(ns);
      const wts = new Float32Array(ns * 4);
      const va = new Float32Array(ns);
      const vals = this.vals[L];
      const sc = 1 / step;
      let m = 0;
      for (let k = 0; k < this.n; k += stride, m++) {
        const x = this.qx[k] * sc;
        const y = this.qy[k] * sc;
        const fx0 = Math.floor(x);
        const fy0 = Math.floor(y);
        const fx = x - fx0;
        const fy = y - fy0;
        ix[m] = fx0;
        iy[m] = fy0;
        wts[m * 4] = (1 - fx) * (1 - fy);
        wts[m * 4 + 1] = fx * (1 - fy);
        wts[m * 4 + 2] = (1 - fx) * fy;
        wts[m * 4 + 3] = fx * fy;
        va[m] = vals[k];
      }
      const map = new Float32Array(mw * mh);
      nccShiftMapKernel(img.data, W, Hh, ix, iy, wts, va, m, dx0, dy0, mw, mh, map);
      const found: { s: number; dx: number; dy: number }[] = [];
      for (let yy = 0; yy < mh; yy++) {
        for (let xx = 0; xx < mw; xx++) {
          const s = map[yy * mw + xx];
          if (s < crit.ncc - 0.2) continue;
          const dx = (xx + dx0) * step;
          const dy = (yy + dy0) * step;
          if (Math.abs(dx) < minShift && Math.abs(dy) < minShift) continue;
          let isMax = true;
          for (let oy = -1; oy <= 1 && isMax; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (!ox && !oy) continue;
              const x2 = xx + ox;
              const y2 = yy + oy;
              if (x2 < 0 || y2 < 0 || x2 >= mw || y2 >= mh) continue;
              if (map[y2 * mw + x2] > s) {
                isMax = false;
                break;
              }
            }
          }
          if (isMax) found.push({ s, dx, dy });
        }
      }
      found.sort((a, b) => b.s - a.s);
      for (let i = 0; i < Math.min(10, found.length); i++) cands.push(found[i].dx, found[i].dy);
    }
    if (extraShifts) {
      for (let i = 0; i + 1 < extraShifts.length && cands.length < 60; i += 2) {
        const dx = extraShifts[i];
        const dy = extraShifts[i + 1];
        if (Math.abs(dx) < minShift && Math.abs(dy) < minShift) continue;
        cands.push(dx, dy);
      }
    }

    const out = emptyVerify();
    const fStride = Math.max(1, Math.floor(this.n / 256));
    for (let c = 0; c + 1 < cands.length; c += 2) {
      // 단계를 내려가며 ±1칸 정밀화 (전역 NCC 기준)
      let bx = cands[c];
      let by = cands[c + 1];
      for (let l = L; l >= lv; l--) {
        const st = 1 << l;
        const im = refPyr.levels[l];
        let bs = this.quickNcc(im, l, bx, by, fStride);
        let nbx = bx;
        let nby = by;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            const s = this.quickNcc(im, l, bx + ox * st, by + oy * st, fStride);
            if (s > bs) {
              bs = s;
              nbx = bx + ox * st;
              nby = by + oy * st;
            }
          }
        }
        bx = nbx;
        by = nby;
      }
      if (Math.abs(bx) < minShift && Math.abs(by) < minShift) continue;
      const T: Mat3 = [1, 0, bx, 0, 1, by, 0, 0, 1];
      this.evaluate(refPyr, T, crit.blockGood, out, [lv, lv]);
      if (out.ncc >= 0.4 && !peakList.some((p) => Math.abs(p.dx - bx) <= 4 && Math.abs(p.dy - by) <= 4)) {
        peakList.push({ s: out.ncc, dx: bx, dy: by });
      }
      if (out.ncc > res.score) {
        res.score = out.ncc;
        res.shiftX = bx;
        res.shiftY = by;
      }
      if (
        out.blocksVisible >= 2 &&
        out.ncc >= crit.ncc &&
        out.fracGood >= crit.fracGood &&
        out.minBlock >= crit.minBlock
      ) {
        res.ambiguous = true;
        res.shiftX = bx;
        res.shiftY = by;
        res.score = out.ncc;
        break;
      }
    }
    peakList.sort((a, b) => b.s - a.s);
    for (const p of peakList.slice(0, 6)) res.peaks.push(p.dx, p.dy);
    return res;
  }

  /**
   * 마지막 evaluate의 (무늬 있고 보이는) 블록 NCC 중 하위 q 분위수 (0~1). 블록이 없으면 NaN.
   * 가장자리·가림으로 한두 블록이 틀려도 흔들리지 않는 '대부분 맞음' 척도.
   */
  blockQuantile(q: number): number {
    const vals: number[] = [];
    for (let b = 0; b < this.nBlocks; b++) {
      const r = this.blockNcc[b];
      if (!Number.isNaN(r)) vals.push(r);
    }
    if (vals.length === 0) return NaN;
    vals.sort((a, b) => a - b);
    return vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
  }

  /** 마지막 evaluate에서 NCC가 thr 미만인 (무늬 있고 보이는) 블록 수 */
  countBadBlocks(thr: number): number {
    let k = 0;
    for (let b = 0; b < this.nBlocks; b++) {
      const r = this.blockNcc[b];
      if (!Number.isNaN(r) && r < thr) k++;
    }
    return k;
  }
}

/**
 * 정수 이동 (dx0..dx0+mw−1, dy0..dy0+mh−1) 마다 전역 NCC. 보이는 샘플이 절반 미만이면 −2.
 * 샘플 k의 위치 = (ix, iy) + 소수부(가중치 wts), 이동은 정수라 가중치 재사용.
 */
function nccShiftMapKernel(
  d: Uint8Array | Uint8ClampedArray,
  W: number,
  Hh: number,
  ix: Int32Array,
  iy: Int32Array,
  wts: Float32Array,
  va: Float32Array,
  ns: number,
  dx0: number,
  dy0: number,
  mw: number,
  mh: number,
  map: Float32Array,
): void {
  for (let yy = 0; yy < mh; yy++) {
    const dy = yy + dy0;
    for (let xx = 0; xx < mw; xx++) {
      const dx = xx + dx0;
      let nv = 0;
      let A = 0;
      let B = 0;
      let AA = 0;
      let BB = 0;
      let AB = 0;
      for (let k = 0; k < ns; k++) {
        const x = ix[k] + dx;
        const y = iy[k] + dy;
        if (x < 0 || y < 0 || x >= W - 1 || y >= Hh - 1) continue;
        const i = y * W + x;
        const o = k * 4;
        const b = wts[o] * d[i] + wts[o + 1] * d[i + 1] + wts[o + 2] * d[i + W] + wts[o + 3] * d[i + W + 1];
        const a = va[k];
        nv++;
        A += a;
        B += b;
        AA += a * a;
        BB += b * b;
        AB += a * b;
      }
      let r = -2;
      if (nv >= ns * 0.5 && nv >= 8) {
        const ma = A / nv;
        const mb = B / nv;
        const v1 = AA / nv - ma * ma;
        const v2 = BB / nv - mb * mb;
        r = v1 > 1e-6 && v2 > 1e-6 ? (AB / nv - ma * mb) / Math.sqrt(v1 * v2) : 0;
      }
      map[yy * mw + xx] = r;
    }
  }
}
