import type {
  GrayImage,
  LostReason,
  Mat3,
  PlanarTrackerApi,
  Point,
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
  reprojError2,
  type RansacParams,
  type SanityLimits,
} from "./cv/homography";
import { Pyramid, ensureImage, isValidImage, warpPerspective } from "./cv/image";
import { PyrLK, type LKParams } from "./cv/lk";
import { HammingMatcher, MatchList, minDistanceOutside, type MatchParams } from "./cv/match";
import { VerifyModel, emptyVerify, type AmbiguityCriteria, type VerifyResult } from "./cv/ncc";
import { OrbCornerCache, OrbExtractor, OrbFeatures, ScalePyramid, type OrbParams } from "./cv/orb";
import { Rng } from "./cv/rng";

// 평면 앵커 추적기 (README "파이프라인" 참고).
//
//  setReference
//    피라미드 → ROI ORB(+기준 프레임 전체 ORB로 '쌍둥이' = 반복 무늬 특징 판별) → ROI 자기유사성 검사
//    → 특징·LK 코너가 모자라거나 모호(옆 복제본과 구별 불가)하면 ROI를 1.5배씩 넓힘(최대 전체 화면)
//    → LK 점 풀, 정렬 템플릿(단계별), 광도 검증 격자(블록 NCC), 반복 이동량 목록.
//    trackable = 특징 충분 + 핀 주변(앵커 ±40px)에 코너가 있을 것
//                + (initialH가 없으면) 재검출 가능(반복 무늬로 모호하지 않음).
//    (핀 자체에 무늬가 없으면 넓힌 ROI가 다른 평면일 때 시차만큼 틀린 곳을 가리키므로 추적하지 않는다.)
//
//  process
//    tracking/weak — LK(등속 예측 초기값, 실패 점은 무이동 재시도, 순·역방향 검사)
//                    → RANSAC(ref↔현재 좌표, 체인 누적 없음) + LM → 기준 템플릿 직접 정렬(IC, 드리프트 제거)
//                    → 형상·시간(점프)·광도 검증. 아웃라이어끼리 따로 맞는 H(한 주기 미끄러짐 등)가 있으면
//                      둘 다 검증해 나은 쪽. 넓힌 ROI면 핀 주변 블록도 맞아야 표시.
//                      넓히지 않은 ROI면 앵커 주변 48px 창의 국소 최대 검사: H를 8방향으로 6px 옮긴 쪽이
//                      창 NCC가 더 높으면 표시하지 않는다 (앵커가 지배 평면과 다른 면 — 돌출 키 사이 바닥 등 — 이라
//                      시차로 어긋난 경우. 절대값이 아니라 상대 비교라 압축·블러·가림엔 둔감).
//                    → 주기적(15프레임) 미끄러짐 검사: 반복 무늬 기준이면 반복 이동량만큼 옮긴 H와 광도로 비교해
//                      의심될 때만 ORB 재검출 (무조건 하는 주기적 ORB 재검출은 없앴다 — 프레임 시간 튐 방지).
//                    → 인라이어 점 스냅·풀에서 보충. 실패하거나 약하면(또는 주기적으로) 같은 프레임에서 재검출.
//    searching/lost — ORB 매칭(고유 특징만, 비율·상호) → RANSAC → LM → 정렬(거친→고운)
//                    → 엄격 검증(블록 NCC, 반복 이동량만큼 옮긴 후보보다 확실히 나을 것,
//                      앵커 주변 창 국소 최대 검사는 6·12px 두 겹) → tracking
//    앵커(주석 기준점, 없으면 요청 ROI 중심)가 화면 밖이면 내부 추적은 계속하되 'lost'로 알린다 (H = null).
//
// 틀린 곳을 가리키느니 놓치는 쪽을 택한다: 내보내는 모든 H는 광도 검증(블록 NCC)을 통과한 것이다.
//
// 앵커·화면 밖 (계약 v2)
//   anchor = 주석이 실제로 있는 ref 픽셀 한 점. 핀이면 핀 위치, 선(stroke)이면 호출측이 넘긴 점들의 무게중심.
//   화면 밖 = H·anchor가 프레임 [−m, W−1+m] × [−m, H−1+m] 밖 (m = offscreenMargin, 기본 2px)이거나 카메라 뒤.
//   선의 일부만 화면에 걸쳐도 무게중심이 밖이면 화면 밖으로 본다 (단순·일관: "주석의 중심이 보이는가").
//   핀 주변 검증(pin_blank 판정·넓힌 ROI일 때의 inner 검증)도 anchor 기준이다.
//
// TrackResult.reason / hint
//   tracking·weak       → reason 없음, hint = null
//   lost + offscreen    → 내부 추적이 이번 프레임 검증을 강하게 통과했고(넓은 ROI 기준 tracking 조건) 앵커만 화면 밖.
//                          hint = 그 H (화면 밖 방향 화살표 전용). 앵커가 카메라 뒤이거나 프레임 대각선의
//                          hintMaxDiag배보다 멀면 방향을 믿을 수 없으니 hint를 내지 않는다(→ unverified).
//   lost/searching + unverified   → 이번 프레임에 검증된 위치 없음 (후보가 없었거나 검증에서 떨어짐)
//   lost/searching + untrackable  → 이 기준으로는 위치를 낼 수 없음: trackable=false, 또는 반복 무늬로
//                                    재검출이 꺼진 기준을 놓친 뒤(다시 찾을 방법이 없다 → 새로 찍어야 함)
//   lost/searching + invalid_frame → 입력 프레임이 잘못됨
//   기준이 없으면 lost, reason 없음.
//
// ReferenceInfo.reason
//   low_texture — ROI를 전체 화면까지 넓혀도 특징이 모자람 (trackable=false)
//   pin_blank   — 전체적으로는 무늬가 있으나 앵커 주변이 비어 있음 (trackable=false)
//   ambiguous   — 반복 무늬라 재검출(ORB 탐색)을 끔. initialH가 있으면(엔지니어) 추적은 된다(trackable=true).
//                 initialH가 없으면(고객) 찾을 방법이 없으므로 trackable=false.

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
  /**
   * 추적 중 주기적 미끄러짐 검사 간격 (프레임, 0 = 끔). 반복 무늬 기준이면 반복 이동량만큼 옮긴 H와
   * 광도로 비교해 의심될 때만 ORB 재검출을 한다 (periodicOrb면 의심 없이도 이 간격마다 ORB 재검출).
   */
  reanchorInterval: number;
  /** 주기마다 무조건 ORB 재검출 (느림, 기본 끔) */
  periodicOrb: boolean;
  // ── LK ──
  lkWinRadius: number;
  lkMaxIters: number;
  lkMinEig: number;
  lkMaxResidual: number;
  /** 거친 LK 단계 수렴 판정 (단계 px) */
  lkCoarseEpsilon: number;
  /** LK 인라이어 재투영 RMS가 이 이하(px)면 거친 정렬 단계를 건너뛴다 (0 = 항상 거친 단계부터) */
  alignFineRms: number;
  /** 재검출: ORB 인라이어 RMS가 이 이하(px)면 정렬을 1단계부터 */
  detectFineRms: number;
  /** 거친 정렬 단계 수렴 판정 (단계 px) */
  alignCoarseEpsilon: number;
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
  // ── 앵커 ──
  /** 앵커 주변 거부 검증 창 한 변 (px, 0 = 끔). ROI를 넓히지 않았을 때만 */
  pinAreaSize: number;
  /** 앵커 주변 창 국소 최대 검사: 8방향으로 이만큼(px) 옮긴 H와 비교 */
  pinAreaShift: number;
  /** 옮긴 H의 창 NCC가 이만큼 더 높으면 거부 */
  pinAreaPeak: number;
  /** 창 블록 NCC 하위 25%가 pinAreaQ 미만이면 더 엄격하게: 옮긴 H가 pinAreaPeakWeak 이상이면 거부 */
  pinAreaQ: number;
  pinAreaPeakWeak: number;
  /** 앵커가 프레임 가장자리 밖으로 이 거리(px)까지는 '화면 안'으로 본다 */
  offscreenMargin: number;
  /** hint: 앵커가 프레임 중심에서 (프레임 대각선 × 이 값)보다 멀면 내지 않는다 */
  hintMaxDiag: number;
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
  reanchorInterval: 15,
  periodicOrb: false,

  lkWinRadius: 5,
  lkMaxIters: 10,
  lkMinEig: 2,
  lkMaxResidual: 40,
  lkCoarseEpsilon: 0.1,
  alignFineRms: 0.5,
  detectFineRms: 1.2,
  alignCoarseEpsilon: 0.1,
  fbThreshold: 1.0,
  fbLevels: 1,
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

  pinAreaSize: 48,
  pinAreaShift: 6,
  pinAreaPeak: 0.06,
  pinAreaQ: 0,
  pinAreaPeakWeak: -0.05,
  offscreenMargin: 2,
  hintMaxDiag: 3,
};

