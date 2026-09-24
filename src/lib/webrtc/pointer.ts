// 레이저 포인터 좌표. 화면이 아니라 영상 원본 프레임(videoWidth×videoHeight) 기준 0~1.
// 엔지니어·고객 화면 크기가 달라도 같은 지점을 가리킨다.
export interface PointerPos {
  x: number;
  y: number;
}

// object-fit: contain으로 그려진 영상이 요소 안에서 실제로 차지하는 영역(px)
function containRect(video: HTMLVideoElement) {
  const elW = video.clientWidth;
  const elH = video.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!elW || !elH || !vw || !vh) return null;
  const scale = Math.min(elW / vw, elH / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { left: (elW - width) / 2, top: (elH - height) / 2, width, height };
}

// 탭 위치(요소 기준 px) → 영상 좌표. 위아래·좌우 검은 여백을 누르면 null
export function toVideoPos(
  video: HTMLVideoElement,
  offsetX: number,
  offsetY: number,
): PointerPos | null {
  const r = containRect(video);
  if (!r) return null;
  const x = (offsetX - r.left) / r.width;
  const y = (offsetY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

// 영상 좌표 → 요소 기준 px (영상이 object-fit: contain일 때)
export function toElementPx(video: HTMLVideoElement, pos: PointerPos) {
  const r = containRect(video);
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
