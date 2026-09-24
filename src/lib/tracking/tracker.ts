import type {
  GrayImage,
  Mat3,
  PlanarTrackerApi,
  Rect,
  ReferenceInfo,
  TrackerConfig,
  TrackResult,
  TrackState,
  TrackTimings,
} from "./types";
import { clampRect, localScale, mul3, rectCorners, warpRect } from "./geometry";
import { Aligner, DEFAULT_ALIGN, buildAlignTemplate, type AlignParams, type AlignTemplate } from "./cv/align";
import { CornerList, detectFast, minDistanceFilter, scoreCorners } from "./cv/fast";
import {
  HomographyRansac,
  checkHomography,
  countInliers,
  homographyFromQuads,
  hullArea,
  isFiniteH,
  maxCornerDistance,
  refineHomographyLM,
  type RansacParams,
  type SanityLimits,
} from "./cv/homography";
import { Pyramid, ensureImage, isValidImage, warpPerspective } from "./cv/image";
import { PyrLK, type LKParams } from "./cv/lk";
import { HammingMatcher, MatchList, minDistanceOutside, type MatchParams } from "./cv/match";
import { VerifyModel, emptyVerify, type AmbiguityCriteria, type VerifyResult } from "./cv/ncc";
import { OrbExtractor, OrbFeatures, ScalePyramid, type OrbParams } from "./cv/orb";
import { Rng } from "./cv/rng";

// 평면 앵커 추적기 (README "파이프라인" 참고).
//
//  setReference
//    피라미드 → ROI ORB(+기준 프레임 전체 ORB로 '쌍둥이' = 반복 무늬 특징 판별) → ROI 자기유사성 검사
//    → 특징·LK 코너가 모자라거나 모호(옆 복제본과 구별 불가)하면 ROI를 1.5배씩 넓힘(최대 전체 화면)
//    → LK 점 풀, 정렬 템플릿(단계별), 광도 검증 격자(블록 NCC), 반복 이동량 목록.
//    trackable = 특징 충분 + 핀 주변(요청 ROI, 최소 80×80)에 코너가 있을 것.
//    (핀 자체에 무늬가 없으면 넓힌 ROI가 다른 평면일 때 시차만큼 틀린 곳을 가리키므로 추적하지 않는다.)
//
//  process
//    tracking/weak — LK(등속 예측 초기값, 실패 점은 무이동 재시도, 순·역방향 검사)
//                    → RANSAC(ref↔현재 좌표, 체인 누적 없음) + LM → 기준 템플릿 직접 정렬(IC, 드리프트 제거)
//                    → 형상·시간(점프)·광도 검증. 아웃라이어끼리 따로 맞는 H(한 주기 미끄러짐 등)가 있으면
//                      둘 다 검증해 나은 쪽. 넓힌 ROI면 핀 주변 블록도 맞아야 표시.
//                    → 인라이어 점 스냅·풀에서 보충. 실패하거나 약하면(또는 주기적으로) 같은 프레임에서 재검출.
//    searching/lost — ORB 매칭(고유 특징만, 비율·상호) → RANSAC → LM → 정렬(거친→고운)
//                    → 엄격 검증(블록 NCC, 반복 이동량만큼 옮긴 후보보다 확실히 나을 것) → tracking
//    앵커(요청 ROI 중심 = 핀)가 화면 밖이면 내부 추적은 계속하되 'lost'로 알린다 (H = null).
//
// 틀린 곳을 가리키느니 놓치는 쪽을 택한다: 내보내는 모든 H는 광도 검증(블록 NCC)을 통과한 것이다.

/** 확장 설정 (TrackerConfig + 세부 조정값). 모든 값에 기본값이 있다 */
export interface PlanarTrackerOptions extends TrackerConfig {
  // ── 기준 ──
  /** 이 특징 수 미만이면 trackable = false */
  minReferenceFeatures: number;
  /**
   * 핀 주변(요청 ROI, 최소 80×80) 코너 밀도 하한 (개/px²). 핀 자체에 무늬가 없으면
   * 핀 위치를 확인할 방법이 없다 (넓힌 ROI가 다른 평면이면 시차만큼 틀린 곳을 가리킨다) → 추적 불가.
   */
  minPinCornerDensity: number;
  /** 핀 주변 코너 수 절대 하한 */
  minPinCorners: number;
  /** ROI 특징이 이보다 적으면 ROI를 넓힌다 */
  targetReferenceFeatures: number;
  /** ROI 확장 배율 (한 번에) */
  roiExpandFactor: number;
  /** ROI 최소 한 변 (px) */
  minRoiSize: number;
  /** 특징 검출 시 ROI 바깥 여유 (px) */
  roiMargin: number;
  /** 기준 ROI 자기유사성(반복 패턴) 검사 */
  checkRepeats: boolean;
  /** 기준 프레임 안에서 이 해밍 거리 이하 '쌍둥이'가 있는 특징은 재검출에 안 쓴다 */
  twinDistance: number;
  // ── ORB·매칭 ──
  orbLevels: number;
  /** 현재 프레임 ORB 개수 */
  orbFeatures: number;
  fastThreshold: number;
  minFastThreshold: number;
  matchMaxDistance: number;
  matchRatio: number;
  // ── 재검출 ──
  detectRansacThreshold: number;
  detectMaxIters: number;
  minDetectInliers: number;
  /** 인라이어 볼록껍질 / 고유 특징 볼록껍질 하한 */
  minDetectSpread: number;
  /** 추적 중 주기적 재검출 간격 (프레임, 0 = 끔) */
  reanchorInterval: number;
  // ── LK ──
  lkWinRadius: number;
  lkMaxIters: number;
  lkMinEig: number;
  lkMaxResidual: number;
  /** 순방향-역방향 오차 허용 (px) */
  fbThreshold: number;
  /** 역방향 검사에 쓸 피라미드 단계 수 (초기값이 곧 정답 위치라 거친 단계가 필요 없다) */
  fbLevels: number;
  /** 추적 점 수가 max × 이 값 미만이면 보충 */
  replenishBelow: number;
  /** 추적 점 사이 최소 간격 (px) */
  minPointDistance: number;
  /** 인라이어 점을 H(ref)로 스냅해 LK 누적 오차 제거 */
  snapPoints: boolean;
  /** 등속 예측 감쇠 (0 = 예측 안 함) */
  motionDamping: number;
  // ── 정렬 ──
  alignEnabled: boolean;
  alignSamples: number;
  /** 정렬이 LK 추정에서 이보다 멀리 가면(px) 정렬 결과를 버린다 */
  alignMaxShift: number;
  // ── 검증 ──
  /** 블록 NCC가 이 이상이면 '맞는 블록' */
  blockGood: number;
  nccDetect: number;
  fracDetect: number;
  /** 재검출: 블록 NCC가 이 값 미만이면 '틀린 블록' */
  minBlockDetect: number;
  /** 재검출: ORB 근거가 강할 때 봐주는 틀린 블록 비율 */
  maxBadBlockFrac: number;
  /** 재검출: 반복 이동량으로 옮긴 후보보다 (ncc + fracGood)가 이만큼은 높아야 */
  repeatMargin: number;
  /** 넓힌 ROI일 때 핀 주변 무늬 블록 최소 NCC: 이 미만이면 표시 안 함 / 이 이상이어야 tracking */
  innerWeak: number;
  innerStrong: number;
  nccTrack: number;
  fracTrack: number;
  nccWeak: number;
  fracWeak: number;
  /** 추적 중 예측 대비 허용 점프 (px, ROI 대각선 비율과 큰 쪽) */
  maxJumpPx: number;
  maxJumpFrac: number;
}