/** 기준 프레임에서 만든 모든 것 */
interface RefModel {
  width: number;
  height: number;
  roi: Rect;
  /** 주석 기준점 (setReference의 anchor, 없으면 요청 ROI 중심). 화면 밖이면 표시하지 않는다 */
  anchor: Point;
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
  /**
   * ROI를 넓히지 않았을 때: 앵커 바로 주변(작은 창) 검증기 — 거부권만 가진다.
   * 넓은 ROI의 지배 평면(예: 돌출된 키 윗면)과 앵커가 있는 면(키 사이 바닥)이 달라 시차로 어긋나면 표시하지 않는다.
   * 무늬가 없으면 null (넓은 검증에 맡긴다).
   */
  pinArea: VerifyModel | null;
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
  /**
   * 넓은(ROI 전체) 검증을 tracking 기준으로 통과했는가 — 핀 주변(inner) 검사는 뺀 것.
   * 앵커가 화면 밖일 때 hint를 낼 수 있는 조건 (핀 주변은 화면 밖이라 볼 수 없으므로).
   */
  hintOk: boolean;
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
  /** 앵커 주변 창 국소 최대 검사 (ROI를 넓히지 않았을 때): 창 NCC, 옮긴 H의 최대 이득, 하위 25% 블록 NCC */
  pin?: { ncc: number; gain: number; q25: number };
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
  // 표가 하나뿐인 변위는 우연한 닮음(잡음)이 대부분 — 반복 무늬면 여러 특징이 같은 변위에 모인다
  const list = [...votes.values()].filter((v) => v.n >= 2).sort((a, b) => b.n - a.n || a.sx - b.sx || a.sy - b.sy);
  const out: number[] = [];
  for (const v of list.slice(0, 24)) out.push(Math.round(v.sx / v.n), Math.round(v.sy / v.n));
  return out;
}

