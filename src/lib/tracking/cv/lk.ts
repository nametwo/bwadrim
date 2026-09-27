import type { Pyramid } from "./image";

// 피라미드 Lucas–Kanade (Bouguet 2001) + 창 평균 밝기 보정.
// 템플릿(이전 프레임) 창을 쌍선형으로 한 번 뽑고 그 위에서 Scharr 그래디언트를 구한다
// → 프레임마다 그래디언트 영상을 만들 필요가 없다.
// 핫 루프는 작은 커널 함수로 나눠 둔다 (V8이 빨리·안정적으로 최적화하도록).

export interface LKParams {
  /** 창 반지름 r → (2r+1)² 픽셀 */
  winRadius: number;
  /** 단계별 최대 반복 */
  maxIters: number;
  /** 수렴 판정 (단계 픽셀) */
  epsilon: number;
  /** 거친 단계(1 이상)의 수렴 판정 — 다음 단계가 다시 다듬으므로 느슨해도 된다 (없으면 epsilon) */
  coarseEpsilon?: number;
  /** 0단계 최소 고유값 ((그레이/px)², 창 평균). 무늬 없는 창 거부 */
  minEig: number;
  /** 사용할 최대 피라미드 단계 수 */
  levels: number;
  /** 0단계 평균 절대 잔차 상한 (그레이, 밝기 보정 후). 0이면 검사 안 함 */
  maxResidual: number;
}

export const DEFAULT_LK: LKParams = {
  winRadius: 5,
  maxIters: 10,
  epsilon: 0.02,
  minEig: 2,
  levels: 4,
  maxResidual: 40,
};

type Pix = Uint8Array | Uint8ClampedArray;

/**
 * 템플릿 창 샘플링: (x − r − 1, y − r − 1)부터 S×S (S = 2r+3). 벗어나면 false.
 */
function sampleWindow(Id: Pix, w: number, h: number, x: number, y: number, r: number, T: Float32Array): boolean {
  const S = 2 * r + 3;
  const tx = x - r - 1;
  const ty = y - r - 1;
  const itx = Math.floor(tx);
  const ity = Math.floor(ty);
  if (itx < 0 || ity < 0 || itx + S >= w || ity + S >= h) {
    // 창이 가장자리에 걸치면 좌표를 잘라(가장자리 복제) 샘플 — 중심은 영상 안이어야
    if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return false;
    sampleWindowClamped(Id, w, h, tx, ty, S, S, T, S, 0);
    return true;
  }
  const fx = tx - itx;
  const fy = ty - ity;
  const w00 = (1 - fx) * (1 - fy);
  const w01 = fx * (1 - fy);
  const w10 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let jy = 0; jy < S; jy++) {
    let k = (ity + jy) * w + itx;
    const tr = jy * S;
    for (let jx = 0; jx < S; jx++, k++) {
      T[tr + jx] = w00 * Id[k] + w01 * Id[k + 1] + w10 * Id[k + w] + w11 * Id[k + w + 1];
    }
  }
  return true;
}

/** 가장자리 복제 쌍선형 샘플: 좌상단 (x0, y0)부터 nx×ny 격자 → out[off + jy·stride + jx] */
function sampleWindowClamped(
  Id: Pix,
  w: number,
  h: number,
  x0: number,
  y0: number,
  nx: number,
  ny: number,
  out: Float32Array,
  stride: number,
  off: number,
): void {
  const xm = w - 1.000001;
  const ym = h - 1.000001;
  for (let jy = 0; jy < ny; jy++) {
    let y = y0 + jy;
    if (y < 0) y = 0;
    else if (y > ym) y = ym;
    const iy = y | 0;
    const fy = y - iy;
    for (let jx = 0; jx < nx; jx++) {
      let x = x0 + jx;
      if (x < 0) x = 0;
      else if (x > xm) x = xm;
      const ix = x | 0;
      const fx = x - ix;
      const i = iy * w + ix;
      const a = Id[i];
      const b = Id[i + 1];
      const c = Id[i + w];
      const d = Id[i + w + 1];
      out[off + jy * stride + jx] = a + fx * (b - a) + fy * (c - a + fx * (a - b - c + d));
    }
  }
}