export const DEFAULT_TRACKER_CONFIG: PlanarTrackerOptions = {
  pyramidLevels: 4,
  maxTrackedPoints: 100,
  maxReferenceFeatures: 400,
  ransacThreshold: 2.5,
  minInliers: 15,
  minWeakInliers: 8,
  seed: 0x5eed,

  minReferenceFeatures: 20,
  minPinCornerDensity: 0.0007,
  minPinCorners: 5,
  targetReferenceFeatures: 40,
  roiExpandFactor: 1.5,
  minRoiSize: 48,
  roiMargin: 6,
  checkRepeats: true,
  twinDistance: 25,

  orbLevels: 5,
  orbFeatures: 500,
  fastThreshold: 18,
  minFastThreshold: 7,
  matchMaxDistance: 64,
  matchRatio: 0.8,

  detectRansacThreshold: 4.5,
  detectMaxIters: 1500,
  minDetectInliers: 10,
  minDetectSpread: 0.12,
  reanchorInterval: 45,

  lkWinRadius: 5,
  lkMaxIters: 10,
  lkMinEig: 2,
  lkMaxResidual: 40,
  fbThreshold: 1.0,
  fbLevels: 2,
  replenishBelow: 0.7,
  minPointDistance: 6,
  snapPoints: true,
  motionDamping: 0.8,

  alignEnabled: true,
  alignSamples: 600,
  alignMaxShift: 8,

  blockGood: 0.5,
  nccDetect: 0.6,
  fracDetect: 0.8,
  minBlockDetect: 0.25,
  maxBadBlockFrac: 0.1,
  repeatMargin: 0.05,
  innerWeak: 0.5,
  innerStrong: 0.75,
  nccTrack: 0.5,
  fracTrack: 0.6,
  nccWeak: 0.3,
  fracWeak: 0.35,
  maxJumpPx: 40,
  maxJumpFrac: 0.6,
};

/** 기준 프레임에서 만든 모든 것 */
interface RefModel {
  width: number;
  height: number;
  roi: Rect;
  /** 요청 ROI 중심 (= 엔지니어가 탭한 곳, 핀 위치의 대리값). 화면 밖이면 표시하지 않는다 */
  anchor: { x: number; y: number };
  pyr: Pyramid;
  /** ROI 안 ORB 특징 (재검출용) */
  feats: OrbFeatures;
  /** 쌍둥이 없는(고유한) 특징 인덱스 */
  uniqueIdx: Int32Array;
  nUnique: number;
  /** 고유 특징 위치의 볼록껍질 넓이 */
  uniqueHull: number;
  /** LK 점 풀 (ref 좌표, 점수 내림차순) */
  poolX: Float64Array;
  poolY: Float64Array;
  nPool: number;
  /** 정렬 템플릿 (ref 피라미드 단계별) */
  templates: (AlignTemplate | null)[];
  verify: VerifyModel;
  /**
   * ROI를 넓혔을 때만: 요청 ROI(핀 주변) 검증기. 넓힌 ROI의 무늬가 다른 평면(배경)이면
   * 넓은 검증은 통과해도 핀 주변은 어긋난다(시차) → 핀 주변이 직접 맞아야 표시한다.
   */
  inner: VerifyModel | null;
  /** inner가 무늬 없는 영역이라 핀 위치를 직접 확인할 수 없음 → 최대 weak */
  innerBlind: boolean;
  /** 자기유사성 검사를 통과했는가 (false면 재검출 금지) */
  distinctive: boolean;
  /** 핀 주변 코너 수 (진단용) */
  pinCorners: number;
  /** 기준 ROI와 닮은 이동량들 (ref px, dx·dy 쌍) — 재검출 결과가 옆 복제본보다 확실히 나은지 비교 */
  repeatShifts: number[];
  trackable: boolean;
}

/** 프레임 1장 처리 결과 (내부) */
interface Outcome {
  ok: boolean;
  strong: boolean;
  H: Mat3 | null;
  inliers: number;
  tracked: number;
  redetected: boolean;
  conf: number;
  ncc: number;
  fromDetect: boolean;
  /** 재검출로 보강할 필요가 있는가 (인라이어 부족 등) */
  wantReanchor: boolean;
}

/** 진단 이벤트 (onDebug를 설정했을 때만 만든다) */
export interface TrackerDebugEvent {
  kind: "detect" | "track";
  /** 통과했으면 "ok", 아니면 탈락 이유 */
  result: string;
  /** 매칭 수 (detect) 또는 LK 생존 점 수 (track) */
  matches: number;
  inliers: number;
  spread?: number;
  hypotheses?: number;
  verify?: VerifyResult;
  /** 핀 주변(요청 ROI) 검증 — ROI를 넓혔을 때만 */
  inner?: VerifyResult;
}

/** 추적 가설 평가 결과 */
interface HypEval {
  H: Mat3;
  aligned: boolean;
  v: VerifyResult;
  inliers: number;
  score: number;
}

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/** 기본값에 덮어쓰기. 타입이 기본값과 다르거나 유한수가 아니면 무시 */
function mergeConfig(
  config: Partial<PlanarTrackerOptions> | Partial<TrackerConfig> | undefined,
): PlanarTrackerOptions {
  const out: PlanarTrackerOptions = { ...DEFAULT_TRACKER_CONFIG };
  if (!config) return out;
  const dst = out as Record<string, number | boolean>;
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined) continue;
    const d = dst[k];
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    if (d !== undefined && typeof d !== typeof v) continue;
    if (typeof v === "number" || typeof v === "boolean") dst[k] = v;
  }
  return out;
}

/**
 * 쌍둥이 특징의 변위(쌍둥이 위치 − 자기 위치)를 4px 격자로 모아 표가 많은 순으로 (dx, dy, …).
 * 반복 패턴이면 같은 주기 변위에 표가 몰린다 → 자기유사성 검사 후보.
 */
function twinShifts(
  feats: OrbFeatures,
  all: OrbFeatures,
  twin: Uint16Array,
  twinIdx: Int32Array,
  maxDist: number,
): number[] {
  const votes = new Map<number, { n: number; sx: number; sy: number }>();
  for (let i = 0; i < feats.n; i++) {
    const j = twinIdx[i];
    if (j < 0 || twin[i] > maxDist) continue;
    const dx = all.x[j] - feats.x[i];
    const dy = all.y[j] - feats.y[i];
    const key = Math.round(dx / 4) * 4096 + Math.round(dy / 4);
    const v = votes.get(key);
    if (v) {
      v.n++;
      v.sx += dx;
      v.sy += dy;
    } else {
      votes.set(key, { n: 1, sx: dx, sy: dy });
    }
  }
  const list = [...votes.values()].sort((a, b) => b.n - a.n || a.sx - b.sx || a.sy - b.sy);
  const out: number[] = [];
  for (const v of list.slice(0, 24)) out.push(Math.round(v.sx / v.n), Math.round(v.sy / v.n));
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isIdentityish(H: Mat3): boolean {
  const s = H[8];
  if (Math.abs(s) < 1e-12) return false;
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i++) if (Math.abs(H[i] / s - I[i]) > 1e-9) return false;
  return true;
}

export class PlanarTracker implements PlanarTrackerApi {
  readonly config: PlanarTrackerOptions;
  /** 진단용 콜백 (기본 없음). 벤치·실험에서 탈락 이유를 보려고 쓴다 */
  onDebug: ((ev: TrackerDebugEvent) => void) | null = null;
  private lastInner: VerifyResult | null = null;
  private rng: Rng;
  private ref: RefModel | null = null;
  private state: TrackState = "lost";
  private everLocked = false;
  private pendingInitH: Mat3 | null = null;

  // 프레임
  private pyrA = new Pyramid();
  private pyrB = new Pyramid();
  private prevPyr: Pyramid | null = null;
  private prevValid = false;
  private fw = 0;
  private fh = 0;
  private synth: GrayImage | null = null;
  private curScale = new ScalePyramid();
  private curFeat = new OrbFeatures(1024);

  // 자세 이력
  private H: Mat3 | null = null;
  private tLast = 0;
  private Hprev: Mat3 | null = null;
  private tPrev = 0;
  private strongStreak = 0;
  private framesSinceDetect = 0;

