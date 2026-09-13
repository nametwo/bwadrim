import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ICE 서버 목록 발급. TURN 자격증명은 서버에서만 다루고
// 클라이언트엔 단기(2h) 토큰만 내려준다.
const STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

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

  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  // TURN 미설정(로컬 개발 등)이면 STUN만으로 동작 — relay가 필요한 망에선 연결 실패 가능
  if (!keyId || !apiToken) {
    console.warn("[turn] CLOUDFLARE_TURN_* 미설정 — STUN만 반환");
    return NextResponse.json({ iceServers: [STUN] });
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
    if (!res.ok) throw new Error(`cloudflare ${res.status}`);
    const data: { iceServers: RTCIceServer[] } = await res.json();
    return NextResponse.json({ iceServers: [STUN, ...data.iceServers] });
  } catch (e) {
    console.error("[turn] 자격증명 발급 실패:", e);
    return NextResponse.json({ iceServers: [STUN] });
  }
}
