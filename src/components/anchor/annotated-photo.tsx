"use client";

import { useEffect, useRef, useState } from "react";
import type { AnchorDescriptor } from "@/lib/tracking/types";
import { IDENTITY } from "@/lib/tracking/geometry";
import { canvasBackingSize, computeDisplayMapping, renderAnnotations } from "@/lib/tracking/overlay";

// 기준 사진(앵커를 만든 순간의 화면) 위에 주석을 그린 그림. 고객 폴백 카드, 엔지니어 "고객에게 보이는 카드" 미리보기.
// 사진은 주어진 영역 안에 비율을 지켜 가운데 놓고(contain), 주석은 영상 위와 같은 모양(빨간 링·선, 맥동)으로 그린다.
// 주석 좌표는 ref 기준 0~1 → 사진 전체에 대응 (사진 = ref 프레임의 2배 크기 JPEG, 비율 같음).

interface Box {
  w: number;
  h: number;
  dpr: number;
}

/** 맥동 애니메이션 프레임 간격 (ms) — 30fps면 충분 */
const FRAME_MS = 33;

export function AnnotatedPhoto({
  src,
  anchor,
  alt = "",
  className,
  rounded = 16,
}: {
  /** 이미지 URL (객체 URL 등) */
  src: string;
  anchor: AnchorDescriptor;
  alt?: string;
  className?: string;
  /** 사진 모서리 둥글기 (px) */
  rounded?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<Box>({ w: 0, h: 0, dpr: 1 });
  const live = useRef(anchor);

  useEffect(() => {
    live.current = anchor;
  });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setBox((b) => (b.w === r.width && b.h === r.height && b.dpr === dpr ? b : { w: r.width, h: r.height, dpr }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const m = computeDisplayMapping(anchor.refWidth, anchor.refHeight, box.w, box.h, "contain", box.dpr);

  // 주석 그리기 (맥동 때문에 rAF, 보일 때만)
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !(box.w > 0) || !(box.h > 0)) return;
    const b = canvasBackingSize(box.w, box.h, box.dpr);
    canvas.width = b.width;
    canvas.height = b.height;
    let raf = 0;
    let last = -Infinity;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < FRAME_MS) return;
      last = t;
      const a = live.current;
      const mapping = computeDisplayMapping(a.refWidth, a.refHeight, box.w, box.h, "contain", box.dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!mapping) return;
      ctx.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
      const ref = { width: a.refWidth, height: a.refHeight };
      renderAnnotations(ctx, a.annotations, IDENTITY, ref, ref, mapping, { timeMs: t });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [box]);

  return (
    <div ref={boxRef} className={`relative ${className ?? ""}`}>
      {m && (
        // eslint-disable-next-line @next/next/no-img-element -- 메모리의 객체 URL (최적화 대상 아님)
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="absolute select-none object-cover"
          style={{ left: m.x, top: m.y, width: m.width, height: m.height, borderRadius: rounded }}
        />
      )}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
    </div>
  );
}
