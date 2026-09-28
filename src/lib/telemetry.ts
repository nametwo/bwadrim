// 브라우저 → /api/events 지표 전송 (DATA-01·04·07). 실패해도 화면을 막지 않는다.
// 고객은 링크 토큰으로, 엔지니어는 role=engineer + 로그인 쿠키로 확인받는다(서버가 방 주인인지 본다).
// 화면(페이지 로드)마다 pid를 하나 만들어 모든 기록에 붙인다 — 같은 화면의 기록을 묶고, 요약(call_summary)을 덮어쓰는 열쇠.
// 폰 저장소(localStorage)는 쓰지 않는다 (NFR-04).

export type TelemetryTarget =
  | { role: "customer"; token: string }
  | { role: "engineer"; token?: string; room?: string };

// 16자리 16진수. crypto.randomUUID는 오래된 브라우저에 없어서 쓰지 않는다
export function newPageId(): string {
  const bytes = new Uint8Array(8);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// beacon: 화면을 떠나는 중(pagehide·숨김)이면 sendBeacon — 떠나도 브라우저가 대신 보낸다
export function sendTelemetry(
  target: TelemetryTarget,
  pid: string,
  name: string,
  props: Record<string, unknown> = {},
  opts: { beacon?: boolean } = {},
) {
  let body: string;
  try {
    body = JSON.stringify({ ...target, pid, name, props });
  } catch {
    return;
  }
  if (opts.beacon && typeof navigator.sendBeacon === "function") {
    try {
      // text/plain: 브라우저가 따로 묻지 않고(CORS 안전) 보낸다. 서버는 본문을 JSON으로 읽는다
      if (navigator.sendBeacon("/api/events", new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
    } catch {
      // 못 보내면 아래 fetch로
    }
  }
  try {
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: body.length < 60_000,
    }).catch(() => {});
  } catch {
    // 기록 실패는 무시
  }
}

// 한 화면용 전송기. pid를 기억한다
export function createTelemetry(target: TelemetryTarget, pid = newPageId()) {
  return {
    pid,
    target,
    post(name: string, props: Record<string, unknown> = {}) {
      sendTelemetry(target, pid, name, props);
    },
    beacon(name: string, props: Record<string, unknown> = {}) {
      sendTelemetry(target, pid, name, props, { beacon: true });
    },
  };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
