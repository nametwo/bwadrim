// 클라이언트에서 ICE 서버 목록을 받아온다 (TURN 단기 자격증명 포함)
export async function fetchIceServers(code: string): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(`/api/turn?code=${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error(`turn api ${res.status}`);
    const { iceServers } = (await res.json()) as { iceServers: RTCIceServer[] };
    return iceServers;
  } catch (e) {
    console.error("[ice] ICE 서버 조회 실패, STUN으로 폴백:", e);
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}
