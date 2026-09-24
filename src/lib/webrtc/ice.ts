export interface IceConfig {
  iceServers: RTCIceServer[];
  // null이면 TURN 정상. 문자열이면 STUN만으로 동작 중인 이유
  turnError: string | null;
}

// 클라이언트에서 ICE 서버 목록을 받아온다 (TURN 단기 자격증명 포함)
export async function fetchIceServers(code: string): Promise<IceConfig> {
  try {
    const res = await fetch(`/api/turn?code=${encodeURIComponent(code)}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`turn api ${res.status}`);
    return (await res.json()) as IceConfig;
  } catch (e) {
    console.error("[ice] ICE 서버 조회 실패, STUN으로 폴백:", e);
    return {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      turnError: `ICE 서버 조회 실패: ${e instanceof Error ? e.message : e}`,
    };
  }
}