/**
 * 템플릿 창 Scharr 그래디언트 (3,10,3)/32 → GX, GY (D×D).
 * acc = [g11, g12, g22, ΣIx, ΣIy]
 */
function windowGradients(T: Float32Array, r: number, GX: Float32Array, GY: Float32Array, acc: Float64Array): void {
  const S = 2 * r + 3;
  const D = 2 * r + 1;
  let g11 = 0;
  let g12 = 0;
  let g22 = 0;
  let sIx = 0;
  let sIy = 0;
  for (let jy = 0; jy < D; jy++) {
    const r0 = jy * S;
    const r1 = r0 + S;
    const r2 = r1 + S;
    const gr = jy * D;
    for (let jx = 0; jx < D; jx++) {
      const a = r0 + jx;
      const b = r1 + jx;
      const c = r2 + jx;
      const ix = (3 * (T[a + 2] - T[a]) + 10 * (T[b + 2] - T[b]) + 3 * (T[c + 2] - T[c])) * 0.03125;
      const iy = (3 * (T[c] - T[a]) + 10 * (T[c + 1] - T[a + 1]) + 3 * (T[c + 2] - T[a + 2])) * 0.03125;
      GX[gr + jx] = ix;
      GY[gr + jx] = iy;
      g11 += ix * ix;
      g12 += ix * iy;
      g22 += iy * iy;
      sIx += ix;
      sIy += iy;
    }
  }
  acc[0] = g11;
  acc[1] = g12;
  acc[2] = g22;
  acc[3] = sIx;
  acc[4] = sIy;
}

/**
 * 한 단계 LK 반복. d = [dx, dy] (단계 좌표 변위, 입출력).
 * 창이 벗어나면 false. 마지막 반복의 창 평균 차를 d[2]에 남긴다.
 */
function iterateLevel(
  Jd: Pix,
  w: number,
  h: number,
  x: number,
  y: number,
  r: number,
  T: Float32Array,
  GX: Float32Array,
  GY: Float32Array,
  acc: Float64Array,
  maxIters: number,
  eps2: number,
  d: Float64Array,
  Jw: Float32Array,
): boolean {
  const S = 2 * r + 3;
  const D = 2 * r + 1;
  const npx = D * D;
  const g11 = acc[0];
  const g12 = acc[1];
  const g22 = acc[2];
  const sIx = acc[3];
  const sIy = acc[4];
  const idet = 1 / (g11 * g22 - g12 * g12);
  let dx = d[0];
  let dy = d[1];
  let m = 0;
  for (let it = 0; it < maxIters; it++) {
    const qx = x + dx - r;
    const qy = y + dy - r;
    const iqx = Math.floor(qx);
    const iqy = Math.floor(qy);
    if (iqx < 0 || iqy < 0 || iqx + D >= w || iqy + D >= h) {
      // 가장자리: 중심이 영상 안이면 복제 샘플로 계속, 밖이면 실패
      const cx = x + dx;
      const cy = y + dy;
      if (!(cx >= 0 && cy >= 0 && cx <= w - 1 && cy <= h - 1)) {
        d[0] = dx;
        d[1] = dy;
        return false;
      }
      sampleWindowClamped(Jd, w, h, qx, qy, D, D, Jw, D, 0);
      let b1 = 0;
      let b2 = 0;
      let sd = 0;
      for (let jy = 0; jy < D; jy++) {
        const tr = (jy + 1) * S + 1;
        const gr = jy * D;
        for (let jx = 0; jx < D; jx++) {
          const diff = T[tr + jx] - Jw[gr + jx];
          b1 += diff * GX[gr + jx];
          b2 += diff * GY[gr + jx];
          sd += diff;
        }
      }
      m = sd / npx;
      b1 -= m * sIx;
      b2 -= m * sIy;
      const ddx = (g22 * b1 - g12 * b2) * idet;
      const ddy = (g11 * b2 - g12 * b1) * idet;
      dx += ddx;
      dy += ddy;
      if (ddx * ddx + ddy * ddy < eps2) break;
      continue;
    }
    const ax = qx - iqx;
    const ay = qy - iqy;
    const v00 = (1 - ax) * (1 - ay);
    const v01 = ax * (1 - ay);
    const v10 = (1 - ax) * ay;
    const v11 = ax * ay;
    let b1 = 0;
    let b2 = 0;
    let sd = 0;
    for (let jy = 0; jy < D; jy++) {
      let k = (iqy + jy) * w + iqx;
      const tr = (jy + 1) * S + 1;
      const gr = jy * D;
      for (let jx = 0; jx < D; jx++, k++) {
        const jv = v00 * Jd[k] + v01 * Jd[k + 1] + v10 * Jd[k + w] + v11 * Jd[k + w + 1];
        const diff = T[tr + jx] - jv;
        b1 += diff * GX[gr + jx];
        b2 += diff * GY[gr + jx];
        sd += diff;
      }
    }
    // 창 평균 밝기 차 보정
    m = sd / npx;
    b1 -= m * sIx;
    b2 -= m * sIy;
    const ddx = (g22 * b1 - g12 * b2) * idet;
    const ddy = (g11 * b2 - g12 * b1) * idet;
    dx += ddx;
    dy += ddy;
    if (ddx * ddx + ddy * ddy < eps2) break;
  }
  d[0] = dx;
  d[1] = dy;
  d[2] = m;
  return true;
}

