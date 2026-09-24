// 레이저 포인터 좌표. 화면이 아니라 영상 원본 프레임(videoWidth×videoHeight) 기준 0~1.
// 엔지니어·고객 화면 크기가 달라도 같은 지점을 가리킨다.
export interface PointerPos {
  x: number;
  y: number;
}

// object-fit: contain으로 그린 원본(srcW×srcH)이 요소(elW×elH) 안에서 실제로 차지하는 영역(px)
export function containRect(elW: number, elH: number, srcW: number, srcH: number) {
  if (!elW || !elH || !srcW || !srcH) return null;
  const scale = Math.min(elW / srcW, elH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { left: (elW - width) / 2, top: (elH - height) / 2, width, height };
}

function videoRect(video: HTMLVideoElement) {
  return containRect(
    video.clientWidth,
    video.clientHeight,
    video.videoWidth,
    video.videoHeight,
  );
}

// 탭 위치(요소 기준 px) → 영상 좌표. 위아래·좌우 검은 여백을 누르면 null
export function toVideoPos(
  video: HTMLVideoElement,
  offsetX: number,
  offsetY: number,
): PointerPos | null {
  const r = videoRect(video);
  if (!r) return null;
  const x = (offsetX - r.left) / r.width;
  const y = (offsetY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

// 영상 좌표 → 요소 기준 px (영상이 object-fit: contain일 때)
export function toElementPx(video: HTMLVideoElement, pos: PointerPos) {
  const r = videoRect(video);
  if (!r) return null;
  return { left: r.left + pos.x * r.width, top: r.top + pos.y * r.height };
}

export function isPointerPos(v: unknown): v is PointerPos {
  if (!v || typeof v !== "object") return false;
  const { x, y } = v as Record<string, unknown>;
  return (
    typeof x === "number" &&
    typeof y === "number" &&
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1
  );
}
