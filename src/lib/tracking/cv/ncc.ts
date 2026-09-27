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
  /** 기준 단계를 강제 (없으면 샘플 간격으로 고름) */
  level?: number;
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
  private sacc = new Float64Array(0);
  private gacc = new Float64Array(0);

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
    m.baseLevel = Math.max(
      0,
      Math.min(refPyr.length - 1, p.level ?? Math.floor(Math.log2(m.spacing)) - 1),
    );
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
   * 국소 최대 검사용: H와, H를 프레임에서 (dx_i, dy_i) px만큼 옮긴 후보들의 전역·블록 NCC를 한 번에.
   * 단계는 H로 한 번 고르고 모든 이동에 같은 단계를 쓴다 (비교가 공정하도록).
   * global[i] = i번째 이동의 전역 NCC (보이는 샘플이 절반 미만이면 −2),
   * blocks[i·nBlocks + b] = 블록 b의 NCC (무늬 없거나 충분히 안 보이면 NaN). 이동 개수를 돌려준다.
   */
  shiftScores(
    cur: Pyramid,
    H: Mat3,
    shifts: ArrayLike<number>,
    global: Float64Array,
    blocks: Float32Array,
  ): number {
    const ns = shifts.length >> 1;
    const [lr, lc] = this.chooseLevels(H, cur.length);
    const img = cur.levels[lc];
    const W = img.width;
    const Hh = img.height;
    const d = img.data;
    const sc = 1 / (1 << lc);
    const vals = this.vals[lr];
    const tex = this.textured[lr];
    const nB = this.nBlocks;
    if (this.sacc.length < ns * nB * 6) this.sacc = new Float64Array(ns * nB * 6);
    if (this.gacc.length < ns * 6) this.gacc = new Float64Array(ns * 6);
    const acc = this.sacc;
    const gacc = this.gacc;
    acc.fill(0, 0, ns * nB * 6);
    gacc.fill(0, 0, ns * 6);
    const xm = W - 1;
    const ym = Hh - 1;
    let nt = 0;
    for (let k = 0; k < this.n; k++) {
      const b = this.blk[k];
      if (!tex[b]) continue;
      nt++;
      const qx = this.qx[k];
      const qy = this.qy[k];
      const w = H[6] * qx + H[7] * qy + H[8];
      if (!(w > 1e-9)) continue;
      const x0 = ((H[0] * qx + H[1] * qy + H[2]) / w) * sc;
      const y0 = ((H[3] * qx + H[4] * qy + H[5]) / w) * sc;
      const a = vals[k];
      for (let i = 0; i < ns; i++) {
        const x = x0 + shifts[2 * i] * sc;
        const y = y0 + shifts[2 * i + 1] * sc;
        if (!(x >= 0 && y >= 0 && x < xm && y < ym)) continue;
        const v = bilinear(d, W, x, y);
        const o = (i * nB + b) * 6;
        acc[o] += 1;
        acc[o + 1] += a;
        acc[o + 2] += v;
        acc[o + 3] += a * a;
        acc[o + 4] += v * v;
        acc[o + 5] += a * v;
        const g = i * 6;
        gacc[g] += 1;
        gacc[g + 1] += a;
        gacc[g + 2] += v;
        gacc[g + 3] += a * a;
        gacc[g + 4] += v * v;
        gacc[g + 5] += a * v;
      }
    }
    for (let i = 0; i < ns; i++) {
      const g = i * 6;
      global[i] = gacc[g] >= Math.max(8, 0.5 * nt) ? nccFromSums(gacc, g) : -2;
      for (let b = 0; b < nB; b++) {
        const o = (i * nB + b) * 6;
        blocks[i * nB + b] =
          tex[b] && acc[o] >= Math.max(4, 0.6 * this.blockSize[b]) ? nccFromSums(acc, o) : NaN;
      }
    }
    return ns;
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
    const stride = Math.max(1, Math.floor(this.n / Math.max(64, Math.min(160, areaL))));
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
      // 샘플별 가장 가까운 픽셀 (거친 지도는 봉우리 후보만 찾는다 — 정밀화는 아래에서 쌍선형으로)
      const ns = Math.ceil(this.n / stride);
      const ix = new Int32Array(ns);
      const iy = new Int32Array(ns);
      const va = new Float32Array(ns);
      const vals = this.vals[L];
      const sc = 1 / step;
      let m = 0;
      for (let k = 0; k < this.n; k += stride, m++) {
        ix[m] = Math.round(this.qx[k] * sc);
        iy[m] = Math.round(this.qy[k] * sc);
        va[m] = vals[k];
      }
      const map = new Float32Array(mw * mh);
      nccShiftMapKernel(img.data, W, Hh, ix, iy, va, m, dx0, dy0, mw, mh, map);
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
    const nMap = cands.length;
    if (extraShifts) {
      // 이미 있는 후보와 거친 단계 한 칸 안이면 정밀화가 같은 봉우리로 가므로 건너뛴다
      const tol = 0.75 * step;
      for (let i = 0; i + 1 < extraShifts.length && cands.length < 48; i += 2) {
        const dx = extraShifts[i];
        const dy = extraShifts[i + 1];
        if (Math.abs(dx) < minShift && Math.abs(dy) < minShift) continue;
        let dup = false;
        for (let j = 0; j + 1 < cands.length && !dup; j += 2) {
          dup = Math.abs(cands[j] - dx) <= tol && Math.abs(cands[j + 1] - dy) <= tol;
        }
        if (!dup) cands.push(dx, dy);
      }
    }

    const out = emptyVerify();
    const fStride = Math.max(1, Math.floor(this.n / 256));
    for (let c = 0; c + 1 < cands.length; c += 2) {
      // 단계를 내려가며 ±1칸 정밀화 (전역 NCC 기준). 특징 쌍둥이 변위는 이미 몇 px 정확도라
      // 거친 단계를 건너뛰고 기준 단계 근처에서만 찾는다 (잔무늬 반복은 거친 단계에서 뭉개지기도 한다).
      let bx = cands[c];
      let by = cands[c + 1];
      const lTop = c < nMap ? L : Math.min(L, lv + 1);
      let bs = -2;
      for (let l = lTop; l >= lv; l--) {
        const st = 1 << l;
        const im = refPyr.levels[l];
        bs = this.quickNcc(im, l, bx, by, fStride);
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
      // 전역 NCC가 봉우리 목록(0.4)·모호 판정(crit.ncc)에 한참 못 미치면 블록 검증은 생략
      if (bs < Math.min(0.4, crit.ncc) - 0.07) continue;
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

/** 누적합 (n, Σa, Σb, Σa², Σb², Σab) → NCC. 한쪽이 평평하면 0 */
function nccFromSums(s: Float64Array, o: number): number {
  const c = s[o];
  const ma = s[o + 1] / c;
  const mb = s[o + 2] / c;
  const va = s[o + 3] / c - ma * ma;
  const vb = s[o + 4] / c - mb * mb;
  const cov = s[o + 5] / c - ma * mb;
  return va > 1e-6 && vb > 1 ? cov / Math.sqrt(va * vb) : 0;
}

/**
 * 정수 이동 (dx0..dx0+mw−1, dy0..dy0+mh−1) 마다 전역 NCC. 보이는 샘플이 절반 미만이면 −2.
 * 샘플 k의 위치 = 가장 가까운 픽셀 (ix, iy) — 봉우리 후보 찾기용 거친 지도.
 */
function nccShiftMapKernel(
  d: Uint8Array | Uint8ClampedArray,
  W: number,
  Hh: number,
  ix: Int32Array,
  iy: Int32Array,
  va: Float32Array,
  ns: number,
  dx0: number,
  dy0: number,
  mw: number,
  mh: number,
  map: Float32Array,
): void {
  // 샘플 경계 상자와 선형 오프셋: 이동 후에도 상자가 영상 안이면 경계 검사 없는 빠른 경로
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  let SA = 0;
  let SAA = 0;
  const off = new Int32Array(ns);
  for (let k = 0; k < ns; k++) {
    bx0 = Math.min(bx0, ix[k]);
    by0 = Math.min(by0, iy[k]);
    bx1 = Math.max(bx1, ix[k]);
    by1 = Math.max(by1, iy[k]);
    off[k] = iy[k] * W + ix[k];
    SA += va[k];
    SAA += va[k] * va[k];
  }
  for (let yy = 0; yy < mh; yy++) {
    const dy = yy + dy0;
    for (let xx = 0; xx < mw; xx++) {
      const dx = xx + dx0;
      // 경계 상자가 절반 넘게 밖이면 보이는 샘플도 절반 미만 (균일 격자) → 계산 없이 −2
      const ox = Math.min(bx1 + dx, W - 1) - Math.max(bx0 + dx, 0) + 1;
      const oy = Math.min(by1 + dy, Hh - 1) - Math.max(by0 + dy, 0) + 1;
      if (ox <= 0 || oy <= 0 || ox * oy < 0.45 * (bx1 - bx0 + 1) * (by1 - by0 + 1)) {
        map[yy * mw + xx] = -2;
        continue;
      }
      if (bx0 + dx >= 0 && by0 + dy >= 0 && bx1 + dx < W && by1 + dy < Hh) {
        const base = dy * W + dx;
        let B = 0;
        let BB = 0;
        let AB = 0;
        for (let k = 0; k < ns; k++) {
          const b = d[off[k] + base];
          B += b;
          BB += b * b;
          AB += va[k] * b;
        }
        let r = -2;
        if (ns >= 8) {
          const ma = SA / ns;
          const mb = B / ns;
          const v1 = SAA / ns - ma * ma;
          const v2 = BB / ns - mb * mb;
          r = v1 > 1e-6 && v2 > 1e-6 ? (AB / ns - ma * mb) / Math.sqrt(v1 * v2) : 0;
        }
        map[yy * mw + xx] = r;
        continue;
      }
      let nv = 0;
      let A = 0;
      let B = 0;
      let AA = 0;
      let BB = 0;
      let AB = 0;
      for (let k = 0; k < ns; k++) {
        const x = ix[k] + dx;
        const y = iy[k] + dy;
        if (x < 0 || y < 0 || x >= W || y >= Hh) continue;
        const b = d[y * W + x];
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
