import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isJoinToken } from "@/lib/join-token";

// ICE 서버 목록 발급. TURN 자격증명은 서버에서만 다루고
// 클라이언트엔 단기 토큰만 내려준다. 유효시간은 상담이 만료되는 때까지(최대 2시간).
// 만료 직전에 시작한 통화도 30분은 쓸 수 있게 30분보다 짧게 주지는 않는다. 발급 횟수 제한은 아직 없다(BUG-15)
// 응답의 turnError가 있으면 TURN 없이 STUN만 내려간 것 — 모바일망끼리는 연결이 실패할 수 있다.
const STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

const TTL_MAX = 7200;
const TTL_MIN = 1800;
// Cloudflare가 응답하지 않으면 고객 화면이 '카메라 켜는 중…'에서 멈춘다. 이 안에 못 받으면 STUN만 준다
const CLOUDFLARE_TIMEOUT_MS = 5000;

type TurnResponse = { iceServers: RTCIceServer[]; turnError: string | null };

function stunOnly(turnError: string) {
  console.error(`[turn] STUN만 반환: ${turnError}`);
  return NextResponse.json<TurnResponse>(
    { iceServers: [STUN], turnError },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// 브라우저가 막는 53번 포트 URL은 ICE 수집만 늦추므로 뺀다
function dropPort53(server: RTCIceServer): RTCIceServer {
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
    (u) => !/:53(\?|$)/.test(u),
  );
  return { ...server, urls };
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t");
  if (!isJoinToken(token)) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }

  const { data: room, error } = await createAdminClient()
    .from("rooms")
    .select("id, status, expires_at")
    .eq("join_token", token)
    .maybeSingle();

  // 404는 '세션이 끝났다'는 뜻으로 쓰이므로(고객 화면이 종료 안내로 바뀜) 조회 오류와 구분한다
  if (error) {
    console.error("[turn] 방 조회 실패:", error);
    return NextResponse.json({ error: "lookup failed" }, { status: 503 });
  }

  if (
    !room ||
    room.status === "ended" ||
    new Date(room.expires_at) < new Date()
  ) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();

  if (!keyId || !apiToken) {
    return stunOnly("CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN 미설정");
  }

  const untilExpiry = Math.floor((Date.parse(room.expires_at) - Date.now()) / 1000);
  const ttl = Number.isFinite(untilExpiry) ? Math.min(TTL_MAX, Math.max(TTL_MIN, untilExpiry)) : TTL_MAX;

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
        cache: "no-store",
        // 시간이 지나면 TimeoutError로 아래 catch에 걸려 STUN만 내려간다
        signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return stunOnly(`cloudflare ${res.status} ${body.slice(0, 200)}`);
    }
    const data: { iceServers: RTCIceServer[] } = await res.json();
    const turnServers = data.iceServers.map(dropPort53);
    if (!turnServers.some((s) => [s.urls].flat().some((u) => u.startsWith("turn")))) {
      return stunOnly("cloudflare 응답에 turn URL 없음");
    }
    return NextResponse.json<TurnResponse>(
      { iceServers: [STUN, ...turnServers], turnError: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return stunOnly(`cloudflare 호출 실패: ${e instanceof Error ? e.message : e}`);
  }
}