  // 추적 점 (capacity = maxTrackedPoints)
  private nPts = 0;
  private refX: Float64Array;
  private refY: Float64Array;
  private ptX: Float64Array;
  private ptY: Float64Array;
  private poolOf: Int32Array;
  private inUse = new Uint8Array(0);
  // LK 작업 버퍼
  private gX: Float64Array;
  private gY: Float64Array;
  private nX: Float64Array;
  private nY: Float64Array;
  private bX: Float64Array;
  private bY: Float64Array;
  private st: Uint8Array;
  private st2: Uint8Array;
  private lkErr: Float32Array;
  // 대응 버퍼
  private cSx = new Float64Array(0);
  private cSy = new Float64Array(0);
  private cDx = new Float64Array(0);
  private cDy = new Float64Array(0);
  private cIdx = new Int32Array(0);
  private cMask = new Uint8Array(0);
  private occ = new Int32Array(0);
  // 두 번째 가설용 버퍼
  private oSx = new Float64Array(0);
  private oSy = new Float64Array(0);
  private oDx = new Float64Array(0);
  private oDy = new Float64Array(0);
  private oMask = new Uint8Array(0);

  // 모듈
  private lk = new PyrLK();
  private aligner = new Aligner();
  private ransac = new HomographyRansac();
  private matcher = new HammingMatcher();
  private matches = new MatchList();
  private orb = new OrbExtractor();
  private vres: VerifyResult = emptyVerify();

  private lkParams: LKParams;
  private lkBackParams: LKParams;
  private alignParams: AlignParams;
  private trackRansac: RansacParams;
  private detectRansac: RansacParams;
  private sanity: SanityLimits;
  private matchParams: MatchParams;
  private orbParams: OrbParams;

  constructor(config?: Partial<PlanarTrackerOptions> | Partial<TrackerConfig>) {
    this.config = mergeConfig(config);
    const c = this.config;
    this.rng = new Rng(c.seed);
    const cap = Math.max(8, c.maxTrackedPoints | 0);
    this.refX = new Float64Array(cap);
    this.refY = new Float64Array(cap);
    this.ptX = new Float64Array(cap);
    this.ptY = new Float64Array(cap);
    this.poolOf = new Int32Array(cap);
    this.gX = new Float64Array(cap);
    this.gY = new Float64Array(cap);
    this.nX = new Float64Array(cap);
    this.nY = new Float64Array(cap);
    this.bX = new Float64Array(cap);
    this.bY = new Float64Array(cap);
    this.st = new Uint8Array(cap);
    this.st2 = new Uint8Array(cap);
    this.lkErr = new Float32Array(cap);
    this.ensureCorr(Math.max(cap, c.maxReferenceFeatures));

    this.lkParams = {
      winRadius: c.lkWinRadius,
      maxIters: c.lkMaxIters,
      epsilon: 0.02,
      minEig: c.lkMinEig,
      levels: c.pyramidLevels,
      maxResidual: c.lkMaxResidual,
    };
    this.lkBackParams = { ...this.lkParams, maxResidual: 0, levels: Math.max(1, Math.min(c.fbLevels, c.pyramidLevels)) };
    this.alignParams = { ...DEFAULT_ALIGN };
    this.trackRansac = {
      threshold: c.ransacThreshold,
      maxIters: 200,
      confidence: 0.995,
      minIters: 8,
      loIters: 2,
    };
    this.detectRansac = {
      threshold: c.detectRansacThreshold,
      maxIters: c.detectMaxIters,
      confidence: 0.995,
      minIters: 30,
      loIters: 3,
    };
    this.sanity = {
      minAreaRatio: 1 / 16,
      maxAreaRatio: 16,
      minAngleDeg: 25,
      maxEdgeRatio: 6,
      maxWRatio: 3,
    };
    this.matchParams = { maxDistance: c.matchMaxDistance, ratio: c.matchRatio, mutual: true };
    this.orbParams = {
      nFeatures: c.orbFeatures,
      nLevels: c.orbLevels,
      fastThreshold: c.fastThreshold,
      minFastThreshold: c.minFastThreshold,
      cellSize: 24,
    };
  }

  // ───────────────────────── 공개 API ─────────────────────────

  hasReference(): boolean {
    return this.ref !== null;
  }

  clearReference(): void {
    this.ref = null;
    this.pendingInitH = null;
    this.resetTracking();
    this.state = "lost";
    this.everLocked = false;
  }

  /** 내부 추적 상태 (디버그용). 앵커가 화면 밖이라 process가 'lost'로 알린 때에도 tracking일 수 있다 */
  getState(): TrackState {
    return this.state;
  }

  /** 기준 진단 정보 (디버그·벤치용) */
  getReferenceDiagnostics(): {
    roi: Rect;
    features: number;
    unique: number;
    pool: number;
    pinCorners: number;
    distinctive: boolean;
    trackable: boolean;
  } | null {
    const r = this.ref;
    if (!r) return null;
    return {
      roi: { ...r.roi },
      features: r.feats.n,
      unique: r.nUnique,
      pool: r.nPool,
      pinCorners: r.pinCorners,
      distinctive: r.distinctive,
      trackable: r.trackable,
    };
  }

  setReference(ref: GrayImage, roi: Rect, initialH?: Mat3): ReferenceInfo {
    this.clearReference();
    this.rng.reseed(this.config.seed);
    const c = this.config;
    const safeRoi: Rect = { x: 0, y: 0, width: 0, height: 0 };
    if (!isValidImage(ref) || !roi || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)) {
      return { roi: safeRoi, features: 0, trackable: false };
    }
    const W = ref.width;
    const H = ref.height;

    const pyr = new Pyramid();
    pyr.build(ref, Math.max(4, c.pyramidLevels));
    const sp = new ScalePyramid();
    sp.build(pyr, c.orbLevels);

    // 기준 프레임 전체 특징 (쌍둥이 판별용)
    const all = new OrbFeatures(1024);
    this.orb.extract(sp, { ...this.orbParams, nFeatures: 600, cellSize: 16 }, all);

    let r = this.sanitizeRoi(roi, W, H);
    const roi0 = { ...r };
    const anchor = {
      x: Math.min(W - 1, Math.max(0, roi.x + roi.width / 2)),
      y: Math.min(H - 1, Math.max(0, roi.y + roi.height / 2)),
    };
    const raw = new CornerList(2048);
    const sel = new CornerList(512);
    const lv0 = pyr.levels[0];
    let nPool = -1;
    let feats = new OrbFeatures(512);
    let verify: VerifyModel | null = null;
    let uniqueIdx = new Int32Array(0);
    let nUnique = 0;
    let distinctive = true;
    let repeatShifts: number[] = [];
    const crit: AmbiguityCriteria = {
      // 재검출 검증보다 느슨하게 → 통과할 여지가 있는 복제본은 모두 모호로 본다
      ncc: c.nccDetect - 0.1,
      fracGood: c.fracDetect - 0.1,
      blockGood: c.blockGood,
      minBlock: c.minBlockDetect - 0.1,
    };
    for (let iter = 0; iter < 10; iter++) {
      feats = new OrbFeatures(512);
      const m = c.roiMargin;
      this.orb.extract(
        sp,
        { ...this.orbParams, nFeatures: c.maxReferenceFeatures, cellSize: 12 },
        feats,
        { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m },
      );
      // 쌍둥이 판별
      const excl = new Float32Array(feats.n);
      for (let i = 0; i < feats.n; i++) excl[i] = 6 * Math.pow(Math.SQRT2, feats.level[i]);
      const twin = new Uint16Array(feats.n);
      const twinIdx = new Int32Array(feats.n);
      minDistanceOutside(feats.desc, feats.x, feats.y, excl, feats.n, all.desc, all.x, all.y, all.n, twin, twinIdx);
      uniqueIdx = new Int32Array(feats.n);
      nUnique = 0;
      for (let i = 0; i < feats.n; i++) if (twin[i] > c.twinDistance) uniqueIdx[nUnique++] = i;

      verify = VerifyModel.build(pyr, r);
      let ambiguous = false;
      if (c.checkRepeats) {
        const shifts = twinShifts(feats, all, twin, twinIdx, c.twinDistance + 15);
        const scan = verify.scanRepeats(pyr, 8, crit, shifts);
        ambiguous = scan.ambiguous;
        repeatShifts = scan.peaks;
      }
      distinctive = !ambiguous;
      nPool = this.buildPool(lv0, r, raw, sel);
      const enough =
        feats.n >= c.targetReferenceFeatures &&
        nUnique >= c.targetReferenceFeatures / 2 &&
        nPool >= 2 * c.minInliers;
      if (enough && !ambiguous) break;
      if (r.width >= W - 0.5 && r.height >= H - 0.5) break;
      if (iter === 9) break; // (전체 화면에 먼저 닿으므로 실제로는 안 옴) 마지막 ROI와 특징이 어긋나지 않게
      r = this.expandRoi(r, c.roiExpandFactor, W, H);
    }

