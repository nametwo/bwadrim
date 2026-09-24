export interface IceConfig {
  iceServers: RTCIceServer[];
  // null이면 TURN 정상. 문자열이면 STUN만으로 동작 중인 이유
  turnError: string | null;
  // 세션이 없거나 종료·만료됨. 기다려도 상대가 오지 않는다
  roomGone?: boolean;
  // 서버 시각 - 이 기기 시각(ms). 모르면 0. 기기 이어받기 순서에 쓴다(CallSession.clockOffsetMs)
  clockOffsetMs: number;
}

// 응답의 Date 헤더(초 단위)로 이 기기 시계가 얼마나 틀렸는지 잰다
function clockOffset(res: Response, sentAt: number): number {
  const server = Date.parse(res.headers.get("date") ?? "");
  if (Number.isNaN(server)) return 0;
  return server + 500 - (sentAt + Date.now()) / 2;
}

const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// 클라이언트에서 ICE 서버 목록을 받아온다 (TURN 단기 자격증명 포함)
// joinToken: 고객 링크의 토큰. 유효한(종료·만료 전) 세션에만 발급된다
export async function fetchIceServers(joinToken: string): Promise<IceConfig> {
  try {
    const sentAt = Date.now();
    const res = await fetch(`/api/turn?t=${encodeURIComponent(joinToken)}`, {
      cache: "no-store",
    });
    const clockOffsetMs = clockOffset(res, sentAt);
    if (res.status === 404) {
      return {
        iceServers: STUN_ONLY,
        turnError: "세션이 종료됐거나 만료됐어요",
        roomGone: true,
        clockOffsetMs,
      };
    }
    if (!res.ok) throw new Error(`turn api ${res.status}`);
    const body = (await res.json()) as Omit<IceConfig, "clockOffsetMs">;
    return { ...body, clockOffsetMs };
  } catch (e) {
    console.error("[ice] ICE 서버 조회 실패, STUN으로 폴백:", e);
    return {
      iceServers: STUN_ONLY,
      turnError: `ICE 서버 조회 실패: ${e instanceof Error ? e.message : e}`,
      clockOffsetMs: 0,
    };
  }
}
