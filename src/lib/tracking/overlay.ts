import type { Annotation, Mat3, Point, Rect, TrackState, TrackUpdate } from "./types";
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

// ───────────────────────── 주석 기준점 ─────────────────────────

/**
 * 주석 하나의 기준점 (ref px). 핀 = 위치, 선 = 길이 가중 무게중심(점 간격이 고르지 않아도 모양의 중심).
 * norm → ref px 규약은 렌더링과 같다 (ref px = norm × 크기). 좌표가 이상하면 null.
 */
export function annotationAnchorPx(a: Annotation, refWidth: number, refHeight: number): Point | null {
  if (a.kind === "pin") {
    const x = a.p.x * refWidth;
    const y = a.p.y * refHeight;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  const pts = a.points;
  if (!pts || pts.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let sl = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x * refWidth;
    const ay = pts[i - 1].y * refHeight;
    const bx = pts[i].x * refWidth;
    const by = pts[i].y * refHeight;
    const l = Math.hypot(bx - ax, by - ay);
    sx += l * (ax + bx) * 0.5;
    sy += l * (ay + by) * 0.5;
    sl += l;
  }
  let x: number;
  let y: number;
  if (sl > 1e-9) {
    x = sx / sl;
    y = sy / sl;
  } else {
    // 길이 0 (한 점에 겹친 선) → 점 평균
    x = 0;
    y = 0;
    for (const p of pts) {
      x += p.x * refWidth;
      y += p.y * refHeight;
    }
    x /= pts.length;
    y /= pts.length;
  }
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * 앵커의 대표 기준점 (ref px) = 첫 주석(앵커를 만든 주석)의 기준점.
 * 추적기 setReference의 anchor, 화면 밖 화살표의 목표에 쓴다. 같은 앵커의 이후 주석은 첫 주석의 ROI 안에서
 * 추가된 것이므로 첫 주석이 대표로 충분하다 (여러 주석의 전체 중심을 쓰면 주석이 늘 때마다 기준이 바뀐다).
 */
export function primaryAnchorPx(annotations: readonly Annotation[], refWidth: number, refHeight: number): Point | null {
  for (const a of annotations) {
    const p = annotationAnchorPx(a, refWidth, refHeight);
    if (p) return p;
  }
  return null;
}

// ───────────────────────── 화면 밖 안내 화살표 ─────────────────────────
//
// 핀이 화면에 안 보이면 가장자리에 큰 화살표를 띄워 "이쪽으로 폰을 돌리세요"를 말 없이 알린다.
// - 보이는 영역은 CSS 공간에서 판단한다: 요소 사각형 ∩ 영상이 그려진 사각형.
//   cover(고객 화면)는 프레임 가장자리가 잘려 나가므로 프레임 안이어도 안 보일 수 있다 → 추적 중(H)이어도 화살표.
// - 프레임 밖이면 추적기의 hint(state=lost, reason=offscreen)로 방향을 잡는다. hint로는 주석을 그리지 않는다.
// - 카메라 뒤·무한원점(w ≤ 0)이어도 방향은 정의된다: d = (X − w·cx, Y − w·cy) (카메라 좌표의 옆 방향과 같다).
// - 깜빡임 방지 히스테리시스: 보이던 핀은 영역 밖으로 나가야 화살표, 화살표는 핀이 12px 이상 안쪽으로 들어와야 사라진다.

/** 화살표 끝을 둘 안쪽 사각형의 여백 (보이는 영역 가장자리에서, CSS px) */
export const ARROW_INSET_CSS = 28;
/** 화살표가 떠 있을 때 핀이 이만큼 안쪽으로 들어와야 사라진다 (CSS px) */
export const ARROW_HIDE_MARGIN_CSS = 12;
/** 화살표 전체 길이 (CSS px, 맥동 전) */
export const ARROW_LENGTH_CSS = 64;
const ARROW_PULSE_MS = 1200;
const ARROW_NUDGE_CSS = 8;
/** 무한원점으로 볼 CSS 좌표 크기 */
const FAR_CSS = 1e6;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface GuideArrow {
  /** 화살표 끝(뾰족한 곳) — 요소 기준 CSS px. 보이는 영역을 inset만큼 줄인 사각형 안으로 클램프 */
  x: number;
  y: number;
  /** 가리키는 방향 (라디안, 화면 좌표: 0 = 오른쪽, π/2 = 아래) */
  angle: number;
  /** 목표(주석 기준점)의 CSS 좌표. 카메라 뒤·무한원점이면 null */
  target: Point | null;
  /** track = 추적 중(H)이지만 보이는 영역 밖(cover 크롭 등) / hint = 프레임 밖(추적기 추정) */
  source: "track" | "hint";
}

/** 화살표 판단에 필요한 갱신 필드 */
export type GuideUpdate = Pick<TrackUpdate, "state" | "H" | "hint" | "reason" | "refSize" | "frameSize">;

export interface GuideOptions {
  /** 보이는 영역 가장자리에서 화살표 끝까지의 여백. 숫자 또는 변별 (예: 하단 버튼 영역 피하기) */
  inset?: number | Partial<Insets>;
  /** 직전에 화살표를 띄우고 있었는지 (히스테리시스) */
  showing?: boolean;
}

/** 영상이 실제로 보이는 영역 (요소 기준 CSS px) = 요소 ∩ 영상 사각형. cover면 요소 전체, contain이면 영상 사각형 */
export function visibleRect(m: DisplayMapping): Rect {
  const x0 = Math.max(0, m.x);
  const y0 = Math.max(0, m.y);
  const x1 = Math.min(m.elementWidth, m.x + m.width);
  const y1 = Math.min(m.elementHeight, m.y + m.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function resolveInsets(inset: GuideOptions["inset"]): Insets {
  if (typeof inset === "number") return { top: inset, right: inset, bottom: inset, left: inset };
  const d = ARROW_INSET_CSS;
  return { top: inset?.top ?? d, right: inset?.right ?? d, bottom: inset?.bottom ?? d, left: inset?.left ?? d };
}

/**
 * 화면 밖 안내 화살표 계산 (순수 함수). 필요 없으면 null.
 *  - state tracking/weak + H: 기준점이 보이는 영역 밖일 때 (히스테리시스 적용)
 *  - state lost + reason offscreen + hint: 항상 (추적기가 화면 밖이라고 판단)
 *  - 그 밖(searching, 다른 이유의 lost): null — 모르는 방향을 가리키지 않는다
 * anchorRef: 주석 기준점 (ref px, primaryAnchorPx).
 */
export function computeGuideArrow(
  u: GuideUpdate,
  anchorRef: Point,
  m: DisplayMapping,
  opts: GuideOptions = {},
): GuideArrow | null {
  let M: Mat3 | null = null;
  let source: GuideArrow["source"];
  if ((u.state === "tracking" || u.state === "weak") && u.H) {
    M = u.H;
    source = "track";
  } else if (u.state === "lost" && u.reason === "offscreen" && u.hint) {
    M = u.hint;
    source = "hint";
  } else {
    return null;
  }
  const fw = u.frameSize.width;
  const fh = u.frameSize.height;
  if (!(fw > 0) || !(fh > 0) || !Number.isFinite(anchorRef.x) || !Number.isFinite(anchorRef.y)) return null;
  for (let i = 0; i < 9; i++) if (!Number.isFinite(M[i])) return null;

  // 부호 고정: ref 중심이 카메라 앞(w > 0)이 되게 (H는 스케일·부호가 임의일 수 있다)
  const rcx = u.refSize.width / 2;
  const rcy = u.refSize.height / 2;
  const wc = M[6] * rcx + M[7] * rcy + M[8];
  const sgn = wc < 0 ? -1 : 1;
  const X = sgn * (M[0] * anchorRef.x + M[1] * anchorRef.y + M[2]);
  const Y = sgn * (M[3] * anchorRef.x + M[4] * anchorRef.y + M[5]);
  const W = sgn * (M[6] * anchorRef.x + M[7] * anchorRef.y + M[8]);

  const V = visibleRect(m);
  if (!(V.width > 0) || !(V.height > 0)) return null;
  const sx = m.width / fw;
  const sy = m.height / fh;

  let target: Point | null = null;
  if (W > 0) {
    const px = X / W;
    const py = Y / W;
    if (Number.isFinite(px) && Number.isFinite(py)) {
      const t = frameToCss(m, { x: px, y: py }, u.frameSize);
      if (Math.abs(t.x) < FAR_CSS && Math.abs(t.y) < FAR_CSS) target = t;
    }
  }

  if (source === "track" && target) {
    const margin = opts.showing ? ARROW_HIDE_MARGIN_CSS : 0;
    const inside =
      target.x >= V.x + margin &&
      target.x <= V.x + V.width - margin &&
      target.y >= V.y + margin &&
      target.y <= V.y + V.height - margin;
    if (inside) return null;
  }

  // 방향: 목표가 유한하면 (보이는 영역 중심 → 목표), 아니면 동차 좌표의 옆 방향
  const vcx = V.x + V.width / 2;
  const vcy = V.y + V.height / 2;
  let aim: Point;
  if (target) {
    aim = target;
  } else {
    const fcx = (fw - 1) / 2;
    const fcy = (fh - 1) / 2;
    const dx = (X - W * fcx) * sx;
    const dy = (Y - W * fcy) * sy;
    const len = Math.hypot(dx, dy);
    if (!(len > 0) || !Number.isFinite(len)) return null;
    aim = { x: vcx + (dx / len) * FAR_CSS, y: vcy + (dy / len) * FAR_CSS };
  }

  // 화살표 끝 = 목표를 안쪽 사각형으로 클램프 (사각형이 너무 작으면 중심으로 모인다)
  const ins = resolveInsets(opts.inset);
  const left = V.x + Math.min(ins.left, V.width / 2);
  const right = V.x + V.width - Math.min(ins.right, V.width / 2);
  const top = V.y + Math.min(ins.top, V.height / 2);
  const bottom = V.y + V.height - Math.min(ins.bottom, V.height / 2);
  const x = Math.min(Math.max(aim.x, Math.min(left, right)), Math.max(left, right));
  const y = Math.min(Math.max(aim.y, Math.min(top, bottom)), Math.max(top, bottom));
  let dx = aim.x - x;
  let dy = aim.y - y;
  if (Math.hypot(dx, dy) < 1) {
    // 목표가 안쪽 사각형 안(가장자리 여백 띠) — 영역 중심에서 목표 쪽으로
    dx = aim.x - vcx;
    dy = aim.y - vcy;
    if (Math.hypot(dx, dy) < 1e-9) {
      dx = 0;
      dy = 1;
    }
  }
  return { x, y, angle: Math.atan2(dy, dx), target, source };
}

/**
 * renderAnnotations가 그릴 수 있는 영역 (요소 기준 CSS px, 여유 포함). 부분 지우기용 — 넉넉하게 잡는다.
 * 핀: 최대 반지름 80 × 맥동 1.45 + 테두리. 선: 점들의 외접 사각형 + 선 두께. 카메라 뒤로 가는 점이 있으면 null(전체).
 */
export function annotationBounds(
  annotations: readonly Annotation[],
  H: Mat3,
  refSize: SizeLike,
  frameSize: SizeLike,
  m: DisplayMapping,
): Rect | null {
  const G = normToCssMatrix(H, refSize, frameSize, m);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Point, pad: number): boolean => {
    const w = G[6] * p.x + G[7] * p.y + G[8];
    if (!(w > 1e-9)) return false;
    const x = (G[0] * p.x + G[1] * p.y + G[2]) / w;
    const y = (G[3] * p.x + G[4] * p.y + G[5]) / w;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    x0 = Math.min(x0, x - pad);
    y0 = Math.min(y0, y - pad);
    x1 = Math.max(x1, x + pad);
    y1 = Math.max(y1, y + pad);
    return true;
  };
  const pinPad = PIN_MAX_CSS_RADIUS * 1.45 + 8;
  for (const a of annotations) {
    if (a.kind === "pin") {
      if (!add(a.p, pinPad)) return null;
    } else {
      for (const p of a.points) if (!add(p, 8)) return null;
    }
  }
  if (!(x1 >= x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** renderGuideArrow가 그릴 수 있는 영역 (CSS px, 회전·맥동·테두리 포함) */
export function guideArrowBounds(a: GuideArrow): Rect {
  const r = ARROW_LENGTH_CSS * 1.06 + ARROW_NUDGE_CSS + 12;
  return { x: a.x - r, y: a.y - r, width: 2 * r, height: 2 * r };
}

/** 화살표를 잠깐 놓쳤을 때(hint가 한두 프레임 빠짐 등) 유지하는 시간 (ms) */
export const ARROW_HOLD_MS = 300;

/**
 * 프레임마다 화살표 상태를 이어 가는 도우미 (히스테리시스 + 짧은 공백 메우기).
 * 세션(스냅샷의 arrow 플래그)과 AnchorOverlay(그리기)가 같은 규칙을 쓰도록 한 곳에 둔다.
 * - 추적 중이고 기준점이 보이면 즉시 해제 (보이는 핀 옆에 화살표를 남기지 않는다)
 * - 자세를 모르게 되면(hint 없음·searching) holdMs 동안만 마지막 화살표 유지, 그 뒤 해제
 */
export class GuideArrowState {
  private last: GuideArrow | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly holdMs = ARROW_HOLD_MS) {}

  showing(): boolean {
    return this.last !== null;
  }

  current(): GuideArrow | null {
    return this.last;
  }

  reset(): void {
    this.last = null;
    this.lastAt = Number.NEGATIVE_INFINITY;
  }

  next(
    u: GuideUpdate | null,
    anchorRef: Point | null,
    m: DisplayMapping | null,
    nowMs: number,
    opts: Omit<GuideOptions, "showing"> = {},
  ): GuideArrow | null {
    let a: GuideArrow | null = null;
    let visible = false;
    if (u && anchorRef && m) {
      a = computeGuideArrow(u, anchorRef, m, { ...opts, showing: this.last !== null });
      visible = !a && (u.state === "tracking" || u.state === "weak") && !!u.H;
    }
    if (a) {
      this.last = a;
      this.lastAt = nowMs;
      return a;
    }
    if (!visible && this.last && nowMs - this.lastAt < this.holdMs) return this.last;
    this.last = null;
    return null;
  }
}

/** 화살표 그리기용 컨텍스트 부분 */
export type ArrowContext = OverlayContext & Pick<CanvasRenderingContext2D, "translate" | "rotate" | "scale">;

// 끝이 원점, +x를 향하는 화살표 (길이 64: 머리 28, 머리 폭 48, 몸통 폭 20)
const ARROW_SHAPE: readonly (readonly [number, number])[] = [
  [0, 0],
  [-28, 24],
  [-28, 10],
  [-64, 10],
  [-64, -10],
  [-28, -10],
  [-28, -24],
];

/**
 * 화살표 그리기: 어두운 테두리(밝은 배경 대비) + 흰 테두리 + 빨간 채움. 목표 쪽으로 살짝 밀었다 돌아오는 맥동.
 * ctx는 CSS 픽셀 좌표계 (renderAnnotations와 같음).
 */
export function renderGuideArrow(ctx: ArrowContext, a: GuideArrow, opts: RenderOptions = {}): void {
  const opacity = opts.opacity ?? 1;
  if (!(opacity > 0) || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.angle)) return;
  const t = opts.timeMs ?? 0;
  const phase = (((t % ARROW_PULSE_MS) + ARROW_PULSE_MS) % ARROW_PULSE_MS) / ARROW_PULSE_MS;
  // 0 → 1 → 0 부드럽게 (코사인)
  const k = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  const nudge = ARROW_NUDGE_CSS * k;
  const scale = 1 + 0.06 * k;
  ctx.save();
  ctx.globalAlpha = Math.min(1, opacity);
  ctx.translate(a.x, a.y);
  ctx.rotate(a.angle);
  // 끝이 클램프 위치를 넘지 않게: 뒤에서 앞으로 밀었다가 제자리
  ctx.translate(nudge - ARROW_NUDGE_CSS, 0);
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < ARROW_SHAPE.length; i++) {
    const [x, y] = ARROW_SHAPE[i];
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 11;
  ctx.stroke();
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = RED;
  ctx.fill();
  ctx.restore();
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
