// 화면 멈춤 + 그리기 (요구사항 CALL-09).
// 엔지니어가 보던 프레임을 JPEG로 떠서 고객에게 보내고, 두 화면이 같은 정지 화면 위에 같은 선을 그린다.
// 선 좌표는 정지 화면 원본 기준 0~1.

export type Point = [number, number];

export interface Stroke {
  id: string;
  pts: Point[];
}

// 받는 쪽에 전달되는 이벤트. freeze는 조각을 다 모은 뒤 한 번 전달된다
export type DrawEvent =
  | { t: "freeze"; image: string }
  | { t: "stroke"; id: string; pts: Point[] }
  | { t: "undo"; id: string }
  | { t: "clear" }
  | { t: "resume" };

// 보내는 쪽이 DataChannel로 직접 보내는 이벤트 (freeze는 CallSession.sendFreeze로 조각내 보낸다)
export type DrawCommand = Exclude<DrawEvent, { t: "freeze" }>;

const MAX_POINTS_PER_MESSAGE = 500;

// 지금 보이는 영상 프레임을 JPEG data URL로. 전송량을 줄이려 긴 변을 maxSide로 줄인다
export function captureFrame(
  video: HTMLVideoElement,
  maxSide = 1280,
  quality = 0.75,
): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function isPoint(v: unknown): v is Point {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && n >= 0 && n <= 1)
  );
}

// 상대가 보낸 그리기 명령 검증. 형식이 맞지 않으면 null
export function parseDrawCommand(msg: unknown): DrawCommand | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  switch (m.t) {
    case "stroke":
      if (
        typeof m.id === "string" &&
        Array.isArray(m.pts) &&
        m.pts.length <= MAX_POINTS_PER_MESSAGE &&
        m.pts.every(isPoint)
      ) {
        return { t: "stroke", id: m.id, pts: m.pts as Point[] };
      }
      return null;
    case "undo":
      return typeof m.id === "string" ? { t: "undo", id: m.id } : null;
    case "clear":
      return { t: "clear" };
    case "resume":
      return { t: "resume" };
    default:
      return null;
  }
}

// 받은 명령을 선 목록에 반영 (양쪽 화면이 같은 규칙을 쓴다)
export function applyDrawCommand(strokes: Stroke[], cmd: DrawCommand): Stroke[] {
  switch (cmd.t) {
    case "stroke": {
      const i = strokes.findIndex((s) => s.id === cmd.id);
      if (i < 0) return [...strokes, { id: cmd.id, pts: cmd.pts }];
      const next = strokes.slice();
      next[i] = { id: cmd.id, pts: [...next[i].pts, ...cmd.pts] };
      return next;
    }
    case "undo":
      return strokes.filter((s) => s.id !== cmd.id);
    case "clear":
    case "resume":
      return [];
  }
}
