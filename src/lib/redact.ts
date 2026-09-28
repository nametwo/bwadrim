// 기록·알림으로 내보내는 값에서 고객 링크 토큰(32자리 16진수, ROOM-12)을 지운다.
// 토큰은 통화 입장·TURN 발급 권한 그 자체라서 오류 메시지·파일 주소(/join/{토큰})에 섞여 나가면 안 된다.
// 서버·브라우저 공용 — 순수 함수.

const TOKEN_RE = /[0-9a-f]{32}/gi;
const MAX_DEPTH = 4;
const MAX_KEYS = 60;
const MAX_ARRAY = 40;
const MAX_STRING = 300;

export function redactText(s: string, max = MAX_STRING): string {
  const out = s.replace(TOKEN_RE, "[token]");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// JSON으로 보낼 수 있는 값만 남기고 토큰을 지운다. 너무 깊거나 큰 값은 자른다
export function redactProps(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactText(value);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => redactProps(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      if (v === undefined || typeof v === "function") continue;
      out[redactText(k, 60)] = redactProps(v, depth + 1);
    }
    return out;
  }
  return null;
}