/** 특징 (단계, 위치) 키 — 같은 피라미드에서 같은 코너면 같은 디스크립터 */
function featKey(f: OrbFeatures, i: number): number {
  return f.level[i] * 67108864 + Math.round(f.y[i] * 4) * 8192 + Math.round(f.x[i] * 4);
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
  private lastPin: { ncc: number; gain: number; q25: number } | null = null;
  /** 마지막 setReference 단계별 시간(ms)·ROI 확장 반복 수 (진단용) */
  private refTimings: Record<string, number> = {};
  /** 앵커 주변 창 국소 최대 검사 (0, 0) + 8방향 이동 */
  private pinShifts: number[];
  /** 재검출용: 1배·2배 거리 */
  private pinShiftsWide: number[];
  private paG = new Float64Array(0);
  private paB = new Float32Array(0);
  private paBlocks: number[] = [];
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
  private refScale = new ScalePyramid();
  private curFeat = new OrbFeatures(1024);

  // 자세 이력
  private H: Mat3 | null = null;
  private tLast = 0;
  private Hprev: Mat3 | null = null;
  private tPrev = 0;
  private strongStreak = 0;
  private framesSinceDetect = 0;
  private framesSinceSlipCheck = 0;
  /** 추적 중 돕는 재검출이 연달아 실패한 횟수 (간격 늘리기) */
  private helpFails = 0;

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
  /** 거친 정렬 단계(마지막 단계 전)용: 다음 단계가 다시 다듬으므로 느슨한 수렴 */
  private alignCoarse: AlignParams;
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
      coarseEpsilon: c.lkCoarseEpsilon,
      minEig: c.lkMinEig,
      levels: c.pyramidLevels,
      maxResidual: c.lkMaxResidual,
    };
    this.lkBackParams = { ...this.lkParams, maxResidual: 0, levels: Math.max(1, Math.min(c.fbLevels, c.pyramidLevels)) };
    this.alignParams = { ...DEFAULT_ALIGN };
    this.alignCoarse = { ...DEFAULT_ALIGN, epsilon: c.alignCoarseEpsilon, maxIters: 10 };
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
    this.pinShifts = [0, 0];
    this.pinShiftsWide = [0, 0];
    for (let a = 0; a < 8; a++) {
      const th = (a * Math.PI) / 4;
      const dx = c.pinAreaShift * Math.cos(th);
      const dy = c.pinAreaShift * Math.sin(th);
      this.pinShifts.push(dx, dy);
      this.pinShiftsWide.push(dx, dy, 2 * dx, 2 * dy);
    }
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
    timings: Record<string, number>;
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
      timings: { ...this.refTimings },
    };
  }

  setReference(ref: GrayImage, roi: Rect, initialH?: Mat3, anchorPt?: Point): ReferenceInfo {
    this.clearReference();
    this.rng.reseed(this.config.seed);
    const c = this.config;
    const safeRoi: Rect = { x: 0, y: 0, width: 0, height: 0 };
    if (!isValidImage(ref) || !roi || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)) {
      return { roi: safeRoi, features: 0, trackable: false, reason: "low_texture" };
    }
    const W = ref.width;
    const H = ref.height;

    const rt: Record<string, number> = { iters: 0 };
    let tq = now();
    const lap = (k: string) => {
      const t2 = now();
      rt[k] = (rt[k] ?? 0) + (t2 - tq);
      tq = t2;
    };
    const pyr = new Pyramid();
    pyr.build(ref, Math.max(4, c.pyramidLevels));
    // 스케일 피라미드는 기준 설정 중에만 쓰므로 버퍼를 재사용한다 (기준 피라미드 pyr은 RefModel이 계속 들고 있다)
    const sp = this.refScale;
    sp.build(pyr, c.orbLevels);
    lap("pyramid");

    // 기준 프레임 전체 특징 (쌍둥이 판별용). FAST 코너는 캐시해 ROI 넓히기 반복에서 다시 쓴다
    const cornerCache = new OrbCornerCache();
    const all = new OrbFeatures(1024);
    this.orb.extract(sp, { ...this.orbParams, nFeatures: 600, cellSize: 16 }, all, null, false, cornerCache);
    lap("orbAll");
    const lv0 = pyr.levels[0];
    const border = c.lkWinRadius + 3;

    let r = this.sanitizeRoi(roi, W, H);
    const roi0 = { ...r };
    const hasAnchor = !!anchorPt && Number.isFinite(anchorPt.x) && Number.isFinite(anchorPt.y);
    const ax = hasAnchor ? anchorPt!.x : roi.x + roi.width / 2;
    const ay = hasAnchor ? anchorPt!.y : roi.y + roi.height / 2;
    const anchor: Point = { x: Math.min(W - 1, Math.max(0, ax)), y: Math.min(H - 1, Math.max(0, ay)) };
    const raw = new CornerList(2048);
    const sel = new CornerList(512);
    let nPool = -1;
    let feats = new OrbFeatures(512);
    /** 쌍둥이 캐시: 특징 키 → (거리 << 16) | (all 인덱스 + 1) */
    const twinCache = new Map<number, number>();
    let lkCorners: CornerList | null = null;
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
      rt.iters++;
      feats = new OrbFeatures(512);
      const m = c.roiMargin;
      this.orb.extract(
        sp,
        { ...this.orbParams, nFeatures: c.maxReferenceFeatures, cellSize: 12 },
        feats,
        { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m },
        false,
        cornerCache,
      );
      lap("orbRoi");
      // 쌍둥이 판별. 같은 (단계, 위치)의 특징은 디스크립터도 같으므로 이전 반복 결과를 다시 쓴다
      const twin = new Uint16Array(feats.n);
      const twinIdx = new Int32Array(feats.n);
      const todo: number[] = [];
      for (let i = 0; i < feats.n; i++) {
        const hit = twinCache.get(featKey(feats, i));
        if (hit !== undefined) {
          twin[i] = hit >>> 16;
          twinIdx[i] = (hit & 0xffff) - 1;
        } else {
          todo.push(i);
        }
      }
      if (todo.length > 0) {
        const sub = new OrbFeatures(todo.length);
        for (const i of todo) sub.pushFrom(feats, i);
        const excl = new Float32Array(sub.n);
        for (let i = 0; i < sub.n; i++) excl[i] = 6 * Math.pow(Math.SQRT2, sub.level[i]);
        const tw = new Uint16Array(sub.n);
        const ti = new Int32Array(sub.n);
        // 쌍둥이 거리는 twinShifts 한계(twinDistance + 15)까지만 필요하다
        const tb = c.twinDistance + 16;
        minDistanceOutside(sub.desc, sub.x, sub.y, excl, sub.n, all.desc, all.x, all.y, all.n, tw, ti, tb);
        for (let k = 0; k < todo.length; k++) {
          const i = todo[k];
          twin[i] = tw[k];
          twinIdx[i] = ti[k];
          twinCache.set(featKey(feats, i), tw[k] * 65536 + (ti[k] + 1));
        }
      }
      uniqueIdx = new Int32Array(feats.n);
      nUnique = 0;
      for (let i = 0; i < feats.n; i++) if (twin[i] > c.twinDistance) uniqueIdx[nUnique++] = i;
      lap("twins");

      // LK 점 풀은 특징 조건을 넘었을 때만 센다 (못 넘으면 어차피 넓힌다)
      const featsOk = feats.n >= c.targetReferenceFeatures && nUnique >= c.targetReferenceFeatures / 2;
      if (featsOk && iter > 0 && !lkCorners) {
        // 두 번째 넓히기부터는 0단계 전체 화면 코너를 한 번 구해 영역만 바꿔 쓴다
        lkCorners = new CornerList(2048);
        detectFast(lv0, Math.min(10, c.fastThreshold), border, lkCorners);
        scoreCorners(lv0, lkCorners, "mineig", 3);
      }
      nPool = featsOk ? this.buildPool(lv0, r, raw, sel, lkCorners) : -1;
      lap("pool");
      const enough = featsOk && nPool >= 2 * c.minInliers;
      const last = r.width >= W - 0.5 && r.height >= H - 0.5;
      // 자기유사성 검사(비쌈)는 이 ROI로 끝낼 수 있을 때만 (특징이 모자라면 어차피 넓힌다)
      verify = null;
      let ambiguous = false;
      if (enough || last || iter === 9) {
        verify = VerifyModel.build(pyr, r);
        lap("verifyBuild");
        repeatShifts = [];
        if (c.checkRepeats) {
          const shifts = twinShifts(feats, all, twin, twinIdx, c.twinDistance + 15);
          const scan = verify.scanRepeats(pyr, 8, crit, shifts);
          ambiguous = scan.ambiguous;
          repeatShifts = scan.peaks;
        }
        lap("repeats");
      }
      distinctive = !ambiguous;
      if (enough && !ambiguous) break;
      if (last) break;
      if (iter === 9) break; // (전체 화면에 먼저 닿으므로 실제로는 안 옴) 마지막 ROI와 특징이 어긋나지 않게
      r = this.expandRoi(r, c.roiExpandFactor, W, H);
    }

    if (!verify) verify = VerifyModel.build(pyr, r); // (루프가 항상 마지막 ROI에서 만들므로 안전장치)

    // 고유 특징 볼록껍질
    const ux = new Float64Array(nUnique);
    const uy = new Float64Array(nUnique);
    for (let k = 0; k < nUnique; k++) {
      ux[k] = feats.x[uniqueIdx[k]];
      uy[k] = feats.y[uniqueIdx[k]];
    }
    const uniqueHull = hullArea(ux, uy, nUnique, null);

    // LK 점 풀: ROI 안 0단계 코너 (마지막 반복의 ROI로 다시 — sel에 남아 있다)
    if (nPool < 0) nPool = this.buildPool(lv0, r, raw, sel, lkCorners);
    const poolX = new Float64Array(nPool);
    const poolY = new Float64Array(nPool);
    for (let k = 0; k < nPool; k++) {
      poolX[k] = sel.x[k];
      poolY[k] = sel.y[k];
    }

    lap("misc");
    // 정렬 템플릿 (단계 0..3)
    const templates: (AlignTemplate | null)[] = [];
    for (let l = 0; l < Math.min(4, pyr.length); l++) {
      const t = buildAlignTemplate(pyr.levels[l], l, r, c.alignSamples, 2);
      templates.push(t.n >= 24 ? t : null);
    }
    lap("templates");

    // 핀 주변 무늬: 앵커 중심 80×80. (주석이 실제로 있는 곳 — 선이면 무게중심 — 주변에 무늬가 있어야
    // 넓힌 ROI가 다른 평면일 때의 시차를 핀 주변 검증으로 잡을 수 있다)
    const pb = clampRect({ x: anchor.x - 40, y: anchor.y - 40, width: 80, height: 80 }, W, H);
    detectFast(lv0, Math.min(10, c.fastThreshold), border, raw, {
      x0: pb.x,
      y0: pb.y,
      x1: pb.x + pb.width,
      y1: pb.y + pb.height,
    });
    scoreCorners(lv0, raw, "mineig", 3);
    const pinCorners = minDistanceFilter(raw, sel, W, H, 5, 1000, c.lkMinEig);
    const pinNeed = Math.max(c.minPinCorners, Math.round(c.minPinCornerDensity * pb.width * pb.height));
    lap("pinCorners");

    const textured = feats.n >= c.minReferenceFeatures && nPool >= c.minWeakInliers && templates[0] !== null;
    const pinOk = pinCorners >= pinNeed;
    // 고객 쪽(initialH 없음)은 재검출로만 찾을 수 있다 → 반복 무늬라 재검출을 끄면 찾을 방법이 없다
    const detectable = distinctive && nUnique >= c.minDetectInliers;
    const trackable = textured && pinOk && (!!initialH || detectable);
    const reason: ReferenceInfo["reason"] = !textured
      ? "low_texture"
      : !pinOk
        ? "pin_blank"
        : !detectable
          ? "ambiguous"
          : undefined;

    // 넓어졌으면 요청 ROI(앵커가 밖이면 앵커 주변까지) 검증기
    let inner: VerifyModel | null = null;
    let innerBlind = false;
    let pinArea: VerifyModel | null = null;
    if (r.width * r.height >= 1.5 * roi0.width * roi0.height) {
      const ir = this.unionAround(roi0, anchor, c.minRoiSize / 2, W, H);
      // 핀 주변은 촘촘하게 (0단계 근처) — 작은 로고·글자 하나만 있어도 몇 px 어긋남이 드러나게
      inner = VerifyModel.build(pyr, ir, { samples: 3600, blocks: 6, minStd: 5 });
      innerBlind = inner.nTextured.every((k) => k === 0);
    } else if (c.pinAreaSize > 0) {
      const h = Math.max(16, Math.min(c.pinAreaSize, Math.min(r.width, r.height)) / 2);
      const pr = clampRect({ x: anchor.x - h, y: anchor.y - h, width: 2 * h, height: 2 * h }, W, H);
      if (pr.width >= 16 && pr.height >= 16) {
        // 1단계(1/2)에서 본다: 압축·블러의 잔무늬엔 둔감, 시차 수 px 어긋남엔 민감
        const m = VerifyModel.build(pyr, pr, { samples: 576, blocks: 4, minStd: 6, level: 1 });
        if ((m.nTextured[m.baseLevel] ?? 0) >= 3) pinArea = m;
      }
    }

    lap("inner");
    this.refTimings = rt;
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
      pinArea,
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
    const info: ReferenceInfo = { roi: { ...r }, features: feats.n, trackable };
    if (reason) info.reason = reason;
    return info;
  }

  process(frame: GrayImage, timestampMs: number): TrackResult {
    const t0 = now();
    const tm: TrackTimings = { total: 0 };
    const ref = this.ref;
    const valid = isValidImage(frame);
    if (!ref || !ref.trackable || !valid) {
      tm.total = now() - t0;
      // 이 프레임에선 위치를 낼 수 없으니 표시 상태(tracking/weak)로 알리지 않는다 (내부 상태는 유지)
      const res: TrackResult = {
        state: ref && !this.everLocked ? "searching" : "lost",
        H: null,
        hint: null,
        confidence: 0,
        inliers: 0,
        tracked: 0,
        redetected: false,
        timings: tm,
      };
      if (ref) res.reason = !valid ? "invalid_frame" : "untrackable";
      return res;
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
      // 주기적 미끄러짐 검사 (싸다, 광도만): 기준의 반복 이동량만큼 옮긴 H가 지금 H만큼 잘 맞으면
      // 한 주기 미끄러졌을 수 있다 → 그때만 ORB 재검출로 확인. (예전의 주기적 ORB 재검출을 대신한다)
      let suspect = false;
      this.framesSinceSlipCheck++;
      if (out.ok && out.H && c.reanchorInterval > 0 && this.framesSinceSlipCheck >= c.reanchorInterval) {
        const t1 = now();
        this.framesSinceSlipCheck = 0;
        if (ref.repeatShifts.length > 0 && ref.distinctive) {
          const v = ref.verify.evaluate(cur, out.H, c.blockGood, this.vres);
          suspect = !this.beatsRepeats(out.H, cur, v);
        }
        tm.verify = (tm.verify ?? 0) + (now() - t1);
      }
      const periodic = c.periodicOrb && c.reanchorInterval > 0 && this.framesSinceDetect >= c.reanchorInterval;
      // 추적은 되는데 약해서(인라이어 부족·정렬 실패) 돕는 재검출은, 연달아 실패하면 간격을 3→6→12→24프레임으로
      // 늘린다 (심한 압축·블러에선 엄격한 재검출 검증도 계속 떨어져 CPU만 쓴다). 추적 실패·미끄러짐 의심은 즉시.
      const helpGap = 3 << Math.min(3, this.helpFails);
      const needHelp = !out.ok || suspect || (out.wantReanchor && this.framesSinceDetect >= helpGap);
      if ((needHelp || periodic) && this.canDetect()) {
        this.framesSinceDetect = 0;
        const assisting = out.ok;
        // 추적이 살아 있으면 예측 위치 주변만 (미끄러짐은 한두 주기 안) → 절반 이하 비용
        const region = out.ok && out.H ? this.searchRegion(out.H, cur.width, cur.height) : null;
        const det = this.detectStep(cur, tm, region);
        if (assisting) this.helpFails = det.ok ? 0 : this.helpFails + 1;
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

    // 추적은 계속하되, 앵커가 화면 밖이면 '놓침'으로 알린다 (보이지 않는 주석을 표시 중이라 하지 않기).
    // 내부 상태는 그대로라 다시 들어오면 재검출 없이 바로 표시된다.
    // 이번 프레임 검증을 강하게 통과했으면 그 H를 hint로 (화면 밖 방향 화살표 전용).
    let state = this.state;
    let hint: Mat3 | null = null;
    let reason: LostReason | undefined;
    if (H) {
      const vis = this.anchorVisibility(H, frame.width, frame.height);
      if (vis !== "in") {
        if (vis === "out" && out && out.hintOk) hint = H.slice();
        state = "lost";
        H = null;
        reason = hint ? "offscreen" : "unverified";
      }
    } else {
      // 반복 무늬라 재검출이 꺼진 기준을 놓쳤으면 다시 찾을 방법이 없다 → 새로 찍어야 한다
      reason = this.canDetect() ? "unverified" : "untrackable";
    }
    tm.total = now() - t0;
    const res: TrackResult = {
      state,
      H: H ? H.slice() : null,
      hint,
      confidence: H ? conf : 0,
      inliers: out ? out.inliers : 0,
      tracked: out ? out.tracked : 0,
      redetected: out ? out.redetected : false,
      timings: tm,
    };
    if (reason) res.reason = reason;
    return res;
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

  /**
   * LK 점 풀 후보: r 안 0단계 FAST 코너 → Shi–Tomasi 점수 → 최소 간격 5px. sel에 점수순으로.
   * cached(전체 화면 코너·점수)가 있으면 검출 대신 영역으로 거른다.
   */
  private buildPool(lv0: GrayImage, r: Rect, raw: CornerList, sel: CornerList, cached: CornerList | null = null): number {
    const c = this.config;
    const x0 = Math.floor(r.x);
    const y0 = Math.floor(r.y);
    const x1 = Math.ceil(r.x + r.width);
    const y1 = Math.ceil(r.y + r.height);
    if (cached) {
      raw.reserve(cached.n);
      let n = 0;
      for (let i = 0; i < cached.n; i++) {
        const x = cached.x[i];
        const y = cached.y[i];
        if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
        raw.x[n] = x;
        raw.y[n] = y;
        raw.score[n] = cached.score[i];
        n++;
      }
      raw.n = n;
    } else {
      detectFast(lv0, Math.min(10, c.fastThreshold), c.lkWinRadius + 3, raw, { x0, y0, x1, y1 });
      scoreCorners(lv0, raw, "mineig", 3);
    }
    return minDistanceFilter(raw, sel, lv0.width, lv0.height, 5, c.maxTrackedPoints * 3, c.lkMinEig);
  }

  /** r ∪ (p ± h) 를 프레임으로 자른 것 */
  private unionAround(r: Rect, p: Point, h: number, W: number, H: number): Rect {
    const x0 = Math.min(r.x, p.x - h);
    const y0 = Math.min(r.y, p.y - h);
    const x1 = Math.max(r.x + r.width, p.x + h);
    const y1 = Math.max(r.y + r.height, p.y + h);
    return clampRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, W, H);
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

  /**
   * 앵커가 프레임에 보이는가: "in" = [−m, W−1+m] × [−m, H−1+m] 안 (m = offscreenMargin),
   * "out" = 밖이지만 방향을 믿을 만함 (카메라 앞, 프레임 중심에서 대각선 × hintMaxDiag 이내),
   * "far" = 카메라 뒤이거나 너무 멀어 방향도 믿기 어려움.
   */
  private anchorVisibility(H: Mat3, W: number, Hh: number): "in" | "out" | "far" {
    const a = this.ref!.anchor;
    const c = this.config;
    const w = H[6] * a.x + H[7] * a.y + H[8];
    if (!(w > 1e-9)) return "far";
    const x = (H[0] * a.x + H[1] * a.y + H[2]) / w;
    const y = (H[3] * a.x + H[4] * a.y + H[5]) / w;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "far";
    const m = c.offscreenMargin;
    if (x >= -m && y >= -m && x <= W - 1 + m && y <= Hh - 1 + m) return "in";
    const d = Math.hypot(x - (W - 1) / 2, y - (Hh - 1) / 2);
    return d <= c.hintMaxDiag * Math.hypot(W, Hh) ? "out" : "far";
  }

  private canDetect(): boolean {
    const r = this.ref;
    return !!r && r.distinctive && r.nUnique >= this.config.minDetectInliers;
  }

  // ───────────────────────── 내부: 상태 관리 ─────────────────────────

  private resetTracking(): void {
    this.helpFails = 0;
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
      hintOk: false,
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
          pin: this.lastPin ? { ...this.lastPin } : undefined,
        });
    };
    if (hyps.length === 0) {
      dbg("ransac", inl);
      return this.fail(n, inl);
    }

    // 3) 가설마다 기준 템플릿 직접 정렬 + 형상·시간·광도 검증 → 가장 잘 맞는 것
    let best: HypEval | null = null;
    for (let hi = 0; hi < hyps.length; hi++) {
      const Hh = hyps[hi];
      const tight = hi === 0 && inl >= c.minInliers && this.inlierRms(Hh, m) <= c.alignFineRms;
      const e = this.evalHypothesis(Hh, cur, pred, m, tm, tight);
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
    this.lastPin = null;
    const inner = this.innerCheck(Hfin, cur);
    const wideStrong =
      inl2 >= c.minInliers && (aligned || !c.alignEnabled) && blocksOk && v.ncc >= c.nccTrack && v.fracGood >= c.fracTrack;
    const strong = inner === 2 && wideStrong;
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
      hintOk: wideStrong && v.blocksVisible >= 2,
    };
  }

  /** cMask 인라이어의 재투영 RMS (px) */
  private inlierRms(H: Mat3, m: number): number {
    let s = 0;
    let k = 0;
    for (let j = 0; j < m; j++) {
      if (!this.cMask[j]) continue;
      s += reprojError2(H, this.cSx[j], this.cSy[j], this.cDx[j], this.cDy[j]);
      k++;
    }
    return k > 0 ? Math.sqrt(s / k) : Infinity;
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
  private evalHypothesis(Hlk: Mat3, cur: Pyramid, pred: Mat3, m: number, tm: TrackTimings, tight = false): HypEval | null {
    const c = this.config;
    const ref = this.ref!;
    let t = now();
    let H = Hlk;
    let aligned = false;
    if (c.alignEnabled) {
      // LK 점들이 이미 촘촘히 맞으면(재투영 RMS 작음) 0단계 정렬만 — 안 되면 거친 단계부터 다시
      let a = tight ? this.alignFrom(Hlk, cur, [0]) : null;
      if (!a || maxCornerDistance(a, Hlk, ref.roi) > c.alignMaxShift) a = this.alignFrom(Hlk, cur, [1, 0]);
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
    for (let pi = 0; pi < passes.length; pi++) {
      const base = passes[pi];
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
      const r = this.aligner.align(tpl, cur.levels[lc], lc, H, pi < passes.length - 1 ? this.alignCoarse : this.alignParams);
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
   * 핀 주변 검증: 0 = 어긋남(표시 금지), 1 = 약함(또는 확인 불가), 2 = 좋음.
   * ROI를 넓혔으면 요청 ROI 검증기(inner)로 블록 NCC를 직접 본다.
   * 넓히지 않았으면 앵커 주변 작은 창(pinArea)의 국소 최대 검사 — 거부(0)만 하고 나머지는 2.
   */
  private innerCheck(H: Mat3, cur: Pyramid, fresh = false): 0 | 1 | 2 {
    const ref = this.ref!;
    const c = this.config;
    if (!ref.inner) {
      // 넓히지 않은 ROI: 앵커 주변 작은 창이 "옆으로 조금 옮긴 H"에서 더 잘 맞으면 거부 (국소 최대 검사).
      // 절대 NCC가 아니라 상대 비교라 압축·블러·손 가림엔 둔감하고, 앵커가 다른 면(시차)이라 수 px 어긋난 것엔 민감하다.
      // 재검출(fresh)은 이전 자세와 이어지지 않은 새 주장이라 두 배 거리(시차가 큰 경우)까지 본다.
      const pa = ref.pinArea;
      if (!pa) return 2;
      const shifts = fresh ? this.pinShiftsWide : this.pinShifts;
      const ns = shifts.length >> 1;
      if (this.paG.length < ns) this.paG = new Float64Array(ns);
      if (this.paB.length < ns * pa.nBlocks) this.paB = new Float32Array(ns * pa.nBlocks);
      pa.shiftScores(cur, H, shifts, this.paG, this.paB);
      const g0 = this.paG[0];
      if (g0 <= -2) return 2;
      const q = this.paBlocks;
      q.length = 0;
      for (let b = 0; b < pa.nBlocks; b++) if (!Number.isNaN(this.paB[b])) q.push(this.paB[b]);
      if (q.length < 3) return 2;
      q.sort((a, b) => a - b);
      const q25 = q[Math.floor(q.length * 0.25)];
      let dg = -Infinity;
      for (let i = 1; i < ns; i++) if (this.paG[i] > -2) dg = Math.max(dg, this.paG[i] - g0);
      this.lastPin = { ncc: g0, gain: dg, q25 };
      if (dg > c.pinAreaPeak || (q25 < c.pinAreaQ && dg > c.pinAreaPeakWeak)) return 0;
      return 2;
    }
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
      this.orb.extract(this.curScale, { ...this.orbParams, nFeatures: nF }, f, region, true);
    } else {
      this.orb.extract(this.curScale, this.orbParams, f, null, true);
    }
    tm.detect = (tm.detect ?? 0) + (now() - t);

    t = now();
    const ml = this.matches;
    const nm = this.matcher.match(ref.feats.desc, ref.uniqueIdx, ref.nUnique, f.desc, f.n, this.matchParams, ml);
    tm.match = (tm.match ?? 0) + (now() - t);
    this.lastPin = null;
    const dbg = (result: string, inliers: number, spread?: number, verify?: VerifyResult) => {
      if (this.onDebug)
        this.onDebug({
          kind: "detect",
          result,
          matches: nm,
          inliers,
          spread,
          verify: verify ? { ...verify } : undefined,
          pin: this.lastPin ? { ...this.lastPin } : undefined,
        });
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

    // 정밀 정렬 (거친 단계부터). ORB 인라이어가 촘촘히 맞으면(RMS 작음) 2단계는 건너뛴다
    t = now();
    let Hfin: Mat3 | null = H1;
    if (c.alignEnabled) {
      const tight = this.inlierRms(H1, nm) <= c.detectFineRms;
      Hfin = this.alignFrom(H1, cur, tight ? [1, 0] : [2, 1, 0]);
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
    if (this.innerCheck(Hfin, cur, true) === 0) {
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
      hintOk: true,
    };
  }
}
