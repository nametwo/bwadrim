"use client";

import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import type { AnchorDescriptor, Annotation, Point, Rect, TrackUpdate } from "@/lib/tracking/types";
import {
  GuideArrowState,
  annotationBounds,
  canvasBackingSize,
  guideArrowBounds,
  computeDisplayMapping,
  primaryAnchorPx,
  renderAnnotations,
  renderGuideArrow,
  stateOpacity,
  type Insets,
  type ObjectFit,
} from "@/lib/tracking/overlay";

// 영상 위에 앵커 주석(핀·선)을 그리는 캔버스. <video>와 같은 relative 컨테이너 안에 둔다:
//
//   <div className="relative">
//     <video ref={videoRef} className="h-full w-full object-contain" />
//     <AnchorOverlay video={videoRef} fit="contain" anchor={snap.anchor} update={snap.update} />
//   </div>
//
// - 앵커가 있는 동안만 다시 그린다 (없으면 유휴). 갱신·레이아웃이 바뀌면 그 프레임에 바로,
//   맥동 애니메이션만 있을 때는 ~30fps로 (추적 갱신이 20~30fps라 눈에 띄는 차이 없이 그리기 비용 절반)
// - tracking = 선명, weak = 45% 불투명, lost/searching = 숨김 (틀린 곳을 가리키느니 안 보이는 게 낫다)
// - 포인터 이벤트는 통과시킨다 (pointer-events: none) — 입력은 컨테이너가 받는다
// - getUpdate를 주면 매 프레임 그걸로 최신 H를 읽는다 → 추적 갱신마다 React를 재렌더할 필요 없음
// - 화면 밖 안내 화살표: 핀(첫 주석의 기준점)이 보이는 영역 밖이면 가장자리에 큰 빨간 화살표가 핀 쪽을 가리키며
//   살짝 맥동한다. 보이는 영역은 CSS 공간에서 판단 (cover면 잘린 가장자리도 "안 보임"). 추적 중(H) 또는
//   추적기의 화면 밖 추정(lost + reason offscreen + hint)일 때만 — 모르는 방향은 가리키지 않는다.
//   세션 스냅샷의 arrow 플래그가 같은 규칙이다 (세션의 fit과 이 fit이 같아야 한다).

export interface AnchorOverlayProps {
  video: RefObject<HTMLVideoElement | null>;
  /** <video>의 object-fit과 같아야 한다 */
  fit?: Extract<ObjectFit, "cover" | "contain">;
  anchor: AnchorDescriptor | null;
  update: TrackUpdate | null;
  /** 선택: 최신 갱신을 직접 읽는 함수 (예: session.latestUpdate). 있으면 update보다 우선 */
  getUpdate?: () => TrackUpdate | null;
  /** 화면 밖 안내 화살표 (기본 true) */
  guide?: boolean;
  /** 화살표 끝과 보이는 영역 가장자리 사이 여백 (CSS px). 하단 버튼 영역 등을 피할 때 변별로 */
  guideInset?: number | Partial<Insets>;
  className?: string;
}

const CANVAS_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
};

interface Layout {
  /** 영상 요소 CSS 크기 */
  videoW: number;
  videoH: number;
  /** 캔버스 기준 영상 요소 위치 (CSS px) */
  offX: number;
  offY: number;
  dpr: number;
}

/** 애니메이션만 있을 때 다시 그리는 최소 간격 (ms) */
const ANIMATION_FRAME_MS = 32;

/** 첫 주석의 기준점 캐시 (주석 배열이 바뀔 때만 다시 계산) */
interface AnchorPointCache {
  annotations: readonly Annotation[] | null;
  w: number;
  h: number;
  p: Point | null;
}

