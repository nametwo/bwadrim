import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ICE 서버 목록 발급. TURN 자격증명은 서버에서만 다루고
// 클라이언트엔 단기(2h) 토큰만 내려준다.
// 응답의 turnError가 있으면 TURN 없이 STUN만 내려간 것 — 모바일망끼리는 연결이 실패할 수 있다.
const STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

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
  const code = new URL(request.url).searchParams.get("code")?.toUpperCase();
  if (!code) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }

  const { data: room } = await createAdminClient()
    .from("rooms")
    .select("id, status, expires_at")
    .eq("code", code)
    .maybeSingle();

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

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 7200 }),
        cache: "no-store",
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