/** 최종 위치의 밝기 보정 평균 절대 잔차. 창이 벗어나면 Infinity */
function residualAt(
  Jd: Pix,
  w: number,
  h: number,
  x: number,
  y: number,
  r: number,
  T: Float32Array,
  m: number,
): number {
  const S = 2 * r + 3;
  const D = 2 * r + 1;
  const qx = x - r;
  const qy = y - r;
  const iqx = Math.floor(qx);
  const iqy = Math.floor(qy);
  if (iqx < 0 || iqy < 0 || iqx + D >= w || iqy + D >= h) {
    if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return Infinity;
    // 가장자리: 창 안쪽(영상 안) 픽셀만으로 잔차
    let sad = 0;
    let cnt = 0;
    for (let jy = 0; jy < D; jy++) {
      const yy = qy + jy;
      if (yy < 0 || yy > h - 1.000001) continue;
      for (let jx = 0; jx < D; jx++) {
        const xx = qx + jx;
        if (xx < 0 || xx > w - 1.000001) continue;
        const ix = xx | 0;
        const iy = yy | 0;
        const fx = xx - ix;
        const fy = yy - iy;
        const i = iy * w + ix;
        const a = Jd[i];
        const b = Jd[i + 1];
        const c = Jd[i + w];
        const dd = Jd[i + w + 1];
        const jv = a + fx * (b - a) + fy * (c - a + fx * (a - b - c + dd));
        const e = T[(jy + 1) * S + jx + 1] - jv - m;
        sad += e < 0 ? -e : e;
        cnt++;
      }
    }
    return cnt >= (D * D) / 4 ? sad / cnt : Infinity;
  }
  const ax = qx - iqx;
  const ay = qy - iqy;
  const v00 = (1 - ax) * (1 - ay);
  const v01 = ax * (1 - ay);
  const v10 = (1 - ax) * ay;
  const v11 = ax * ay;
  let sad = 0;
  for (let jy = 0; jy < D; jy++) {
    let k = (iqy + jy) * w + iqx;
    const tr = (jy + 1) * S + 1;
    for (let jx = 0; jx < D; jx++, k++) {
      const jv = v00 * Jd[k] + v01 * Jd[k + 1] + v10 * Jd[k + w] + v11 * Jd[k + w + 1];
      const e = T[tr + jx] - jv - m;
      sad += e < 0 ? -e : e;
    }
  }
  return sad / (D * D);
}

export class PyrLK {
  private T = new Float32Array(0);
  private GX = new Float32Array(0);
  private GY = new Float32Array(0);
  private Jw = new Float32Array(0);
  private acc = new Float64Array(5);
  private d = new Float64Array(3);
  private r = -1;

