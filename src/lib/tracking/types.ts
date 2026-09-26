// 평면 앵커 추적 — 모듈 간 공용 타입 (계약).
// 이 파일은 DOM·Worker에 의존하지 않는다. cv/·tracker는 순수 계산, 브라우저 글루는 별도 파일.
//
// 좌표계 3종:
//   ref   — 앵커 기준 프레임(엔지니어가 찍은 순간의 프레임)의 작업 해상도 픽셀 좌표
//   frame — 현재 처리 중인 프레임의 작업 해상도 픽셀 좌표
//   norm  — 0~1 정규화 좌표 (ref 기준). 네트워크로 오가는 주석 좌표는 전부 이것 (CLAUDE.md)
// 호모그래피 H는 ref 픽셀 → frame 픽셀.

/** 8비트 그레이스케일, row-major. data.length === width * height */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Point {
  x: number;
  y: number;
}

/** 축 정렬 사각형 (x, y는 좌상단) */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 3x3 행렬, row-major, 길이 9. H[8]로 정규화하지 않아도 됨 */
export type Mat3 = number[];

/**
 * searching — 기준은 있는데 아직 한 번도 못 찾음 (고객 쪽 최초 탐색)
 * tracking  — 신뢰할 만한 위치
 * weak      — 위치는 있으나 신뢰도 낮음 (흐리게 표시)
 * lost      — 놓침. 표시하지 않는다 (틀린 곳을 가리키는 것보다 안 보이는 게 낫다)
 */
export type TrackState = "searching" | "tracking" | "weak" | "lost";

export interface TrackTimings {
  /** 프레임 1장 처리 총 시간(ms) */
  total: number;
  /** 세부 단계(선택): pyramid, lk, ransac, align, verify, replenish, detect, match */
  [stage: string]: number;
}

/**
 * lost/searching의 이유 (UI 안내·지표용).
 * offscreen — 앵커가 화면 밖으로 나갔을 뿐 내부적으로는 추적 중 (hint 제공)
 * unverified — 후보는 있으나 검증 실패 (반복 패턴 등)
 * untrackable — 기준 자체가 추적 불가 (ReferenceInfo.trackable=false)
 * invalid_frame — 입력 프레임 오류
 */
export type LostReason = "offscreen" | "unverified" | "untrackable" | "invalid_frame";

export interface TrackResult {
  state: TrackState;
  /** ref → frame. state가 tracking/weak일 때만 non-null */
  H: Mat3 | null;
  /**
   * state가 lost인데 앵커만 화면 밖으로 나간 경우(reason=offscreen)의 내부 추정 H.
   * 주석을 그리는 데 쓰면 안 된다 — "화면 밖 이쪽에 있어요" 가장자리 화살표에만 쓴다.
   * 그 외에는 null.
   */
  hint: Mat3 | null;
  reason?: LostReason;
  /** 0~1. UI 투명도·상태 판정에 사용 */
  confidence: number;
  /** 이번 프레임에서 호모그래피를 지지한 점 수 */
  inliers: number;
  /** 이번 프레임에서 추적 중이던 점 수 */
  tracked: number;
  /** 이번 프레임에서 재검출(ORB 매칭)을 수행했는지 */
  redetected: boolean;
  timings: TrackTimings;
}

/** setReference 결과 — 텍스처 부족 등을 UI에 알리기 위함 */
export interface ReferenceInfo {
  /** 추적에 쓸 ROI (ref 픽셀). 특징점이 부족하면 요청보다 넓어질 수 있다 */
  roi: Rect;
  /** ROI 안 특징점 수 */
  features: number;
  /** false면 무늬가 너무 없어 추적 불가 — 호출측은 정지 화면 방식으로 폴백 */
  trackable: boolean;
  /**
   * trackable=false 이거나 제약이 있을 때의 이유.
   * low_texture — ROI 전체에 무늬가 부족 / pin_blank — 핀 주변만 비어 있음
   * ambiguous — 똑같은 무늬가 반복돼 재검출을 끔 (추적은 가능할 수 있음)
   */
  reason?: "low_texture" | "pin_blank" | "ambiguous";
}

export interface TrackerConfig {
  /** 피라미드 단계 수 (LK·정렬용) */
  pyramidLevels: number;
  /** 추적 점 최대 개수 */
  maxTrackedPoints: number;
  /** ORB 기준 특징점 최대 개수 */
  maxReferenceFeatures: number;
  /** RANSAC 재투영 허용 오차 (frame 픽셀) */
  ransacThreshold: number;
  /** tracking 판정 최소 인라이어 수 */
  minInliers: number;
  /** 이 인라이어 수 미만이면 weak가 아니라 lost */
  minWeakInliers: number;
  /** RANSAC 난수 시드 (결정적 테스트용) */
  seed: number;
  [key: string]: number | boolean;
}

/**
 * 순수 추적기 인터페이스. 동기·결정적(같은 입력 → 같은 출력), DOM 없음.
 * Worker 안에서 돌고, 벤치마크(Node)에서도 그대로 돈다.
 */
export interface PlanarTrackerApi {
  /**
   * 기준 프레임 설정. roi는 ref 픽셀 좌표 (보통 엔지니어가 찍은 점 주변).
   * initialH가 있으면 "지금 프레임이 곧 기준"이라는 뜻(엔지니어 쪽: 단위행렬) — 탐색 없이 바로 tracking.
   * 없으면 searching에서 시작해 ORB 매칭으로 찾는다(고객 쪽).
   * anchor는 주석이 실제로 있는 곳(ref 픽셀) — 화면 밖 판정·핀 주변 검증의 기준. 없으면 ROI 중심.
   * initialH를 줘도 trackable=false면 tracking을 시작하지 않는다 (searching/lost 유지).
   */
  setReference(ref: GrayImage, roi: Rect, initialH?: Mat3, anchor?: Point): ReferenceInfo;
  clearReference(): void;
  hasReference(): boolean;
  /** 프레임 1장 처리. frame 크기는 호출마다 달라질 수 있다(회전 등) */
  process(frame: GrayImage, timestampMs: number): TrackResult;
}

// ───────────────────────── 주석(annotation) ─────────────────────────

/** 탭 → 핀 */
export interface PinAnnotation {
  id: string;
  kind: "pin";
  /** norm 좌표 (ref 기준) */
  p: Point;
}

/** 드래그 → 자유선 */
export interface StrokeAnnotation {
  id: string;
  kind: "stroke";
  /** norm 좌표 (ref 기준) */
  points: Point[];
}

export type Annotation = PinAnnotation | StrokeAnnotation;

/** 앵커 = 기준 프레임 1장 + 그 위의 주석들. 한 번에 하나만 활성 */
export interface AnchorDescriptor {
  id: string;
  /** ref 작업 해상도 */
  refWidth: number;
  refHeight: number;
  /** norm 좌표 ROI */
  roi: Rect;
  annotations: Annotation[];
}

/** 메인 스레드 UI가 받는 추적 갱신 */
export interface TrackUpdate {
  anchorId: string;
  state: TrackState;
  /** ref 픽셀 → frame 픽셀. tracking/weak일 때만 */
  H: Mat3 | null;
  /** TrackResult.hint 그대로 — 화면 밖 방향 화살표 전용 */
  hint: Mat3 | null;
  reason?: LostReason;
  confidence: number;
  refSize: { width: number; height: number };
  /** 처리된 프레임의 작업 해상도 */
  frameSize: { width: number; height: number };
  /** 처리 시간(ms) — 적응형 프레임레이트·지표용 */
  processMs: number;
}