export function AnchorOverlay({
  video,
  fit = "contain",
  anchor,
  update,
  getUpdate,
  guide = true,
  guideInset,
  className,
}: AnchorOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ anchor, update, getUpdate, fit, guide, guideInset });
  const layout = useRef<Layout>({ videoW: 0, videoH: 0, offX: 0, offY: 0, dpr: 1 });
  /** 지금 크기를 지켜보는 <video> (ref가 다른 요소로 바뀌면 draw 루프가 rebind를 부른다) */
  const observed = useRef<HTMLVideoElement | null>(null);
  const rebind = useRef<(() => void) | null>(null);
  const active = anchor !== null;

  // 최신 props를 rAF 루프에서 읽을 수 있게
  useEffect(() => {
    live.current = { anchor, update, getUpdate, fit, guide, guideInset };
  });

  // 크기·위치 추적 (ResizeObserver) + 백버퍼 크기 = CSS 크기 × devicePixelRatio
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const v = video.current;
      const cr = canvas.getBoundingClientRect();
      const vr = v ? v.getBoundingClientRect() : cr;
      const dpr = window.devicePixelRatio || 1;
      layout.current = { videoW: vr.width, videoH: vr.height, offX: vr.left - cr.left, offY: vr.top - cr.top, dpr };
      const b = canvasBackingSize(cr.width, cr.height, dpr);
      if (canvas.width !== b.width || canvas.height !== b.height) {
        canvas.width = b.width;
        canvas.height = b.height;
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    let v: HTMLVideoElement | null = null;
    // 지켜볼 <video>를 (다시) 정한다 — 같은 ref에 새 요소가 붙는 경우(조건부 렌더링) 대비
    const bind = () => {
      const next = video.current;
      if (next !== v) {
        if (v) {
          ro.unobserve(v);
          v.removeEventListener("resize", measure);
        }
        v = next;
        observed.current = v;
        if (v) {
          ro.observe(v);
          v.addEventListener("resize", measure); // 영상 원본 크기 변화(회전)
        }
      }
      measure();
    };
    bind();
    rebind.current = bind;
    window.addEventListener("resize", measure); // dpr 변화(확대/축소) 대비
    return () => {
      ro.disconnect();
      v?.removeEventListener("resize", measure);
      window.removeEventListener("resize", measure);
      rebind.current = null;
      observed.current = null;
    };
  }, [video]);

  // 그리기 루프: 앵커가 있을 때만
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // 지난번에 그린 영역 (백버퍼 px). null = 모름 → 전체 지우기
    let drawn: Rect | null = null;
    const clear = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (drawn) {
        if (drawn.width > 0 && drawn.height > 0) ctx.clearRect(drawn.x, drawn.y, drawn.width, drawn.height);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      drawn = null;
    };
    /** CSS px(영상 요소 기준) 사각형들의 합 → 백버퍼 px (캔버스 안으로 자름). 하나라도 null이면 null */
    const toBacking = (boxes: (Rect | null)[], L: Layout): Rect | null => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const b of boxes) {
        if (!b) return null;
        if (!(b.width > 0) || !(b.height > 0)) continue;
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width);
        y1 = Math.max(y1, b.y + b.height);
      }
      if (!(x1 > x0)) return { x: 0, y: 0, width: 0, height: 0 };
      const d = L.dpr;
      const bx0 = Math.max(0, Math.floor((x0 + L.offX) * d) - 2);
      const by0 = Math.max(0, Math.floor((y0 + L.offY) * d) - 2);
      const bx1 = Math.min(canvas.width, Math.ceil((x1 + L.offX) * d) + 2);
      const by1 = Math.min(canvas.height, Math.ceil((y1 + L.offY) * d) + 2);
      return { x: bx0, y: by0, width: Math.max(0, bx1 - bx0), height: Math.max(0, by1 - by0) };
    };
    if (!active) {
      clear();
      return;
    }
    let raf = 0;
    let dirty = true;
    const arrows = new GuideArrowState();
    let arrowAnchorId: string | null = null;
    const pc: AnchorPointCache = { annotations: null, w: 0, h: 0, p: null };
    const anchorPoint = (a: AnchorDescriptor): Point | null => {
      if (pc.annotations !== a.annotations || pc.w !== a.refWidth || pc.h !== a.refHeight) {
        pc.annotations = a.annotations;
        pc.w = a.refWidth;
        pc.h = a.refHeight;
        pc.p = primaryAnchorPx(a.annotations, a.refWidth, a.refHeight);
      }
      return pc.p;
    };
    // 마지막으로 그린 입력 (같으면 애니메이션 간격만큼 건너뛴다)
    let lastInputs: unknown[] | null = null;
    let lastDrawAt = 0;
    const idle = () => {
      if (dirty) {
        clear();
        dirty = false;
      }
      lastInputs = null;
    };
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const { anchor: a, update: u0, getUpdate: gu, fit: f, guide: g, guideInset: gi } = live.current;
      const u = gu ? gu() : u0;
      const v = video.current;
      if (v !== observed.current) rebind.current?.();
      const L = layout.current;
      const inputs = [a, u, L, f, g, gi, v?.videoWidth, v?.videoHeight];
      if (lastInputs && t - lastDrawAt < ANIMATION_FRAME_MS && inputs.every((x, i) => x === lastInputs![i])) return;
      lastInputs = inputs;
      lastDrawAt = t;
      if (!a || !u || !v || u.anchorId !== a.id || L.videoW <= 0 || L.videoH <= 0) {
        arrows.reset();
        idle();
        return;
      }
      if (a.id !== arrowAnchorId) {
        arrows.reset();
        arrowAnchorId = a.id;
      }
      const m = computeDisplayMapping(
        v.videoWidth || u.frameSize.width,
        v.videoHeight || u.frameSize.height,
        L.videoW,
        L.videoH,
        f,
        L.dpr,
      );
      if (!m) {
        idle();
        return;
      }
      const opacity = stateOpacity(u.state);
      const showAnn = !!u.H && opacity > 0;
      const arrow = g ? arrows.next(u, anchorPoint(a), m, t, { inset: gi }) : null;
      if (!showAnn && !arrow) {
        idle();
        return;
      }
      clear();
      dirty = true;
      ctx.setTransform(L.dpr, 0, 0, L.dpr, L.offX * L.dpr, L.offY * L.dpr);
      if (showAnn) renderAnnotations(ctx, a.annotations, u.H, u.refSize, u.frameSize, m, { opacity, timeMs: t });
      if (arrow) renderGuideArrow(ctx, arrow, { timeMs: t });
      // 다음에 지울 영역: 그린 것만 (DPR 3 폰에서 전체 백버퍼 지우기·전송을 피한다)
      drawn = toBacking(
        [
          showAnn ? annotationBounds(a.annotations, u.H!, u.refSize, u.frameSize, m) : { x: 0, y: 0, width: 0, height: 0 },
          arrow ? guideArrowBounds(arrow) : { x: 0, y: 0, width: 0, height: 0 },
        ],
        L,
      );
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [active, video]);

  return <canvas ref={canvasRef} className={className} style={CANVAS_STYLE} aria-hidden="true" />;
}
