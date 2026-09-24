import type { Mat3, Rect } from "../types";
import { mul3, rectCorners } from "../geometry";
import { CornerList, detectFast, scoreCorners } from "./fast";
import {
  HomographyRansac,
  canonicalizeH,
  checkHomography,
  countInliers,
  homographyFromQuads,
  hullArea,
  isFiniteH,
  maxCornerDistance,
  refineHomographyLM,
  type RansacParams,
  type SanityLimits,
} from "./homography";
import type { Pyramid } from "./image";
import { PyrLK, type LKParams } from "./lk";
import { Rng } from "./rng";

// 화면 밖 방향 안내(hint) 전용 추측 항법 (dead reckoning).
//
// 앵커가 화면 밖으로 나가면 ROI도 같이 나가 검증된 자세(H)가 없다 → 가장자리 화살표를 낼 근거가 없다.
// 이 모듈은 마지막으로 검증된 H(ref → 그 프레임)에서 출발해, 프레임마다 **보이는 화면 전체**의
// 프레임 간 호모그래피 G(이전 프레임 → 현재 프레임)를 구해 H ← G·H 로 이어 붙인다.
//
//   점: 화면 전체 격자(32px 셀)마다 FAST 코너 하나 (Shi–Tomasi 하한). 추적된 인라이어는 다음 프레임에 이어 쓰고,
//       점이 85% 아래로 줄면 빈 셀을 보충한다 (점이 넉넉하면 1단계에서 싸게, 적으면 0단계에서 촘촘히).
//   G:  피라미드 LK(등속 예측 초기값 — 프레임 간격 비율로 늘이고 줄임, 실패하면 무이동 재시도, 순·역방향 검사)
//       → RANSAC(예측·무이동 후보 먼저) → LM.
//       약한 맞춤(인라이어 < 12 또는 화면의 12% 미만에 몰림)은 닮음 변환(4자유도)으로 줄이고 등속 예측과 맞을 때만 받는다.
//
// 방향 화살표에만 쓴다 — **주석을 그리는 데 쓰면 안 된다** (검증이 없고 조금씩 흐른다).
// 추측하지 않는다: 한 프레임이라도 맞춤이 나쁘면(점 부족·인라이어 비율·잔차·분포·형상·예측과 어긋남) 그 자리에서
// 멈춘다 (빠른 흔들기·모션 블러·무늬 없는 벽). 누적 예산(마지막 검증 후 시간, 화면 중심의 누적 이동량)을 넘어도 멈춘다.
// 다시 시작하려면 새로 검증된 자세가 필요하다 (재검출은 호출측에서 따로 계속 돈다).
// 비용(데스크톱 Node, 320×240, 점 ~50개): step 중앙값 ~1.5ms — 호출측은 앵커가 화면 밖(가장자리)으로 나가 놓쳤을 때만 부른다.
//
// 순수 TS, DOM 없음, 결정적(자체 시드 난수 — 추적기 본체의 난수열을 건드리지 않는다).

