"use client";

import { useCallback, useEffect, useRef } from "react";
import { containRect } from "@/lib/webrtc/pointer";
import type { Point, Stroke } from "@/lib/webrtc/draw";

export interface DrawHandlers {
  start: (p: Point) => void;
  move: (p: Point) => void;
  end: () => void;
}

// 정지 화면과 그 위의 선. 두 화면 모두 잘림 없이(contain) 그려 같은 좌표가 같은 곳을 가리킨다.
// draw를 넘기면(엔지니어) 손가락으로 그릴 수 있다.
export function FreezeCanvas({
  image,
  strokes,
  lineWidth,
  draw,
}: {
  image: string;
  strokes: Stroke[];
  lineWidth: number;
  draw?: DrawHandlers;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);

  const rect = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return null;
    return containRect(
      canvas.clientWidth,
      canvas.clientHeight,
      img.naturalWidth,
      img.naturalHeight,
    );
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const r = rect();
    if (!canvas || !r) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const px = ([x, y]: Point): [number, number] => [
      r.left + x * r.width,
      r.top + y * r.height,
    ];
    // 흰 테두리 위에 빨간 선 — 어떤 배경에서도 보이게
    for (const [color, extra] of [
      ["white", 4],
      ["#ef4444", 0],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineWidth + extra;
      for (const s of strokes) {
        if (!s.pts.length) continue;
        const [x0, y0] = px(s.pts[0]);
        if (s.pts.length === 1) {
          ctx.beginPath();
          ctx.arc(x0, y0, (lineWidth + extra) / 2, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        for (const p of s.pts.slice(1)) ctx.lineTo(...px(p));
        ctx.stroke();
      }
    }
  }, [strokes, lineWidth, rect]);

  useEffect(() => {
    redraw();
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [redraw]);

  function toPoint(e: React.PointerEvent<HTMLCanvasElement>): Point | null {
    const r = rect();
    const canvas = canvasRef.current;
    if (!r || !canvas) return null;
    const box = canvas.getBoundingClientRect();
    const x = (e.clientX - box.left - r.left) / r.width;
    const y = (e.clientY - box.top - r.top) / r.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  return (
    <div className="absolute inset-0 bg-black">
      {/* eslint-disable-next-line @next/next/no-img-element -- 통화 중 캡처한 data URL이라 최적화 대상이 아니다 */}
      <img
        ref={imgRef}
        src={image}
        alt="멈춘 화면"
        onLoad={redraw}
        className="absolute inset-0 h-full w-full object-contain"
      />
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${draw ? "touch-none" : "pointer-events-none"}`}
        onPointerDown={
          draw &&
          ((e) => {
            const p = toPoint(e);
            if (!p) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawingRef.current = true;
            draw.start(p);
          })
        }
        onPointerMove={
          draw &&
          ((e) => {
            if (!drawingRef.current) return;
            const p = toPoint(e);
            if (p) draw.move(p);
          })
        }
        onPointerUp={
          draw &&
          (() => {
            if (!drawingRef.current) return;
            drawingRef.current = false;
            draw.end();
          })
        }
        onPointerCancel={
          draw &&
          (() => {
            if (!drawingRef.current) return;
            drawingRef.current = false;
            draw.end();
          })
        }
      />
    </div>
  );
}
