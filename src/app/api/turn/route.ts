import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isJoinToken } from "@/lib/join-token";
import { logEvent } from "@/lib/events";
import { notifyUrgent } from "@/lib/notify";

// ICE 서버 목록 발급. TURN 자격증명은 서버에서만 다루고
// 클라이언트엔 단기 토큰만 내려준다. 유효시간은 상담이 만료되는 때까지(최대 2시간).
// 만료 직전에 시작한 통화도 30분은 쓸 수 있게 30분보다 짧게 주지는 않는다.
// 응답의 turnError가 있으면 TURN 없이 STUN만 내려간 것 — 모바일망끼리는 연결이 실패할 수 있다.
const STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

const TTL_MAX = 7200;
const TTL_MIN = 1800;
// 상담 하나에서 TURN 자격증명을 내주는 횟수 상한 (NET-02, BUG-15). 자격증명은 아무 상대에게나 UDP를 중계해 주는
// 열쇠라, 링크를 전달받은 누구든 24시간 동안 원하는 만큼 받아 쓰면 Cloudflare 과금이 쌓인다.
// 엔지니어 '연결 준비'와 고객 '카메라 켜고 시작하기'·'다시 연결'·'이 폰으로 연결'이 한 번씩 받으므로 40이면 넉넉하다.
// 발급 때마다 events에 turn_issued를 남기고 그 개수로 센다. 세지 못하면(DB 오류) 막지 않는다 — 통화가 먼저다
const ISSUE_LIMIT = 40;
// Cloudflare가 응답하지 않으면 고객 화면이 '카메라 켜는 중…'에서 멈춘다. 이 안에 못 받으면 STUN만 준다
const CLOUDFLARE_TIMEOUT_MS = 5000;

type TurnResponse = { iceServers: RTCIceServer[]; turnError: string | null };

// alert: 응급 채널에 보낼 글(OPS-09). 중계 서버 없이는 모바일망끼리 연결이 안 될 수 있어 지금 봐야 할 일이다.
// null이면 보내지 않는다(상한에 걸린 경우는 호출측이 상담 id를 붙여 따로 보낸다)
function stunOnly(turnError: string, alert: string | null = `🚨 TURN 발급 실패 — ${turnError}. 중계 서버 없이 STUN만 내려갔어요. 모바일망끼리는 연결이 안 될 수 있어요 (NET-03)`) {
  console.error(`[turn] STUN만 반환: ${turnError}`);
  if (alert) notifyUrgent(`turn:${turnError.slice(0, 40)}`, alert);
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
    notifyUrgent("turn-db", `🚨 상담 조회 실패 — TURN 발급 때 Supabase 읽기가 안 돼요 (${error.message}). 고객은 '카메라 켜는 중'에서 멈춰요`);
    return NextResponse.json({ error: "lookup failed" }, { status: 503 });
  }

  if (
    !room ||
    room.status === "ended" ||
    new Date(room.expires_at) < new Date()
  ) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  const { count: issued, error: countError } = await createAdminClient()
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("room_id", room.id)
    .eq("name", "turn_issued");
  if (countError) console.error("[turn] 발급 횟수 조회 실패(막지 않음):", countError);
  else if ((issued ?? 0) >= ISSUE_LIMIT) {
    notifyUrgent(
      `turn-cap:${room.id}`,
      `🚨 TURN 발급 상한 — 상담 ${room.id.slice(0, 8)}: ${ISSUE_LIMIT}회를 넘었어요. 링크가 퍼졌거나 누가 되풀이해 부르고 있어요 (NET-02)`,
    );
    return stunOnly(`이 상담의 발급 횟수 ${ISSUE_LIMIT}회를 넘었어요`, null);
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
    // 응답을 보낸 뒤에는 서버리스 함수가 멈출 수 있어 기록을 기다린다 (실패해도 발급은 그대로)
    await logEvent(room.id, "system", "turn_issued", { ttl });
    return NextResponse.json<TurnResponse>(
      { iceServers: [STUN, ...turnServers], turnError: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return stunOnly(`cloudflare 호출 실패: ${e instanceof Error ? e.message : e}`);
  }
}
