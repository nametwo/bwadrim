"use client";

import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import type { AnchorDescriptor, TrackUpdate } from "@/lib/tracking/types";
import {
  canvasBackingSize,
  computeDisplayMapping,
  renderAnnotations,
  stateOpacity,
  type ObjectFit,
} from "@/lib/tracking/overlay";

// 영상 위에 앵커 주석(핀·선)을 그리는 캔버스. <video>와 같은 relative 컨테이너 안에 둔다:
//
//   <div className="relative">
//     <video ref={videoRef} className="h-full w-full object-contain" />
//     <AnchorOverlay video={videoRef} fit="contain" anchor={snap.anchor} update={snap.update} />
//   </div>
//
// - 앵커가 있는 동안만 매 animation frame 다시 그린다 (없으면 유휴)
// - tracking = 선명, weak = 45% 불투명, lost/searching = 숨김 (틀린 곳을 가리키느니 안 보이는 게 낫다)
// - 포인터 이벤트는 통과시킨다 (pointer-events: none) — 입력은 컨테이너가 받는다
// - getUpdate를 주면 매 프레임 그걸로 최신 H를 읽는다 → 추적 갱신마다 React를 재렌더할 필요 없음

export interface AnchorOverlayProps {
  video: RefObject<HTMLVideoElement | null>;
  /** <video>의 object-fit과 같아야 한다 */
  fit?: Extract<ObjectFit, "cover" | "contain">;
  anchor: AnchorDescriptor | null;
  update: TrackUpdate | null;
  /** 선택: 최신 갱신을 직접 읽는 함수 (예: session.latestUpdate). 있으면 update보다 우선 */
  getUpdate?: () => TrackUpdate | null;
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

export function AnchorOverlay({ video, fit = "contain", anchor, update, getUpdate, className }: AnchorOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ anchor, update, getUpdate, fit });
  const layout = useRef<Layout>({ videoW: 0, videoH: 0, offX: 0, offY: 0, dpr: 1 });
  const active = anchor !== null;

  // 최신 props를 rAF 루프에서 읽을 수 있게
  useEffect(() => {
    live.current = { anchor, update, getUpdate, fit };
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
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    const v = video.current;
    if (v) {
      ro.observe(v);
      v.addEventListener("resize", measure); // 영상 원본 크기 변화(회전)
    }
    window.addEventListener("resize", measure); // dpr 변화(확대/축소) 대비
    return () => {
      ro.disconnect();
      v?.removeEventListener("resize", measure);
      window.removeEventListener("resize", measure);
    };
  }, [video]);

  // 그리기 루프: 앵커가 있을 때만
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const clear = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    if (!active) {
      clear();
      return;
    }
    let raf = 0;
    let dirty = true;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const { anchor: a, update: u0, getUpdate: gu, fit: f } = live.current;
      const u = gu ? gu() : u0;
      const v = video.current;
      const L = layout.current;
      const opacity = u ? stateOpacity(u.state) : 0;
      if (!a || !u || !v || u.anchorId !== a.id || !u.H || opacity <= 0 || L.videoW <= 0 || L.videoH <= 0) {
        if (dirty) {
          clear();
          dirty = false;
        }
        return;
      }
      const m = computeDisplayMapping(
        v.videoWidth || u.frameSize.width,
        v.videoHeight || u.frameSize.height,
        L.videoW,
        L.videoH,
        f,
        L.dpr,
      );
      clear();
      dirty = true;
      if (!m) return;
      ctx.setTransform(L.dpr, 0, 0, L.dpr, L.offX * L.dpr, L.offY * L.dpr);
      renderAnnotations(ctx, a.annotations, u.H, u.refSize, u.frameSize, m, { opacity, timeMs: t });
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [active, video]);

  return <canvas ref={canvasRef} className={className} style={CANVAS_STYLE} aria-hidden="true" />;
}