export interface DeadReckonParams {
  /** 마지막 검증 자세 이후 이 시간(ms)이 지나면 멈춘다 */
  maxAgeMs: number;
  /** 화면 중심의 누적 이동량이 (프레임 대각선 × 이 값)을 넘으면 멈춘다 (드리프트 누적 예산) */
  maxTravelDiag: number;
  /** 추적 점 최대 개수 */
  maxPoints: number;
  /** 보충 격자 셀 한 변 (px, 셀당 1점) */
  cellSize: number;
  /** 점이 maxPoints × 이 값 미만이면 빈 셀을 보충한다 */
  replenishBelow: number;
  /** 보충: FAST 임계값 (0단계 / 1단계) */
  fastThreshold: number;
  fastThresholdCoarse: number;
  /** 점이 이 수 미만이면 0단계에서 검출 (아니면 1단계 — 4배 싸다) */
  fineBelow: number;
  /** 보충: Shi–Tomasi 최소 고유값 하한 */
  minCornerScore: number;
  /** RANSAC 재투영 허용 오차 (px) */
  ransacThreshold: number;
  /** 프레임 간 맞춤 최소 인라이어 수 */
  minInliers: number;
  /**
   * 인라이어가 minInliers보다 적어도 이 수 이상이고 등속 예측과 맞으면(두 근거가 독립) 받아들인다
   * — 빠르게 돌릴 때(블러) 살아남는 점이 적은 프레임용. 예측이 없으면(첫 프레임 등) 적용하지 않는다.
   */
  minInliersPredicted: number;
  /** 위 경우 예측과의 허용 차이: 프레임 꼭짓점 최대 거리 ≤ max(4px, 예측 이동량 × 이 값) */
  predictedTolFrac: number;
  /** 추적된 점 중 인라이어 비율 하한 */
  minInlierFrac: number;
  /** 인라이어 재투영 RMS 상한 (px) */
  maxRms: number;
  /** 인라이어 볼록껍질 넓이 / 프레임 넓이: 이 미만이면 약한 맞춤 (닮음 변환 + 예측 확인) */
  minSpread: number;
  /** 약한 맞춤이라도 이 미만이면 거부 (한 귀퉁이 점만으로 화면 밖까지 외삽하지 않게) */
  minSpreadWeak: number;
  /** 순방향-역방향 오차 허용 (px) */
  fbThreshold: number;
  lkLevels: number;
  lkWinRadius: number;
  /** LK 창 최소 고유값 */
  lkMinEig: number;
  seed: number;
}

export const DEFAULT_DEAD_RECKON: DeadReckonParams = {
  maxAgeMs: 5000,
  maxTravelDiag: 6,
  maxPoints: 64,
  cellSize: 32,
  replenishBelow: 0.85,
  fastThreshold: 7,
  fastThresholdCoarse: 5,
  fineBelow: 24,
  minCornerScore: 1,
  ransacThreshold: 1.5,
  minInliers: 12,
  minInliersPredicted: 8,
  predictedTolFrac: 0.5,
  minInlierFrac: 0.5,
  maxRms: 0.9,
  minSpread: 0.12,
  minSpreadWeak: 0.03,
  fbThreshold: 2.0,
  lkLevels: 4,
  lkWinRadius: 5,
  lkMinEig: 2,
  seed: 0xd1ec7,
};

/** step이 멈춘 이유 (진단용) */
export type DeadReckonStop =
  | ""
  | "age"
  | "size"
  | "points"
  | "fit"
  | "predicted"
  | "rms"
  | "spread"
  | "shape"
  | "travel"
  | "nan"
  | "external";

/** 프레임 간 G 형상 검사: 한 프레임 사이에 화면이 이 이상 찌그러지거나 커지고 작아지지 않는다 */
const FRAME_SANITY: SanityLimits = {
  minAreaRatio: 0.7,
  maxAreaRatio: 1 / 0.7,
  minAngleDeg: 60,
  maxEdgeRatio: 1.5,
  maxWRatio: 1.5,
};

function applyX(H: Mat3, x: number, y: number): number {
  return (H[0] * x + H[1] * y + H[2]) / (H[6] * x + H[7] * y + H[8]);
}

function applyY(H: Mat3, x: number, y: number): number {
  return (H[3] * x + H[4] * y + H[5]) / (H[6] * x + H[7] * y + H[8]);
}

/**
 * 닮음 변환(회전·등방 배율·이동) 최소제곱 맞춤 (mask 점만). 점이 2개 미만이거나 퇴화하면 null.
 */
export function fitSimilarity(
  sx: Float64Array,
  sy: Float64Array,
  dx: Float64Array,
  dy: Float64Array,
  n: number,
  mask: Uint8Array | null,
): Mat3 | null {
  let k = 0;
  let mx = 0;
  let my = 0;
  let mu = 0;
  let mv = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    mx += sx[i];
    my += sy[i];
    mu += dx[i];
    mv += dy[i];
    k++;
  }
  if (k < 2) return null;
  mx /= k;
  my /= k;
  mu /= k;
  mv /= k;
  let ss = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const x = sx[i] - mx;
    const y = sy[i] - my;
    const u = dx[i] - mu;
    const v = dy[i] - mv;
    ss += x * x + y * y;
    sa += x * u + y * v;
    sb += x * v - y * u;
  }
  if (!(ss > 1e-9)) return null;
  const a = sa / ss;
  const b = sb / ss;
  if (!(a * a + b * b > 1e-12)) return null;
  return [a, -b, mu - a * mx + b * my, b, a, mv - b * mx - a * my, 0, 0, 1];
}