    if (!verify) verify = VerifyModel.build(pyr, r);

    // 고유 특징 볼록껍질
    const ux = new Float64Array(nUnique);
    const uy = new Float64Array(nUnique);
    for (let k = 0; k < nUnique; k++) {
      ux[k] = feats.x[uniqueIdx[k]];
      uy[k] = feats.y[uniqueIdx[k]];
    }
    const uniqueHull = hullArea(ux, uy, nUnique, null);

    // LK 점 풀: ROI 안 0단계 코너 (마지막 반복의 ROI로 다시 — sel에 남아 있다)
    if (nPool < 0) nPool = this.buildPool(lv0, r, raw, sel);
    const border = c.lkWinRadius + 3;
    const poolX = new Float64Array(nPool);
    const poolY = new Float64Array(nPool);
    for (let k = 0; k < nPool; k++) {
      poolX[k] = sel.x[k];
      poolY[k] = sel.y[k];
    }

    // 정렬 템플릿 (단계 0..3)
    const templates: (AlignTemplate | null)[] = [];
    for (let l = 0; l < Math.min(4, pyr.length); l++) {
      const t = buildAlignTemplate(pyr.levels[l], l, r, c.alignSamples, 2);
      templates.push(t.n >= 24 ? t : null);
    }

    // 핀 주변 무늬: 앵커 중심 최소 80×80 (요청 ROI가 더 크면 그것)
    const pb = clampRect(
      {
        x: Math.min(roi0.x, anchor.x - 40),
        y: Math.min(roi0.y, anchor.y - 40),
        width: Math.max(roi0.x + roi0.width, anchor.x + 40) - Math.min(roi0.x, anchor.x - 40),
        height: Math.max(roi0.y + roi0.height, anchor.y + 40) - Math.min(roi0.y, anchor.y - 40),
      },
      W,
      H,
    );
    detectFast(lv0, Math.min(10, c.fastThreshold), border, raw, {
      x0: pb.x,
      y0: pb.y,
      x1: pb.x + pb.width,
      y1: pb.y + pb.height,
    });
    scoreCorners(lv0, raw, "mineig", 3);
    const pinCorners = minDistanceFilter(raw, sel, W, H, 5, 1000, c.lkMinEig);
    const pinNeed = Math.max(c.minPinCorners, Math.round(c.minPinCornerDensity * pb.width * pb.height));

    const trackable =
      feats.n >= c.minReferenceFeatures &&
      nPool >= c.minWeakInliers &&
      templates[0] !== null &&
      pinCorners >= pinNeed;

    // 넓어졌으면 요청 ROI 검증기
    let inner: VerifyModel | null = null;
    let innerBlind = false;
    if (r.width * r.height >= 1.5 * roi0.width * roi0.height) {
      // 핀 주변은 촘촘하게 (0단계 근처) — 작은 로고·글자 하나만 있어도 몇 px 어긋남이 드러나게
      inner = VerifyModel.build(pyr, roi0, { samples: 3600, blocks: 6, minStd: 5 });
      innerBlind = inner.nTextured.every((k) => k === 0);
    }

    this.ref = {
      width: W,
      height: H,
      roi: r,
      anchor,
      pyr,
      feats,
      uniqueIdx,
      nUnique,
      uniqueHull,
      poolX,
      poolY,
      nPool,
      templates,
      verify,
      inner,
      innerBlind,
      distinctive,
      pinCorners,
      repeatShifts,
      trackable,
    };
    this.inUse = new Uint8Array(nPool);