  private ensure(r: number): void {
    if (this.r === r) return;
    const S = 2 * r + 3;
    const D = 2 * r + 1;
    this.T = new Float32Array(S * S);
    this.GX = new Float32Array(D * D);
    this.GY = new Float32Array(D * D);
    this.Jw = new Float32Array(D * D);
    this.r = r;
  }

  /**
   * prev의 (px, py)를 next에서 찾는다. 초기 추정 (gx, gy) (0단계 좌표).
   * status: 입력 0이면 건너뜀, 출력 1 = 성공. err가 있으면 0단계 잔차를 쓴다.
   * 두 피라미드의 단계별 크기는 같아야 한다. 성공한 점 수를 돌려준다.
   */
  track(
    prev: Pyramid,
    next: Pyramid,
    n: number,
    px: Float64Array,
    py: Float64Array,
    gx: Float64Array,
    gy: Float64Array,
    outX: Float64Array,
    outY: Float64Array,
    status: Uint8Array,
    err: Float32Array | null,
    p: LKParams,
  ): number {
    this.ensure(p.winRadius);
    const L = Math.max(1, Math.min(p.levels, prev.length, next.length));
    let good = 0;
    for (let i = 0; i < n; i++) {
      if (!status[i]) continue;
      const e = this.trackPoint(prev, next, L, px[i], py[i], gx[i], gy[i], p);
      const ok = e >= 0;
      if (ok) {
        outX[i] = px[i] + this.d[0];
        outY[i] = py[i] + this.d[1];
        good++;
      }
      status[i] = ok ? 1 : 0;
      if (err) err[i] = ok ? e : Infinity;
    }
    return good;
  }

  /** 점 하나. 성공하면 잔차(≥ 0), 실패하면 −1. 변위는 this.d[0..1] (0단계) */
  private trackPoint(
    prev: Pyramid,
    next: Pyramid,
    L: number,
    x0: number,
    y0: number,
    gx: number,
    gy: number,
    p: LKParams,
  ): number {
    const r = p.winRadius;
    const T = this.T;
    const GX = this.GX;
    const GY = this.GY;
    const acc = this.acc;
    const d = this.d;
    const npx = (2 * r + 1) * (2 * r + 1);
    const eps2 = p.epsilon * p.epsilon;
    const ce = p.coarseEpsilon ?? p.epsilon;
    const ceps2 = ce * ce;
    const top = 1 / (1 << (L - 1));
    d[0] = (gx - x0) * top;
    d[1] = (gy - y0) * top;
    d[2] = 0;
    for (let l = L - 1; l >= 0; l--) {
      const I = prev.levels[l];
      const J = next.levels[l];
      const w = I.width;
      const h = I.height;
      const sc = 1 / (1 << l);
      const x = x0 * sc;
      const y = y0 * sc;
      let ok = sampleWindow(I.data, w, h, x, y, r, T);
      if (ok) {
        windowGradients(T, r, GX, GY, acc);
        const half = (acc[0] - acc[2]) * 0.5;
        const minEig = ((acc[0] + acc[2]) * 0.5 - Math.sqrt(half * half + acc[1] * acc[1])) / npx;
        const det = acc[0] * acc[2] - acc[1] * acc[1];
        const thr = l === 0 ? p.minEig : p.minEig * 0.1;
        ok = minEig >= thr && det > 1e-9;
      }
      if (ok) ok = iterateLevel(J.data, w, h, x, y, r, T, GX, GY, acc, p.maxIters, l === 0 ? eps2 : ceps2, d, this.Jw);
      if (l === 0) {
        if (!ok) return -1;
        let res = 0;
        if (p.maxResidual > 0) {
          res = residualAt(J.data, w, h, x + d[0], y + d[1], r, T, d[2]);
          if (!(res <= p.maxResidual)) return -1;
        }
        const ox = x0 + d[0];
        const oy = y0 + d[1];
        if (!(ox >= 0 && oy >= 0 && ox <= w - 1 && oy <= h - 1)) return -1;
        return res;
      }
      // 거친 단계에서 창이 벗어나거나 무늬가 없으면 그 단계는 건너뛰고 추정만 넘긴다
      d[0] *= 2;
      d[1] *= 2;
    }
    return -1;
  }
}