export class DeadReckoner {
  readonly params: DeadReckonParams;
  /** ref → 마지막으로 step한 프레임. 멈췄으면 null */
  private H: Mat3 | null = null;
  private t0 = 0;
  private travel = 0;
  private steps = 0;
  /** 직전 프레임 간 G (등속 예측·RANSAC 첫 후보)와 그 시간 간격(ms) */
  private lastG: Mat3 | null = null;
  private lastDt = 0;
  /** H가 가리키는 프레임의 시각 */
  private tH = 0;
  private stopReason: DeadReckonStop = "";
  /**
   * 마지막 step 진단: 시작 점 수, 순방향 LK 생존, 순·역방향 검사 생존, 인라이어, 인라이어 RMS(px),
   * 인라이어 볼록껍질/프레임 넓이, (약한 맞춤일 때) 등속 예측과의 꼭짓점 최대 거리(px)
   */
  readonly diag = { points: 0, fwd: 0, tracked: 0, inliers: 0, rms: 0, spread: 0, predErr: 0 };

  // 추적 점 (이전 프레임 좌표)
  private n = 0;
  private px: Float64Array;
  private py: Float64Array;
  // 작업 버퍼
  private gx: Float64Array;
  private gy: Float64Array;
  private nx: Float64Array;
  private ny: Float64Array;
  private bx: Float64Array;
  private by: Float64Array;
  private st: Uint8Array;
  private st2: Uint8Array;
  private sX: Float64Array;
  private sY: Float64Array;
  private dX: Float64Array;
  private dY: Float64Array;
  private mask: Uint8Array;
  private occ = new Uint8Array(0);
  private cellBest = new Int32Array(0);
  private raw = new CornerList(1024);
  private cand = new CornerList(128);

  private lk = new PyrLK();
  private ransac = new HomographyRansac();
  private rng: Rng;
  private lkParams: LKParams;
  private lkBack: LKParams;
  private ransacParams: RansacParams;

  constructor(params?: Partial<DeadReckonParams>) {
    this.params = { ...DEFAULT_DEAD_RECKON, ...(params ?? {}) };
    const p = this.params;
    const cap = Math.max(8, p.maxPoints | 0);
    this.px = new Float64Array(cap);
    this.py = new Float64Array(cap);
    this.gx = new Float64Array(cap);
    this.gy = new Float64Array(cap);
    this.nx = new Float64Array(cap);
    this.ny = new Float64Array(cap);
    this.bx = new Float64Array(cap);
    this.by = new Float64Array(cap);
    this.st = new Uint8Array(cap);
    this.st2 = new Uint8Array(cap);
    this.sX = new Float64Array(cap);
    this.sY = new Float64Array(cap);
    this.dX = new Float64Array(cap);
    this.dY = new Float64Array(cap);
    this.mask = new Uint8Array(cap);
    this.rng = new Rng(p.seed);
    this.lkParams = {
      winRadius: p.lkWinRadius,
      maxIters: 10,
      epsilon: 0.03,
      coarseEpsilon: 0.1,
      minEig: p.lkMinEig,
      levels: p.lkLevels,
      maxResidual: 40,
    };
    this.lkBack = { ...this.lkParams, levels: 1, maxResidual: 0, minEig: 0.3 };
    this.ransacParams = { threshold: p.ransacThreshold, maxIters: 120, confidence: 0.995, minIters: 8, loIters: 2 };
  }

  /** 추정 중인가 */
  get active(): boolean {
    return this.H !== null;
  }

  /** 추정 H (ref → 마지막 step 프레임). 멈췄으면 null. 화살표 방향 전용 */
  get pose(): Mat3 | null {
    return this.H ? this.H.slice() : null;
  }

  /** 마지막 멈춤 이유 (진단용, 추정 중이면 "") */
  get lastStop(): DeadReckonStop {
    return this.stopReason;
  }

  /** 시작 후 화면 중심의 누적 이동량 (px) — 드리프트 불확실성의 대용 */
  get travelPx(): number {
    return this.travel;
  }

  /** 시작 후 이어 붙인 프레임 수 */
  get stepCount(): number {
    return this.steps;
  }