    if (!trackable) {
      // 무늬가 모자라면 추적하지 않는다 (호출측은 정지 화면 방식으로 폴백)
      this.state = initialH ? "lost" : "searching";
      this.everLocked = !!initialH;
    } else if (initialH && isFiniteH(initialH) && checkHomography(initialH, r, this.sanity).ok) {
      this.pendingInitH = initialH.slice();
      this.state = "tracking";
      this.everLocked = true;
    } else {
      this.state = "searching";
    }
    return { roi: { ...r }, features: feats.n, trackable };
  }

  process(frame: GrayImage, timestampMs: number): TrackResult {
    const t0 = now();
    const tm: TrackTimings = { total: 0 };
    const ref = this.ref;
    if (!ref || !ref.trackable || !isValidImage(frame)) {
      tm.total = now() - t0;
      // 이 프레임에선 위치를 낼 수 없으니 표시 상태(tracking/weak)로 알리지 않는다 (내부 상태는 유지)
      return {
        state: ref && !this.everLocked ? "searching" : "lost",
        H: null,
        confidence: 0,
        inliers: 0,
        tracked: 0,
        redetected: false,
        timings: tm,
      };
    }
    const c = this.config;
    const ts = Number.isFinite(timestampMs) ? timestampMs : this.tLast + 33;

    // 프레임 크기 변화 (회전 등) → 추적 끊고 재검출
    if (frame.width !== this.fw || frame.height !== this.fh) {
      if (this.fw !== 0) this.onFrameSizeChange();
      this.fw = frame.width;
      this.fh = frame.height;
    }

    const t = now();
    const cur = this.prevPyr === this.pyrA ? this.pyrB : this.pyrA;
    cur.build(frame, c.pyramidLevels);
    tm.pyramid = now() - t;

    if (this.pendingInitH) this.startFromInitial(frame, cur, ts);

    let out: Outcome | null = null;
    const tracking = this.state === "tracking" || this.state === "weak";
    if (tracking && this.prevValid && this.prevPyr && this.nPts > 0 && this.H) {
      out = this.trackStep(this.prevPyr, cur, ts, tm);
      this.framesSinceDetect++;
      const periodic = c.reanchorInterval > 0 && this.framesSinceDetect >= c.reanchorInterval;
      const needHelp = !out.ok || (out.wantReanchor && this.framesSinceDetect >= 3);
      if ((needHelp || periodic) && this.canDetect()) {
        this.framesSinceDetect = 0;
        // 추적이 살아 있으면 예측 위치 주변만 (미끄러짐은 한두 주기 안) → 절반 이하 비용
        const region = out.ok && out.H ? this.searchRegion(out.H, cur.width, cur.height) : null;
        const det = this.detectStep(cur, tm, region);
        if (det.ok && det.H) {
          // 둘 다 통과했는데 서로 다르면 더 잘 맞는 쪽 (재검출은 고유 특징·엄격 검증을 거쳤으므로 약간 우대)
          const adopt =
            !out.ok || !out.H || maxCornerDistance(out.H, det.H, ref.roi) <= 4 || det.ncc >= out.ncc - 0.05;
          if (adopt) {
            this.adoptDetection(det.H, cur, ts);
            det.tracked = Math.max(det.tracked, out.tracked);
            out = det;
          } else {
            out.redetected = true;
          }
        } else {
          out.redetected = true;
        }
      }
    } else if (this.canDetect()) {
      out = this.detectStep(cur, tm);
      if (out.ok && out.H) this.adoptDetection(out.H, cur, ts);
    }

    // 상태 전이
    let H: Mat3 | null = null;
    let conf = 0;
    if (out && out.ok && out.H) {
      if (out.fromDetect) {
        this.state = "tracking";
        this.strongStreak = 2;
      } else if (out.strong) {
        this.strongStreak++;
        this.state = this.state === "tracking" || this.strongStreak >= 2 ? "tracking" : "weak";
      } else {
        this.strongStreak = 0;
        this.state = "weak";
      }
      this.everLocked = true;
      H = out.H;
      conf = this.state === "weak" ? Math.min(out.conf, 0.6) : out.conf;
    } else {
      this.state = this.everLocked ? "lost" : "searching";
      this.resetTracking();
    }

    this.prevPyr = cur;
    this.prevValid = true;

    // 추적은 계속하되, 앵커(핀)가 화면 밖이면 '놓침'으로 알린다 (보이지 않는 핀을 표시 중이라 하지 않기).
    // 내부 상태는 그대로라 다시 들어오면 재검출 없이 바로 표시된다.
    let state = this.state;
    if (H && !this.anchorVisible(H, frame.width, frame.height)) {
      state = "lost";
      H = null;
    }
    tm.total = now() - t0;
    return {
      state,
      H: H ? H.slice() : null,
      confidence: H ? conf : 0,
      inliers: out ? out.inliers : 0,
      tracked: out ? out.tracked : 0,
      redetected: out ? out.redetected : false,
      timings: tm,
    };
  }

  // ───────────────────────── 내부: 기준 ─────────────────────────

  private sanitizeRoi(roi: Rect, W: number, H: number): Rect {
    let x = roi.x;
    let y = roi.y;
    let w = roi.width;
    let h = roi.height;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    const m = Math.min(this.config.minRoiSize, W, H);
    if (w < m) {
      x -= (m - w) / 2;
      w = m;
    }
    if (h < m) {
      y -= (m - h) / 2;
      h = m;
    }
    return this.fitInside({ x, y, width: w, height: h }, W, H);
  }

  /** LK 점 풀 후보: r 안 0단계 FAST 코너 → Shi–Tomasi 점수 → 최소 간격 5px. sel에 점수순으로 */
  private buildPool(lv0: GrayImage, r: Rect, raw: CornerList, sel: CornerList): number {
    const c = this.config;
    detectFast(lv0, Math.min(10, c.fastThreshold), c.lkWinRadius + 3, raw, {
      x0: r.x,
      y0: r.y,
      x1: r.x + r.width,
      y1: r.y + r.height,
    });
    scoreCorners(lv0, raw, "mineig", 3);
    return minDistanceFilter(raw, sel, lv0.width, lv0.height, 5, c.maxTrackedPoints * 3, c.lkMinEig);
  }

  /** 크기를 유지한 채 프레임 안으로 밀어 넣는다 (프레임보다 크면 자름) */
  private fitInside(r: Rect, W: number, H: number): Rect {
    const w = Math.min(r.width, W);
    const h = Math.min(r.height, H);
    const x = Math.max(0, Math.min(W - w, r.x));
    const y = Math.max(0, Math.min(H - h, r.y));
    return clampRect({ x, y, width: w, height: h }, W, H);
  }

  private expandRoi(r: Rect, f: number, W: number, H: number): Rect {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const w = Math.min(W, r.width * f);
    const h = Math.min(H, r.height * f);
    return this.fitInside({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, W, H);
  }

  /** 앵커가 프레임 안(가장자리 반 픽셀 포함)에 보이는가 */
  private anchorVisible(H: Mat3, W: number, Hh: number): boolean {
    const a = this.ref!.anchor;
    const w = H[6] * a.x + H[7] * a.y + H[8];
    if (!(w > 1e-9)) return false;
    const x = (H[0] * a.x + H[1] * a.y + H[2]) / w;
    const y = (H[3] * a.x + H[4] * a.y + H[5]) / w;
    return x >= -0.5 && y >= -0.5 && x <= W - 0.5 && y <= Hh - 0.5;
  }

  private canDetect(): boolean {
    const r = this.ref;
    return !!r && r.distinctive && r.nUnique >= this.config.minDetectInliers;
  }

  // ───────────────────────── 내부: 상태 관리 ─────────────────────────

  private resetTracking(): void {
    this.nPts = 0;
    if (this.inUse.length) this.inUse.fill(0);
    this.H = null;
    this.Hprev = null;
    this.strongStreak = 0;
  }

  private onFrameSizeChange(): void {
    this.prevValid = false;
    this.prevPyr = null;
    this.pendingInitH = null;
    this.resetTracking();
    if (this.state === "tracking" || this.state === "weak") this.state = "lost";
  }

  /** initialH: 기준을 initialH로 워프한 가상 이전 프레임에서 바로 추적 시작 */
  private startFromInitial(frame: GrayImage, cur: Pyramid, ts: number): void {
    const ref = this.ref!;
    const Hi = this.pendingInitH!;
    this.pendingInitH = null;
    // cur이 아닌 쪽 버퍼를 가상 이전 프레임으로
    const prev = cur === this.pyrA ? this.pyrB : this.pyrA;
    const lv0 = ref.pyr.levels[0];
    if (isIdentityish(Hi) && lv0.width === frame.width && lv0.height === frame.height) {
      prev.build(lv0, this.config.pyramidLevels);
    } else {
      this.synth = ensureImage(this.synth, frame.width, frame.height);
      warpPerspective(lv0, Hi, this.synth, 128);
      prev.build(this.synth, this.config.pyramidLevels);
    }
    this.prevPyr = prev;
    this.prevValid = true;
    this.H = Hi.slice();
    this.tLast = ts - 1;
    this.Hprev = null;
    this.state = "tracking";
    this.strongStreak = 2;
    this.framesSinceDetect = 0;
    this.nPts = 0;
    this.inUse.fill(0);
    this.addFromPool(this.H, frame.width, frame.height, this.config.maxTrackedPoints);
  }

  /** 등속 예측 (ROI 네 꼭짓점 외삽) */
  private predict(ts: number): Mat3 {
    const H = this.H!;
    const c = this.config;
    if (!this.Hprev || c.motionDamping <= 0) return H;
    const roi = this.ref!.roi;
    const c1 = warpRect(H, roi);
    const c2 = warpRect(this.Hprev, roi);
    if (!c1 || !c2) return H;
    const dt1 = this.tLast - this.tPrev;
    const dt = ts - this.tLast;
    let r = dt1 > 1e-3 && dt > 0 ? dt / dt1 : 1;
    if (r > 3) r = 3;
    const k = c.motionDamping * r;
    const pc = c1.map((p, i) => ({ x: p.x + k * (p.x - c2[i].x), y: p.y + k * (p.y - c2[i].y) }));
    const Hp = homographyFromQuads(rectCorners(roi), pc);
    return Hp && isFiniteH(Hp) ? Hp : H;
  }

  private commitPose(H: Mat3, ts: number, resetHistory: boolean): void {
    if (resetHistory || !this.H) {
      this.Hprev = null;
    } else {
      this.Hprev = this.H;
      this.tPrev = this.tLast;
    }
    this.H = H;
    this.tLast = ts;
  }

  private ensureCorr(n: number): void {
    if (this.cSx.length >= n) return;
    const c = Math.max(n, this.cSx.length * 2, 64);
    this.cSx = new Float64Array(c);
    this.cSy = new Float64Array(c);
    this.cDx = new Float64Array(c);
    this.cDy = new Float64Array(c);
    this.cIdx = new Int32Array(c);
    this.cMask = new Uint8Array(c);
  }

  // ───────────────────────── 내부: 추적 ─────────────────────────

  private fail(tracked: number, inliers: number, redetected = false): Outcome {
    return {
      ok: false,
      strong: false,
      H: null,
      inliers,
      tracked,
      redetected,
      conf: 0,
      ncc: 0,
      fromDetect: false,
      wantReanchor: true,
    };
  }

  private trackStep(prev: Pyramid, cur: Pyramid, ts: number, tm: TrackTimings): Outcome {
    const c = this.config;
    const n = this.nPts;
    const Hlast = this.H!;
    const pred = this.predict(ts);

    // 1) LK (등속 예측을 초기값으로)
    let t = now();
    const { refX, refY, ptX, ptY, gX, gY, nX, nY, bX, bY, st, st2 } = this;
    for (let i = 0; i < n; i++) {
      const x = refX[i];
      const y = refY[i];
      const wp = pred[6] * x + pred[7] * y + pred[8];
      const wl = Hlast[6] * x + Hlast[7] * y + Hlast[8];
      let dx = 0;
      let dy = 0;
      if (wp > 1e-9 && wl > 1e-9) {
        dx = (pred[0] * x + pred[1] * y + pred[2]) / wp - (Hlast[0] * x + Hlast[1] * y + Hlast[2]) / wl;
        dy = (pred[3] * x + pred[4] * y + pred[5]) / wp - (Hlast[3] * x + Hlast[4] * y + Hlast[5]) / wl;
      }
      gX[i] = ptX[i] + dx;
      gY[i] = ptY[i] + dy;
      st[i] = 1;
    }
    this.lk.track(prev, cur, n, ptX, ptY, gX, gY, nX, nY, st, this.lkErr, this.lkParams);
    // 예측이 빗나간 점(갑자기 멈춤 등)은 '안 움직임'을 초기값으로 한 번 더
    let retry = 0;
    for (let i = 0; i < n; i++) {
      st2[i] = 0;
      if (!st[i] && (gX[i] !== ptX[i] || gY[i] !== ptY[i])) {
        st2[i] = 1;
        retry++;
      }
    }
    if (retry > 0) {
      this.lk.track(prev, cur, n, ptX, ptY, ptX, ptY, nX, nY, st2, this.lkErr, this.lkParams);
      for (let i = 0; i < n; i++) if (st2[i]) st[i] = 1;
    }
    st2.set(st.subarray(0, n));
    this.lk.track(cur, prev, n, nX, nY, ptX, ptY, bX, bY, st2, null, this.lkBackParams);
    const fb2 = c.fbThreshold * c.fbThreshold;
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (!st[i] || !st2[i]) continue;
      const ex = bX[i] - ptX[i];
      const ey = bY[i] - ptY[i];
      if (ex * ex + ey * ey > fb2) continue;
      this.cSx[m] = refX[i];
      this.cSy[m] = refY[i];
      this.cDx[m] = nX[i];
      this.cDy[m] = nY[i];
      this.cIdx[m] = i;
      m++;
    }
    tm.lk = now() - t;

    // 2) RANSAC (ref ↔ 현재) + LM → 가설 1
    t = now();
    const hyps: Mat3[] = [];
    let inl = 0;
    if (m >= 4) {
      const res = this.ransac.run(this.cSx, this.cSy, this.cDx, this.cDy, m, this.trackRansac, this.rng, this.cMask, [
        pred,
        Hlast,
      ]);
      inl = res.inliers;
      if (res.H && inl >= c.minWeakInliers) {
        hyps.push(refineHomographyLM(this.cSx, this.cSy, this.cDx, this.cDy, m, this.cMask, res.H, 5));
        // 가설 2: 아웃라이어끼리 따로 일관된 H가 있으면 (반복 패턴에서 한쪽이 한 주기 미끄러짐 등)
        const nOut = m - inl;
        if (nOut >= Math.max(c.minWeakInliers, 0.25 * m)) {
          const H2 = this.outlierHypothesis(m);
          if (H2) hyps.push(H2);
        }
      }
    }
    tm.ransac = now() - t;
    const dbg = (result: string, inliers: number, verify?: VerifyResult) => {
      if (this.onDebug)
        this.onDebug({
          kind: "track",
          result,
          matches: m,
          inliers,
          hypotheses: hyps.length,
          verify: verify ? { ...verify } : undefined,
          inner: this.lastInner ? { ...this.lastInner } : undefined,
        });
    };
    if (hyps.length === 0) {
      dbg("ransac", inl);
      return this.fail(n, inl);
    }

    // 3) 가설마다 기준 템플릿 직접 정렬 + 형상·시간·광도 검증 → 가장 잘 맞는 것
    let best: HypEval | null = null;
    for (const Hh of hyps) {
      const e = this.evalHypothesis(Hh, cur, pred, m, tm);
      if (e && (!best || e.score > best.score)) best = e;
    }
    if (!best) {
      dbg("hypotheses", inl);
      return this.fail(n, inl);
    }
    const Hfin = best.H;
    const aligned = best.aligned;
    const v = best.v;
    const inl2 = countInliers(Hfin, this.cSx, this.cSy, this.cDx, this.cDy, m, c.ransacThreshold, this.cMask);
    const blocksOk = v.blocksVisible >= 1;
    this.lastInner = null;
    const inner = this.innerCheck(Hfin, cur);
    const strong =
      inner === 2 &&
      inl2 >= c.minInliers &&
      (aligned || !c.alignEnabled) &&
      blocksOk &&
      v.ncc >= c.nccTrack &&
      v.fracGood >= c.fracTrack;
    const weak = inner >= 1 && inl2 >= c.minWeakInliers && blocksOk && v.ncc >= c.nccWeak && v.fracGood >= c.fracWeak;
    if (!weak) {
      dbg("verify", inl2, v);
      return this.fail(n, inl2);
    }
    dbg(strong ? "ok" : "weak", inl2, v);

    // 4) 점 정리: 인라이어만 남기고 (강하면 H(ref)로 스냅), 부족하면 보충
    t = now();
    const snap = c.snapPoints && strong && aligned;
    let k = 0;
    for (let j = 0; j < m; j++) {
      if (!this.cMask[j]) continue;
      const i = this.cIdx[j];
      let x = nX[i];
      let y = nY[i];
      if (snap) {
        const rx = refX[i];
        const ry = refY[i];
        const w = Hfin[6] * rx + Hfin[7] * ry + Hfin[8];
        x = (Hfin[0] * rx + Hfin[1] * ry + Hfin[2]) / w;
        y = (Hfin[3] * rx + Hfin[4] * ry + Hfin[5]) / w;
      }
      // 순서 보존 압축 (i ≥ k)
      refX[k] = refX[i];
      refY[k] = refY[i];
      ptX[k] = x;
      ptY[k] = y;
      this.poolOf[k] = this.poolOf[i];
      k++;
    }
    // 버려진 점의 풀 사용 표시 해제
    this.inUse.fill(0);
    for (let i = 0; i < k; i++) if (this.poolOf[i] >= 0) this.inUse[this.poolOf[i]] = 1;
    this.nPts = k;
    if (k < c.maxTrackedPoints * c.replenishBelow) {
      this.addFromPool(Hfin, cur.width, cur.height, c.maxTrackedPoints);
    }
    tm.replenish = now() - t;

    this.commitPose(Hfin, ts, false);
    const conf = this.confidence(v, inl2);
    return {
      ok: true,
      strong,
      H: Hfin,
      inliers: inl2,
      tracked: n,
      redetected: false,
      conf,
      ncc: v.ncc,
      fromDetect: false,
      wantReanchor: inl2 < c.minInliers || !aligned,
    };
  }

  private confidence(v: VerifyResult, inliers: number): number {
    const c = this.config;
    const a = clamp01((v.ncc - c.nccWeak) / (0.85 - c.nccWeak));
    const b = clamp01(v.fracGood);
    const k = clamp01(inliers / (2 * c.minInliers));
    return clamp01(a * (0.6 + 0.4 * b) * (0.7 + 0.3 * k));
  }

  /** 1차 RANSAC 아웃라이어만으로 두 번째 가설 (없으면 null) */
  private outlierHypothesis(m: number): Mat3 | null {
    const c = this.config;
    if (this.oSx.length < m) {
      this.oSx = new Float64Array(this.cSx.length);
      this.oSy = new Float64Array(this.cSx.length);
      this.oDx = new Float64Array(this.cSx.length);
      this.oDy = new Float64Array(this.cSx.length);
      this.oMask = new Uint8Array(this.cSx.length);
    }
    let k = 0;
    for (let j = 0; j < m; j++) {
      if (this.cMask[j]) continue;
      this.oSx[k] = this.cSx[j];
      this.oSy[k] = this.cSy[j];
      this.oDx[k] = this.cDx[j];
      this.oDy[k] = this.cDy[j];
      k++;
    }
    const res = this.ransac.run(this.oSx, this.oSy, this.oDx, this.oDy, k, this.trackRansac, this.rng, this.oMask);
    if (!res.H || res.inliers < c.minWeakInliers) return null;
    return refineHomographyLM(this.oSx, this.oSy, this.oDx, this.oDy, k, this.oMask, res.H, 5);
  }

  /** 추적 가설 평가: 정렬 → 형상 → 시간(점프) → 광도. 통과 못 하면 null */
  private evalHypothesis(Hlk: Mat3, cur: Pyramid, pred: Mat3, m: number, tm: TrackTimings): HypEval | null {
    const c = this.config;
    const ref = this.ref!;
    let t = now();
    let H = Hlk;
    let aligned = false;
    if (c.alignEnabled) {
      const a = this.alignFrom(Hlk, cur, [1, 0]);
      if (a && maxCornerDistance(a, Hlk, ref.roi) <= c.alignMaxShift) {
        H = a;
        aligned = true;
      }
    }
    tm.align = (tm.align ?? 0) + (now() - t);
    t = now();
    try {
      const san = checkHomography(H, ref.roi, this.sanity);
      if (!san.ok) return null;
      const diag = Math.sqrt(Math.max(1, san.areaRatio * ref.roi.width * ref.roi.height)) * Math.SQRT2;
      if (maxCornerDistance(H, pred, ref.roi) > Math.max(c.maxJumpPx, c.maxJumpFrac * diag)) return null;
      const v = ref.verify.evaluate(cur, H, c.blockGood, emptyVerify());
      if (v.blocksVisible < 1) return null;
      const inliers = countInliers(H, this.cSx, this.cSy, this.cDx, this.cDy, m, c.ransacThreshold, null);
      const score = v.ncc + v.fracGood + Math.max(0, v.minBlock) + 0.002 * inliers;
      return { H, aligned, v, inliers, score };
    } finally {
      tm.verify = (tm.verify ?? 0) + (now() - t);
    }
  }

  /**
   * 템플릿 정렬 (거친 → 고운 단계). passes: 기준 단계 목록 (예: [1, 0]).
   * 국소 스케일에 맞춰 ref·현재 단계를 고른다. 실패하면 null.
   */
  private alignFrom(H0: Mat3, cur: Pyramid, passes: number[]): Mat3 | null {
    const { templates, roi } = this.ref!;
    let H = H0;
    let done = 0;
    for (const base of passes) {
      const k = localScale(H, { x: roi.x + roi.width / 2, y: roi.y + roi.height / 2 }, 4);
      let e = Number.isFinite(k) && k > 0 ? Math.round(Math.log2(k)) : 0;
      if (e > 3) e = 3;
      if (e < -3) e = -3;
      let lr = base + Math.max(0, -e);
      let lc = base + Math.max(0, e);
      lr = Math.min(lr, templates.length - 1);
      lc = Math.min(lc, cur.length - 1);
      const tpl = templates[lr];
      if (!tpl) continue;
      const r = this.aligner.align(tpl, cur.levels[lc], lc, H, this.alignParams);
      if (!r.ok) return null;
      H = r.H;
      done++;
    }
    return done > 0 ? H : null;
  }

  /** 풀에서 (H로 투영해) 보이는 점을 골라 추적 점에 추가 */
  private addFromPool(H: Mat3, W: number, Hh: number, maxN: number): void {
    const ref = this.ref!;
    const c = this.config;
    const md = c.minPointDistance;
    const cs = Math.max(1, md);
    const gw = Math.ceil(W / cs) + 1;
    const gh = Math.ceil(Hh / cs) + 1;
    if (this.occ.length < gw * gh) this.occ = new Int32Array(gw * gh);
    const occ = this.occ;
    occ.fill(0, 0, gw * gh);
    for (let i = 0; i < this.nPts; i++) {
      const gx = Math.floor(this.ptX[i] / cs);
      const gy = Math.floor(this.ptY[i] / cs);
      if (gx >= 0 && gy >= 0 && gx < gw && gy < gh) occ[gy * gw + gx] = 1;
    }
    const margin = c.lkWinRadius + 3;
    for (let j = 0; j < ref.nPool && this.nPts < maxN; j++) {
      if (this.inUse[j]) continue;
      const rx = ref.poolX[j];
      const ry = ref.poolY[j];
      const w = H[6] * rx + H[7] * ry + H[8];
      if (!(w > 1e-9)) continue;
      const x = (H[0] * rx + H[1] * ry + H[2]) / w;
      const y = (H[3] * rx + H[4] * ry + H[5]) / w;
      if (!(x >= margin && y >= margin && x < W - 1 - margin && y < Hh - 1 - margin)) continue;
      const gx = Math.floor(x / cs);
      const gy = Math.floor(y / cs);
      let busy = false;
      for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1) && !busy; yy++) {
        for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx++) {
          if (occ[yy * gw + xx]) {
            busy = true;
            break;
          }
        }
      }
      if (busy) continue;
      occ[gy * gw + gx] = 1;
      const k = this.nPts++;
      this.refX[k] = rx;
      this.refY[k] = ry;
      this.ptX[k] = x;
      this.ptY[k] = y;
      this.poolOf[k] = j;
      this.inUse[j] = 1;
    }
  }

  // ───────────────────────── 내부: 검증·재검출 ─────────────────────────

  /**
   * 요청 ROI(핀 주변) 검증: 0 = 어긋남, 1 = 약함(또는 확인 불가), 2 = 좋음.
   * ROI를 넓히지 않았으면 항상 2 (넓은 검증이 곧 핀 주변 검증).
   */
  private innerCheck(H: Mat3, cur: Pyramid): 0 | 1 | 2 {
    const ref = this.ref!;
    const c = this.config;
    if (!ref.inner) return 2;
    if (ref.innerBlind) return 1;
    const v = ref.inner.evaluate(cur, H, c.blockGood, emptyVerify());
    this.lastInner = v;
    // 핀 주변 무늬 블록이 안 보이면(가림·화면 밖) 확인 불가 → 약함
    if (v.blocksVisible < 1) return 1;
    // 전역 NCC는 매끈한 음영에 좌우되므로 무늬 블록 기준으로 본다.
    // 하위 20% 블록 NCC — 무늬 블록이 하나뿐이면 그 블록, 많으면 가장자리·가림 몇 개는 봐준다.
    const q = ref.inner.blockQuantile(0.2);
    if (!(q >= c.innerWeak) || v.fracGood < 0.5) return 0;
    return q >= c.innerStrong && v.fracGood >= c.fracTrack ? 2 : 1;
  }

  /**
   * H가 기준의 반복 이동량(±d)만큼 옮긴 후보들보다 확실히 잘 맞는가.
   * 옮긴 후보가 화면에 충분히 보이지 않으면 비교를 건너뛴다.
   */
  private beatsRepeats(H: Mat3, cur: Pyramid, v: VerifyResult): boolean {
    const ref = this.ref!;
    const sh = ref.repeatShifts;
    if (sh.length === 0) return true;
    const s0 = v.ncc + v.fracGood;
    const tmp = emptyVerify();
    for (let i = 0; i + 1 < sh.length; i += 2) {
      for (const sgn of [1, -1]) {
        const dx = sgn * sh[i];
        const dy = sgn * sh[i + 1];
        const H2 = mul3(H, [1, 0, dx, 0, 1, dy, 0, 0, 1]);
        ref.verify.evaluate(cur, H2, this.config.blockGood, tmp);
        if (tmp.visibleFrac < 0.5 || tmp.blocksVisible < 1) continue;
        if (tmp.ncc + tmp.fracGood >= s0 - this.config.repeatMargin) return false;
      }
    }
    return true;
  }

  /** 재검출 결과를 받아들인다: 풀에서 점을 새로 뿌리고 자세 이력 초기화 */
  private adoptDetection(H: Mat3, cur: Pyramid, ts: number): void {
    this.nPts = 0;
    this.inUse.fill(0);
    this.addFromPool(H, cur.width, cur.height, this.config.maxTrackedPoints);
    this.commitPose(H, ts, true);
    this.framesSinceDetect = 0;
  }

  /**
   * 인라이어(ref 좌표) 볼록껍질 넓이 / (H로 봤을 때 화면 안에 들어오는) 고유 특징들의 볼록껍질 넓이.
   * 대상이 일부만 보일 때도 공정하게 퍼짐을 본다.
   */
  private inlierSpread(H: Mat3, nm: number, W: number, Hh: number): number {
    const ref = this.ref!;
    const f = ref.feats;
    const ux = new Float64Array(ref.nUnique);
    const uy = new Float64Array(ref.nUnique);
    let k = 0;
    for (let j = 0; j < ref.nUnique; j++) {
      const i = ref.uniqueIdx[j];
      const x = f.x[i];
      const y = f.y[i];
      const w = H[6] * x + H[7] * y + H[8];
      if (!(w > 1e-9)) continue;
      const px = (H[0] * x + H[1] * y + H[2]) / w;
      const py = (H[3] * x + H[4] * y + H[5]) / w;
      if (px < 0 || py < 0 || px > W - 1 || py > Hh - 1) continue;
      ux[k] = x;
      uy[k] = y;
      k++;
    }
    const visHull = hullArea(ux, uy, k, null);
    const denom = Math.max(visHull, 0.05 * ref.uniqueHull);
    return denom > 0 ? hullArea(this.cSx, this.cSy, nm, this.cMask) / denom : 0;
  }

  /** H로 옮긴 ROI의 외접 사각형을 ROI 크기의 절반만큼 넓힌 영역 (프레임으로 자름) */
  private searchRegion(H: Mat3, W: number, Hh: number): Rect | null {
    const q = warpRect(H, this.ref!.roi);
    if (!q) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of q) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const mx = (x1 - x0) * 0.5;
    const my = (y1 - y0) * 0.5;
    const r = clampRect({ x: x0 - mx, y: y0 - my, width: x1 - x0 + 2 * mx, height: y1 - y0 + 2 * my }, W, Hh);
    // 프레임 대부분이면 굳이 자르지 않는다
    return r.width * r.height > 0.7 * W * Hh || r.width < 32 || r.height < 32 ? null : r;
  }

  /**
   * ORB로 기준을 찾는다 (region이 있으면 그 안에서만). 추적기 상태는 바꾸지 않는다.
   */
  private detectStep(cur: Pyramid, tm: TrackTimings, region: Rect | null = null): Outcome {
    const c = this.config;
    const ref = this.ref!;
    const out = this.fail(0, 0, true);

    let t = now();
    this.curScale.build(cur, c.orbLevels);
    const f = this.curFeat;
    f.n = 0;
    if (region) {
      // 영역 넓이에 비례한 개수 (특징 밀도 유지, 최소 150)
      const frac = (region.width * region.height) / (cur.width * cur.height);
      const nF = Math.max(150, Math.round(c.orbFeatures * frac));
      this.orb.extract(this.curScale, { ...this.orbParams, nFeatures: nF }, f, region);
    } else {
      this.orb.extract(this.curScale, this.orbParams, f);
    }
    tm.detect = (tm.detect ?? 0) + (now() - t);

    t = now();
    const ml = this.matches;
    const nm = this.matcher.match(ref.feats.desc, ref.uniqueIdx, ref.nUnique, f.desc, f.n, this.matchParams, ml);
    tm.match = (tm.match ?? 0) + (now() - t);
    const dbg = (result: string, inliers: number, spread?: number, verify?: VerifyResult) => {
      if (this.onDebug)
        this.onDebug({ kind: "detect", result, matches: nm, inliers, spread, verify: verify ? { ...verify } : undefined });
    };
    if (nm < c.minDetectInliers) {
      dbg("matches", 0);
      return out;
    }

    t = now();
    this.ensureCorr(nm);
    for (let k = 0; k < nm; k++) {
      this.cSx[k] = ref.feats.x[ml.q[k]];
      this.cSy[k] = ref.feats.y[ml.q[k]];
      this.cDx[k] = f.x[ml.t[k]];
      this.cDy[k] = f.y[ml.t[k]];
    }
    const res = this.ransac.run(this.cSx, this.cSy, this.cDx, this.cDy, nm, this.detectRansac, this.rng, this.cMask);
    tm.ransac = (tm.ransac ?? 0) + (now() - t);
    out.inliers = res.inliers;
    if (!res.H || res.inliers < c.minDetectInliers) {
      dbg("ransac", res.inliers);
      return out;
    }
    const H1 = refineHomographyLM(this.cSx, this.cSy, this.cDx, this.cDy, nm, this.cMask, res.H, 8);
    if (!checkHomography(H1, ref.roi, this.sanity).ok) {
      dbg("sanity", res.inliers);
      return out;
    }
    // 인라이어 공간 분포: 이 H로 화면 안에 들어오는 고유 특징들의 볼록껍질 대비
    const spread = this.inlierSpread(H1, nm, cur.width, cur.height);
    if (spread < c.minDetectSpread) {
      dbg("spread", res.inliers, spread);
      return out;
    }

    // 정밀 정렬 (거친 단계부터)
    t = now();
    let Hfin: Mat3 | null = H1;
    if (c.alignEnabled) {
      Hfin = this.alignFrom(H1, cur, [2, 1, 0]);
      if (Hfin && maxCornerDistance(Hfin, H1, ref.roi) > Math.max(12, 3 * c.detectRansacThreshold)) Hfin = null;
    }
    tm.align = (tm.align ?? 0) + (now() - t);
    if (!Hfin) {
      dbg("align", res.inliers, spread);
      return out;
    }

    t = now();
    const inl = countInliers(Hfin, this.cSx, this.cSy, this.cDx, this.cDy, nm, c.detectRansacThreshold, this.cMask);
    out.inliers = inl;
    if (inl < c.minDetectInliers || !checkHomography(Hfin, ref.roi, this.sanity).ok) {
      tm.verify = (tm.verify ?? 0) + (now() - t);
      dbg("recount", inl, spread);
      return out;
    }
    const v = ref.verify.evaluate(cur, Hfin, c.blockGood, this.vres);
    const bad = ref.verify.countBadBlocks(c.minBlockDetect);
    const minBlocks = Math.min(3, Math.max(1, ref.verify.nTextured[v.refLevel] ?? 1));
    // ORB 근거가 강하면(인라이어 많고 넓게 퍼짐) 평면 밖 내용·반사로 틀어진 블록 몇 개는 봐준다
    const strongOrb = inl >= 2 * c.minDetectInliers && spread >= 2 * c.minDetectSpread;
    const allowedBad = strongOrb ? Math.max(1, Math.floor(c.maxBadBlockFrac * v.blocksVisible)) : 0;
    if (v.blocksVisible < minBlocks || v.ncc < c.nccDetect || v.fracGood < c.fracDetect || bad > allowedBad) {
      tm.verify = (tm.verify ?? 0) + (now() - t);
      dbg("verify", inl, spread, v);
      return out;
    }
    // 반복 패턴: 기준에서 찾은 '닮은 이동량'만큼 옆으로 옮긴 H보다 확실히 잘 맞아야 한다.
    // (지금 H가 복제본이면 옮긴 H가 진짜 위치라 더 잘 맞는다 → 거부)
    if (this.beatsRepeats(Hfin, cur, v) === false) {
      tm.verify = (tm.verify ?? 0) + (now() - t);
      dbg("repeat", inl, spread, v);
      return out;
    }
    // 넓힌 ROI면 핀 주변도 확실히 맞아야 (다른 평면의 배경만 맞은 경우 배제)
    if (this.innerCheck(Hfin, cur) === 0) {
      tm.verify = (tm.verify ?? 0) + (now() - t);
      dbg("inner", inl, spread, v);
      return out;
    }
    tm.verify = (tm.verify ?? 0) + (now() - t);
    dbg("ok", inl, spread, v);

    return {
      ok: true,
      strong: true,
      H: Hfin,
      inliers: inl,
      tracked: 0,
      redetected: true,
      conf: this.confidence(v, inl),
      ncc: v.ncc,
      fromDetect: true,
      wantReanchor: false,
    };
  }
}
