"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toElementPx, type PointerPos } from "@/lib/webrtc/pointer";

// 카메라를 움직이면 가리킨 곳이 어긋나므로 잠깐만 보여 준다 (요구사항 CALL-08)
const SHOW_MS = 3000;

interface Marker {
  id: number;
  left: number;
  top: number;
}

// 영상 위 레이저 포인터. 새로 찍으면 이전 것을 대체한다.
export function usePointerMarker() {
  const [marker, setMarker] = useState<Marker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const show = useCallback(
    (video: HTMLVideoElement | null, pos: PointerPos) => {
      if (!video) return;
      const px = toElementPx(video, pos);
      if (!px) return;
      setMarker((prev) => ({ id: (prev?.id ?? 0) + 1, ...px }));
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setMarker(null), SHOW_MS);
    },
    [],
  );

  return { marker, show };
}

// 영상 요소와 같은 기준(부모의 왼쪽 위)에 놓는다. 가운데가 비어 있어 가리킨 버튼을 가리지 않는다
export function PointerMarker({
  marker,
  size,
}: {
  marker: Marker | null;
  size: number;
}) {
  if (!marker) return null;
  return (
    <div
      key={marker.id}
      className="pointer-events-none absolute animate-[pointer-fade_3s_ease-in_forwards]"
      style={{
        left: marker.left,
        top: marker.top,
        width: size,
        height: size,
        transform: "translate(-50%, -50%)",
      }}
    >
      <span className="absolute inset-0 animate-ping rounded-full bg-red-500/50" />
      <span className="absolute inset-0 rounded-full border-[6px] border-red-500 shadow-[0_0_0_3px_white,inset_0_0_0_3px_white]" />
    </div>
  );
}
