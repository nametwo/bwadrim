import { redactText } from "./redact";
import { newPageId, sendTelemetry, type TelemetryTarget } from "./telemetry";

// 화면 JS 오류 보고 (client_error, DATA-01). 잡히지 않은 오류·promise 거부·오류 화면(error.tsx).
// 어느 상담인지는 주소로 안다: /join/{토큰} = 고객, /room/{id} = 엔지니어. 그 밖의 화면은 콘솔에만.
// 같은 오류는 화면마다 한 번, 최대 5개. 메시지·파일 주소의 링크 토큰은 지운다(redactText).

const MAX_REPORTS = 5;
const pid = typeof window === "undefined" ? "" : newPageId();
const seen = new Set<string>();

// 지금 화면 단계(예: 'call:connecting')와 화면 pid. 통화 화면이 바꿔 둔다 — 오류가 어디서 났는지, 같은 화면의 다른 기록과 묶으려고
export const errorContext: { phase: string | null; pid: string | null } = { phase: null, pid: null };

function targetFromPath(path: string): TelemetryTarget | null {
  const join = /^\/join\/([0-9a-f]{32})(?:\/|$)/i.exec(path);
  if (join) return { role: "customer", token: join[1] };
  const room = /^\/room\/([0-9a-f-]{36})(?:\/|$)/i.exec(path);
  if (room) return { role: "engineer", room: room[1] };
  return null;
}

export function reportClientError(kind: "error" | "rejection" | "render", error: unknown, extra: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const err = error instanceof Error ? error : null;
  const name = err?.name ?? (typeof error === "object" && error !== null ? "Object" : typeof error);
  const msg = redactText(err?.message ?? String(error), 160);
  const sig = `${kind}:${name}:${msg}`;
  if (seen.has(sig) || seen.size >= MAX_REPORTS) return;
  seen.add(sig);
  const target = targetFromPath(window.location.pathname);
  if (!target) return;
  // 스택 첫 줄 두 개만 (파일:줄). 주소에 토큰이 있으면 지운다
  const src = err?.stack
    ? redactText(err.stack.split("\n").slice(1, 3).map((l) => l.trim()).join(" | "), 240)
    : undefined;
  sendTelemetry(target, errorContext.pid ?? pid, "client_error", {
    kind,
    name,
    msg,
    src,
    phase: errorContext.phase,
    ...extra,
  });
}