  /**
   * 검증된 자세에서 시작. H = ref → (다음 step의 prev 프레임), tVerified = 그 프레임 시각.
   * velocity(선택) = 직전 프레임 간 움직임 (이전 프레임 → 그 프레임), velocityDt = 그 간격(ms) — 첫 step의 LK 초기값.
   */
  start(H: Mat3, tVerified: number, velocity: Mat3 | null = null, velocityDt = 0): void {
    this.rng.reseed(this.params.seed);
    this.H = isFiniteH(H) ? H.slice() : null;
    this.t0 = tVerified;
    this.tH = tVerified;
    this.lastDt = velocityDt;
    this.travel = 0;
    this.steps = 0;
    this.n = 0;
    this.lastG = velocity && isFiniteH(velocity) ? velocity.slice() : null;
    this.stopReason = this.H ? "" : "nan";
  }

  stop(reason: DeadReckonStop = "external"): void {
    if (this.H) this.stopReason = reason;
    this.H = null;
    this.n = 0;
    this.lastG = null;
  }

  /**
   * 이전 프레임 → 현재 프레임 움직임으로 자세를 한 칸 이어 붙인다. 맞춤이 나쁘거나 예산을 넘으면 멈추고 false.
   */
  step(prev: Pyramid, cur: Pyramid, ts: number): boolean {
    if (!this.H) return false;
    const p = this.params;
    if (!(ts - this.t0 <= p.maxAgeMs)) return this.fail("age");
    const W = cur.width;
    const Hh = cur.height;
    if (prev.width !== W || prev.height !== Hh || prev.length < 1 || cur.length < 1) return this.fail("size");

    // 1) 빈 격자 셀 보충 (이전 프레임 0단계)
    if (this.n < p.replenishBelow * p.maxPoints) this.replenish(prev);
    const n = this.n;
    const dg = this.diag;
    dg.points = n;
    dg.fwd = 0;
    dg.tracked = 0;
    dg.inliers = 0;
    dg.rms = 0;
    dg.spread = 0;
    dg.predErr = 0;
    // 등속 예측이 있으면 점이 적은 맞춤도 (예측과 맞을 때만) 받아들인다
    const G0 = this.lastG ? this.predict(this.lastG, ts - this.tH, W, Hh) : null;
    const minInl = G0 ? Math.min(p.minInliers, p.minInliersPredicted) : p.minInliers;
    if (n < minInl) return this.fail("points");

    // 2) LK (등속 예측 → 실패 점은 무이동 재시도) + 순·역방향 검사
    const { px, py, gx, gy, nx, ny, bx, by, st, st2 } = this;
    // LK 초기값 = 등속 예측: 직전 G를 시간 간격 비율만큼 (프레임 간격이 고르지 않다 — 고객 20fps는 33/67ms가 섞임)
    for (let i = 0; i < n; i++) {
      let x = px[i];
      let y = py[i];
      if (G0) {
        const u = applyX(G0, x, y);
        const v = applyY(G0, x, y);
        if (Number.isFinite(u) && Number.isFinite(v)) {
          x = u;
          y = v;
        }
      }
      gx[i] = x;
      gy[i] = y;
      st[i] = 1;
    }
    this.lk.track(prev, cur, n, px, py, gx, gy, nx, ny, st, null, this.lkParams);
    if (G0) {
      let retry = 0;
      for (let i = 0; i < n; i++) {
        st2[i] = st[i] ? 0 : 1;
        retry += st2[i];
      }
      if (retry > 0) {
        this.lk.track(prev, cur, n, px, py, px, py, nx, ny, st2, null, this.lkParams);
        for (let i = 0; i < n; i++) if (st2[i]) st[i] = 1;
      }
    }
    st2.set(st.subarray(0, n));
    let fwd = 0;
    for (let i = 0; i < n; i++) fwd += st[i];
    dg.fwd = fwd;
    this.lk.track(cur, prev, n, nx, ny, px, py, bx, by, st2, null, this.lkBack);
    const fb2 = p.fbThreshold * p.fbThreshold;
    const { sX, sY, dX, dY, mask } = this;
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (!st[i] || !st2[i]) continue;
      const ex = bx[i] - px[i];
      const ey = by[i] - py[i];
      if (ex * ex + ey * ey > fb2) continue;
      sX[m] = px[i];
      sY[m] = py[i];
      dX[m] = nx[i];
      dY[m] = ny[i];
      m++;
    }
    dg.tracked = m;
    if (m < minInl) return this.fail("points");

