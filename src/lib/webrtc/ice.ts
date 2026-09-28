export interface IceConfig {
  iceServers: RTCIceServer[];
  // null이면 TURN 정상. 문자열이면 STUN만으로 동작 중인 이유
  turnError: string | null;
  // TURN이 빠진 원인 코드 (지표용, DATA-01). 서버 원인(env_missing·cf_http·cf_timeout …) 또는
  // 폰에서 난 원인(fetch_network·fetch_timeout·http_503·http_5xx·parse). TURN 정상이면 null
  turnCode: string | null;
  // 세션이 없거나 종료·만료됨. 기다려도 상대가 오지 않는다
  roomGone?: boolean;
  // 서버 시각 - 이 기기 시각(ms). 모르면 0. 기기 이어받기 순서에 쓴다(CallSession.clockOffsetMs)
  clockOffsetMs: number;
  // /api/turn 왕복에 걸린 시간 (지표용)
  ms: number;
}

// 응답의 Date 헤더(초 단위)로 이 기기 시계가 얼마나 틀렸는지 잰다
function clockOffset(res: Response, sentAt: number): number {
  const server = Date.parse(res.headers.get("date") ?? "");
  if (Number.isNaN(server)) return 0;
  return server + 500 - (sentAt + Date.now()) / 2;
}

const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// 응답이 이만큼 늦으면 기다리지 않고 STUN으로 시작한다 (서버는 Cloudflare를 5초까지 기다린다)
const FETCH_TIMEOUT_MS = 10_000;

// 클라이언트에서 ICE 서버 목록을 받아온다 (TURN 단기 자격증명 포함)
// joinToken: 고객 링크의 토큰. 유효한(종료·만료 전) 세션에만 발급된다
// role: 누가 받는지 — 서버가 TURN 실패 기록에 남긴다(엔지니어는 로그인으로 다시 확인)
export async function fetchIceServers(joinToken: string, role: "customer" | "engineer" = "customer"): Promise<IceConfig> {
  const sentAt = Date.now();
  const ms = () => Date.now() - sentAt;
  try {
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    const res = await fetch(`/api/turn?t=${encodeURIComponent(joinToken)}&r=${role === "engineer" ? "e" : "c"}`, {
      cache: "no-store",
      signal,
    });
    const clockOffsetMs = clockOffset(res, sentAt);
    if (res.status === 404) {
      return {
        iceServers: STUN_ONLY,
        turnError: "상담이 끝났거나 만료됐어요",
        turnCode: "room_gone",
        roomGone: true,
        clockOffsetMs,
        ms: ms(),
      };
    }
    if (!res.ok) {
      return {
        iceServers: STUN_ONLY,
        turnError: `ICE 서버 조회 실패: turn api ${res.status}`,
        turnCode: res.status === 503 ? "http_503" : "http_5xx",
        clockOffsetMs,
        ms: ms(),
      };
    }
    let body: Partial<Omit<IceConfig, "clockOffsetMs" | "ms">>;
    try {
      body = await res.json();
    } catch {
      return { iceServers: STUN_ONLY, turnError: "ICE 서버 응답을 읽지 못했어요", turnCode: "parse", clockOffsetMs, ms: ms() };
    }
    return {
      iceServers: body.iceServers ?? STUN_ONLY,
      turnError: body.turnError ?? null,
      turnCode: body.turnCode ?? (body.turnError ? "unknown" : null),
      clockOffsetMs,
      ms: ms(),
    };
  } catch (e) {
    console.error("[ice] ICE 서버 조회 실패, STUN으로 폴백:", e);
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      iceServers: STUN_ONLY,
      turnError: `ICE 서버 조회 실패: ${e instanceof Error ? e.message : e}`,
      turnCode: timeout ? "fetch_timeout" : "fetch_network",
      clockOffsetMs: 0,
      ms: ms(),
    };
  }
}
