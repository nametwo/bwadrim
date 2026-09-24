import type { Annotation, Mat3, Point, TrackState } from "./types";
import { mul3 } from "./geometry";

// 영상 위 주석 렌더링: object-fit 매핑(frame 픽셀 ↔ 요소 CSS 픽셀) + H로 원근 변환.
// 순수 계산 + CanvasRenderingContext2D 호출만 (DOM 조회 없음, SSR 안전).
//
// 픽셀 규약: frame 픽셀 좌표는 픽셀 중심이 정수 (추적기와 같음). 프레임 이미지는 [-0.5, W-0.5]를 덮고,
// 그것이 화면의 영상 사각형 전체에 대응한다: css = rect.x + (p + 0.5) · rect.width / W.

export type ObjectFit = "cover" | "contain" | "fill";

export interface DisplayMapping {
  /** 영상이 실제로 그려지는 사각형 (요소 기준 CSS px). cover면 요소 밖으로 넘친다 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 요소 크기 (CSS px) */
  elementWidth: number;
  elementHeight: number;
  devicePixelRatio: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

const RED = "#FF3B30";
const WHITE = "#FFFFFF";
/** 핀 반지름: ref 너비의 4% (ref 평면 위의 원 → 원근 타원) */
export const PIN_REF_RADIUS = 0.04;
export const PIN_MIN_CSS_RADIUS = 14;
export const PIN_MAX_CSS_RADIUS = 80;
const PIN_SAMPLES = 32;
const PULSE_PERIOD_MS = 1600;
/** 너무 먼(지평선 근처) 점은 ref 중심 깊이의 이 비율에서 자른다 → 화면 좌표 폭주 방지 */
const W_CLIP_FRACTION = 0.02;

/** 영상 원본 크기·요소 크기·object-fit → 영상이 그려지는 사각형. 크기를 모르면 null */
export function computeDisplayMapping(
  videoWidth: number,
  videoHeight: number,
  elementWidth: number,
  elementHeight: number,
  fit: ObjectFit = "contain",
  devicePixelRatio = 1,
): DisplayMapping | null {
  if (!(videoWidth > 0) || !(videoHeight > 0) || !(elementWidth > 0) || !(elementHeight > 0)) return null;
  let width: number;
  let height: number;
  if (fit === "fill") {
    width = elementWidth;
    height = elementHeight;
  } else {
    const sx = elementWidth / videoWidth;
    const sy = elementHeight / videoHeight;
    const s = fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
    width = videoWidth * s;
    height = videoHeight * s;
  }
  return {
    // object-position 기본값 50% 50%
    x: (elementWidth - width) / 2,
    y: (elementHeight - height) / 2,
    width,
    height,
    elementWidth,
    elementHeight,
    devicePixelRatio: devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1,
  };
}

/** frame 픽셀 → 요소 CSS 픽셀 */
export function frameToCss(m: DisplayMapping, p: Point, frame: SizeLike): Point {
  return {
    x: m.x + ((p.x + 0.5) * m.width) / frame.width,
    y: m.y + ((p.y + 0.5) * m.height) / frame.height,
  };
}

/** 요소 CSS 픽셀 → frame 픽셀 */
export function cssToFrame(m: DisplayMapping, p: Point, frame: SizeLike): Point {
  return {
    x: ((p.x - m.x) * frame.width) / m.width - 0.5,
    y: ((p.y - m.y) * frame.height) / m.height - 0.5,
  };
}

/** 포인터 이벤트(clientX/Y) → frame 픽셀. rect는 매핑을 계산한 요소의 getBoundingClientRect() */
export function toFramePx(
  m: DisplayMapping,
  ev: { clientX: number; clientY: number },
  rect: { left: number; top: number },
  frame: SizeLike,
): Point {
  return cssToFrame(m, { x: ev.clientX - rect.left, y: ev.clientY - rect.top }, frame);
}

/** frame 픽셀 점이 프레임 이미지 안인가 (margin: frame 픽셀) */
export function insideFrame(p: Point, frame: SizeLike, margin = 0): boolean {
  return p.x >= -0.5 - margin && p.y >= -0.5 - margin && p.x <= frame.width - 0.5 + margin && p.y <= frame.height - 0.5 + margin;
}

/** 요소 CSS 크기·dpr → 캔버스 백버퍼 크기 */
export function canvasBackingSize(cssWidth: number, cssHeight: number, dpr: number): SizeLike {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return { width: Math.max(1, Math.round(cssWidth * d)), height: Math.max(1, Math.round(cssHeight * d)) };
}

/** frame 픽셀 → CSS 픽셀 아핀 행렬 */
export function frameToCssMatrix(m: DisplayMapping, frame: SizeLike): Mat3 {
  const sx = m.width / frame.width;
  const sy = m.height / frame.height;
  return [sx, 0, m.x + 0.5 * sx, 0, sy, m.y + 0.5 * sy, 0, 0, 1];
}

/** norm(ref 기준) → CSS 픽셀 호모그래피: (frame→css) · H · (norm→ref px) */
export function normToCssMatrix(H: Mat3, ref: SizeLike, frame: SizeLike, m: DisplayMapping): Mat3 {
  const R: Mat3 = [ref.width, 0, 0, 0, ref.height, 0, 0, 0, 1];
  return mul3(frameToCssMatrix(m, frame), mul3(H, R));
}

/** 상태별 불투명도: tracking 1, weak 0.45, 나머지 숨김 */
export function stateOpacity(state: TrackState | null | undefined): number {
  if (state === "tracking") return 1;
  if (state === "weak") return 0.45;
  return 0;
}

export interface RenderOptions {
  /** 0~1 */
  opacity?: number;
  /** 맥동 애니메이션 시각 (ms) */
  timeMs?: number;
}

/** 렌더링에 쓰는 2D 컨텍스트 부분 (테스트용 가짜를 넣을 수 있게) */
export type OverlayContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "arc"
  | "stroke"
  | "fill"
  | "globalAlpha"
  | "strokeStyle"
  | "fillStyle"
  | "lineWidth"
  | "lineJoin"
  | "lineCap"
>;

// 핀 링 좌표 작업 버퍼 (프레임마다 할당하지 않기 위해)
const ringX = new Float64Array(PIN_SAMPLES);
const ringY = new Float64Array(PIN_SAMPLES);
const COS = new Float64Array(PIN_SAMPLES);
const SIN = new Float64Array(PIN_SAMPLES);
for (let k = 0; k < PIN_SAMPLES; k++) {
  COS[k] = Math.cos((2 * Math.PI * k) / PIN_SAMPLES);
  SIN[k] = Math.sin((2 * Math.PI * k) / PIN_SAMPLES);
}

/**
 * 주석 그리기. ctx는 CSS 픽셀 좌표계여야 한다 (호출측이 setTransform(dpr, 0, 0, dpr, 0, 0)).
 * H: ref 픽셀 → frame 픽셀 (TrackUpdate.H). frameSize: H가 가리키는 프레임 크기 (TrackUpdate.frameSize).
 * 카메라 뒤·지평선 너머로 가는 점은 잘라내고 그린다 (applyH null과 같은 경우).
 */
export function renderAnnotations(
  ctx: OverlayContext,
  annotations: readonly Annotation[],
  H: Mat3 | null,
  refSize: SizeLike,
  frameSize: SizeLike,
  mapping: DisplayMapping,
  opts: RenderOptions = {},
): void {
  const opacity = opts.opacity ?? 1;
  if (!H || !(opacity > 0) || annotations.length === 0) return;
  if (!(refSize.width > 0) || !(refSize.height > 0) || !(frameSize.width > 0) || !(frameSize.height > 0)) return;
  const G = normToCssMatrix(H, refSize, frameSize, mapping);
  for (let i = 0; i < 9; i++) if (!Number.isFinite(G[i])) return;
  // 깊이(w) 하한: ref 중심의 깊이 기준
  const wc = G[6] * 0.5 + G[7] * 0.5 + G[8];
  if (!(wc > 1e-12)) return;
  const wMin = wc * W_CLIP_FRACTION;
  const aspect = refSize.width / refSize.height;

  ctx.save();
  ctx.globalAlpha = Math.min(1, opacity);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // 선을 먼저, 핀을 위에
  for (const a of annotations) if (a.kind === "stroke") drawStroke(ctx, G, a.points, wMin);
  const t = opts.timeMs ?? 0;
  for (const a of annotations) if (a.kind === "pin") drawPin(ctx, G, a.p, aspect, wMin, t);
  ctx.restore();
}

function drawStroke(ctx: OverlayContext, G: Mat3, points: readonly Point[], wMin: number) {
  if (points.length < 2) return;
  ctx.beginPath();
  let pen = false;
  let any = false;
  let pX = 0;
  let pY = 0;
  let pW = 0;
  for (let i = 0; i < points.length; i++) {
    const nx = points[i].x;
    const ny = points[i].y;
    const X = G[0] * nx + G[1] * ny + G[2];
    const Y = G[3] * nx + G[4] * ny + G[5];
    const W = G[6] * nx + G[7] * ny + G[8];
    if (i > 0) {
      const inA = pW > wMin;
      const inB = W > wMin;
      if (inA && inB) {
        if (!pen) ctx.moveTo(pX / pW, pY / pW);
        ctx.lineTo(X / W, Y / W);
        pen = true;
        any = true;
      } else if (inA !== inB) {
        // 선분을 깊이 wMin에서 자른다 (동차 좌표에서 선형)
        const s = (wMin - pW) / (W - pW);
        const cX = pX + s * (X - pX);
        const cY = pY + s * (Y - pY);
        const cW = wMin;
        if (inA) {
          if (!pen) ctx.moveTo(pX / pW, pY / pW);
          ctx.lineTo(cX / cW, cY / cW);
          pen = false;
        } else {
          ctx.moveTo(cX / cW, cY / cW);
          ctx.lineTo(X / W, Y / W);
          pen = true;
        }
        any = true;
      } else {
        pen = false;
      }
    }
    pX = X;
    pY = Y;
    pW = W;
  }
  if (!any) return;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 6;
  ctx.stroke();
}

function ringPath(ctx: OverlayContext, cx: number, cy: number, scale: number) {
  ctx.beginPath();
  for (let k = 0; k < PIN_SAMPLES; k++) {
    const x = cx + (ringX[k] - cx) * scale;
    const y = cy + (ringY[k] - cy) * scale;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawPin(ctx: OverlayContext, G: Mat3, p: Point, aspect: number, wMin: number, timeMs: number) {
  const w = G[6] * p.x + G[7] * p.y + G[8];
  if (!(w > wMin)) return;
  const cx = (G[0] * p.x + G[1] * p.y + G[2]) / w;
  const cy = (G[3] * p.x + G[4] * p.y + G[5]) / w;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

  // ref 평면 위 원 (반지름 = ref 너비의 4%) → 원근 변환한 다각형
  const rx = PIN_REF_RADIUS;
  const ry = PIN_REF_RADIUS * aspect; // norm y 단위로 같은 픽셀 반지름
  let ok = true;
  for (let k = 0; k < PIN_SAMPLES; k++) {
    const nx = p.x + rx * COS[k];
    const ny = p.y + ry * SIN[k];
    const W = G[6] * nx + G[7] * ny + G[8];
    if (!(W > wMin)) {
      ok = false;
      break;
    }
    ringX[k] = (G[0] * nx + G[1] * ny + G[2]) / W;
    ringY[k] = (G[3] * nx + G[4] * ny + G[5]) / W;
  }
  let radius = 0;
  if (ok) {
    let area = 0;
    for (let k = 0, j = PIN_SAMPLES - 1; k < PIN_SAMPLES; j = k++) {
      area += ringX[j] * ringY[k] - ringX[k] * ringY[j];
    }
    radius = Math.sqrt(Math.abs(area) / 2 / Math.PI);
  }
  if (!ok || !(radius > 1e-6) || !Number.isFinite(radius)) {
    // 원근 타원을 못 만들면(일부가 카메라 뒤) 최소 크기 원으로
    radius = PIN_MIN_CSS_RADIUS;
    for (let k = 0; k < PIN_SAMPLES; k++) {
      ringX[k] = cx + radius * COS[k];
      ringY[k] = cy + radius * SIN[k];
    }
  }
  const clamped = Math.min(PIN_MAX_CSS_RADIUS, Math.max(PIN_MIN_CSS_RADIUS, radius));
  const s = clamped / radius;

  // 맥동: 바깥으로 퍼지며 사라지는 얇은 링
  const phase = (((timeMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.5 * (1 - phase);
  ringPath(ctx, cx, cy, s * (1 + 0.45 * phase));
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.globalAlpha = alpha;

  // 링: 흰 테두리 + 빨간 링
  ringPath(ctx, cx, cy, s);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 4;
  ctx.stroke();

  // 중심점
  const dot = Math.min(7, Math.max(3, clamped * 0.18));
  ctx.beginPath();
  ctx.arc(cx, cy, dot + 1.5, 0, 2 * Math.PI);
  ctx.fillStyle = WHITE;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, dot, 0, 2 * Math.PI);
  ctx.fillStyle = RED;
  ctx.fill();
}

// ───────────────────────── DOM 편의 함수 (호출 시점에만 DOM 접근) ─────────────────────────

/** <video> 요소의 현재 레이아웃으로 매핑 계산 (메타데이터 전이면 null) */
export function mappingForVideo(
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "clientWidth" | "clientHeight">,
  fit: ObjectFit,
  dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
): DisplayMapping | null {
  return computeDisplayMapping(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight, fit, dpr);
}