    // 3) RANSAC (이전 → 현재) + LM
    const hyps: (Mat3 | null)[] = [[1, 0, 0, 0, 1, 0, 0, 0, 1]];
    if (G0) hyps.unshift(G0);
    const res = this.ransac.run(sX, sY, dX, dY, m, this.ransacParams, this.rng, mask, hyps);
    dg.inliers = res.inliers;
    if (!res.H || res.inliers < minInl || res.inliers < p.minInlierFrac * m) return this.fail("fit");
    let G = refineHomographyLM(sX, sY, dX, dY, m, mask, res.H, 5);
    if (!isFiniteH(G)) return this.fail("nan");
    let inl = countInliers(G, sX, sY, dX, dY, m, p.ransacThreshold, mask);
    dg.inliers = inl;
    if (inl < minInl || inl < p.minInlierFrac * m) return this.fail("fit");
    const frame: Rect = { x: 0, y: 0, width: W - 1, height: Hh - 1 };
    const spread = hullArea(dX, dY, m, mask) / (W * Hh);
    dg.spread = spread;
    if (inl < p.minInliers || spread < p.minSpread) {
      // 약한 맞춤(점이 적거나 한쪽에 몰림): 원근 항이 불안정해 화면 밖으로 외삽하면 튄다 → 닮음 변환(4자유도)으로 줄이고,
      // 등속 예측과 맞을 때만 받아들인다 (서로 독립인 두 근거). 예측이 없으면 추측하지 않는다.
      if (!G0 || spread < p.minSpreadWeak) return this.fail(spread < p.minSpread ? "spread" : "fit");
      const S = fitSimilarity(sX, sY, dX, dY, m, mask);
      if (!S) return this.fail("fit");
      G = S;
      inl = countInliers(G, sX, sY, dX, dY, m, p.ransacThreshold, mask);
      dg.inliers = inl;
      if (inl < minInl || inl < p.minInlierFrac * m) return this.fail("fit");
      const cx = (W - 1) / 2;
      const cy = (Hh - 1) / 2;
      const motion = Math.hypot(applyX(G0, cx, cy) - cx, applyY(G0, cx, cy) - cy);
      const dev = maxCornerDistance(G, G0, frame);
      dg.predErr = dev;
      if (dev > Math.max(4, p.predictedTolFrac * motion)) return this.fail("predicted");
    }
    let s2 = 0;
    for (let j = 0; j < m; j++) {
      if (!mask[j]) continue;
      const ex = applyX(G, sX[j], sY[j]) - dX[j];
      const ey = applyY(G, sX[j], sY[j]) - dY[j];
      s2 += ex * ex + ey * ey;
    }
    dg.rms = Math.sqrt(s2 / inl);
    if (!(dg.rms <= p.maxRms)) return this.fail("rms");
    if (!checkHomography(G, frame, FRAME_SANITY).ok) return this.fail("shape");
    G = canonicalizeH(G, W / 2, Hh / 2);

    // 4) 이어 붙이기 + 예산
    const Hn = canonicalizeH(mul3(G, this.H), 0, 0);
    if (!isFiniteH(Hn)) return this.fail("nan");
    const cx = (W - 1) / 2;
    const cy = (Hh - 1) / 2;
    this.travel += Math.hypot(applyX(G, cx, cy) - cx, applyY(G, cx, cy) - cy);
    if (this.travel > p.maxTravelDiag * Math.hypot(W, Hh)) return this.fail("travel");
    this.H = Hn;
    this.lastG = G;
    this.lastDt = ts - this.tH;
    this.tH = ts;
    this.steps++;

