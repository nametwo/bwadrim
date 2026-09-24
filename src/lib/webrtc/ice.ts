export interface IceConfig {
  iceServers: RTCIceServer[];
  // null이면 TURN 정상. 문자열이면 STUN만으로 동작 중인 이유
  turnError: string | null;
  // 세션이 없거나 종료·만료됨. 기다려도 상대가 오지 않는다
  roomGone?: boolean;
}

const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// 클라이언트에서 ICE 서버 목록을 받아온다 (TURN 단기 자격증명 포함)
// joinToken: 고객 링크의 토큰. 유효한(종료·만료 전) 세션에만 발급된다
export async function fetchIceServers(joinToken: string): Promise<IceConfig> {
  try {
    const res = await fetch(`/api/turn?t=${encodeURIComponent(joinToken)}`, {
      cache: "no-store",
    });
    if (res.status === 404) {
      return {
        iceServers: STUN_ONLY,
        turnError: "세션이 종료됐거나 만료됐어요",
        roomGone: true,
      };
    }
    if (!res.ok) throw new Error(`turn api ${res.status}`);
    return (await res.json()) as IceConfig;
  } catch (e) {
    console.error("[ice] ICE 서버 조회 실패, STUN으로 폴백:", e);
    return {
      iceServers: STUN_ONLY,
      turnError: `ICE 서버 조회 실패: ${e instanceof Error ? e.message : e}`,
    };
  }
}