    // 5) 인라이어 점을 다음 프레임의 출발점으로
    let k = 0;
    for (let j = 0; j < m; j++) {
      if (!mask[j]) continue;
      px[k] = dX[j];
      py[k] = dY[j];
      k++;
    }
    this.n = k;
    return true;
  }

  /** G(간격 lastDt)를 간격 dt로 늘이거나 줄인 예측 (프레임 네 꼭짓점 외삽, 비율 0~3) */
  private predict(G: Mat3, dt: number, W: number, Hh: number): Mat3 | null {
    let r = this.lastDt > 1e-3 && dt > 0 ? dt / this.lastDt : 1;
    if (r > 3) r = 3;
    if (Math.abs(r - 1) < 1e-6) return G;
    const src = rectCorners({ x: 0, y: 0, width: W - 1, height: Hh - 1 });
    const dst = src.map((c) => {
      const u = applyX(G, c.x, c.y);
      const v = applyY(G, c.x, c.y);
      return { x: c.x + r * (u - c.x), y: c.y + r * (v - c.y) };
    });
    const P = homographyFromQuads(src, dst);
    return P && isFiniteH(P) ? P : null;
  }

  private fail(reason: DeadReckonStop): false {
    this.stop(reason);
    return false;
  }

  /**
   * 점이 없는 격자 셀마다 코너 하나: FAST로 셀마다 점수 최고를 고르고 0단계에서 Shi–Tomasi 하한을 검사한다.
   * 점이 넉넉하면 1단계(1/2)에서 검출해 0단계 좌표로 옮긴다 — 4배 싸고, LK는 창을 추적하므로 코너 위치가 1px 거칠어도 된다.
   */
  private replenish(pyr: Pyramid): void {
    const p = this.params;
    const img = pyr.levels[0];
    const W = img.width;
    const Hh = img.height;
    const cs = Math.max(8, p.cellSize);
    const gw = Math.ceil(W / cs);
    const gh = Math.ceil(Hh / cs);
    const nc = gw * gh;
    if (this.occ.length < nc) {
      this.occ = new Uint8Array(nc);
      this.cellBest = new Int32Array(nc);
    }
    const occ = this.occ;
    occ.fill(0, 0, nc);
    let free = nc;
    for (let i = 0; i < this.n; i++) {
      const c = this.cellOf(this.px[i], this.py[i], cs, gw, gh);
      if (!occ[c]) {
        occ[c] = 1;
        free--;
      }
    }
    if (free <= 0) return;
    const raw = this.raw;
    const cand = this.cand;
    cand.n = 0;
    const border0 = p.lkWinRadius + 4;
    // 점이 적으면(시작·무늬 적은 장면·흐림으로 많이 잃음) 0단계에서 더 촘촘히 — 비싸지만 드물다
    const coarse = pyr.length > 1 && this.n >= p.fineBelow;
    const det = coarse ? pyr.levels[1] : img;
    const sc = coarse ? 2 : 1;
    detectFast(det, coarse ? p.fastThresholdCoarse : p.fastThreshold, Math.ceil(border0 / sc), raw);
    const cb = this.cellBest;
    cb.fill(-1, 0, nc);
    for (let i = 0; i < raw.n; i++) {
      const c = this.cellOf(raw.x[i] * sc, raw.y[i] * sc, cs, gw, gh);
      if (occ[c]) continue;
      if (cb[c] < 0 || raw.score[i] > raw.score[cb[c]]) cb[c] = i;
    }
    const off = coarse ? 0.5 : 0;
    for (let c = 0; c < nc; c++) {
      const i = cb[c];
      if (i < 0) continue;
      const x = Math.round(raw.x[i] * sc + off);
      const y = Math.round(raw.y[i] * sc + off);
      if (x < border0 || y < border0 || x >= W - border0 || y >= Hh - border0) continue;
      cand.push(x, y, 0);
    }
    if (cand.n === 0) return;
    scoreCorners(img, cand, "mineig", 2);
    for (let i = 0; i < cand.n && this.n < p.maxPoints; i++) {
      if (!(cand.score[i] >= p.minCornerScore)) continue;
      this.px[this.n] = cand.x[i];
      this.py[this.n] = cand.y[i];
      this.n++;
    }
  }

  private cellOf(x: number, y: number, cs: number, gw: number, gh: number): number {
    const cx = Math.min(gw - 1, Math.max(0, Math.floor(x / cs)));
    const cy = Math.min(gh - 1, Math.max(0, Math.floor(y / cs)));
    return cy * gw + cx;
  }
}
