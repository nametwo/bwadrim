import { NextResponse, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isJoinToken } from "@/lib/join-token";
import { logEvent } from "@/lib/events";
import { notify } from "@/lib/alerts";
import { errorText } from "@/lib/alert-rules";

// ICE 서버 목록 발급. TURN 자격증명은 서버에서만 다루고
// 클라이언트엔 단기(2h) 토큰만 내려준다.
// 응답의 turnError가 있으면 TURN 없이 STUN만 내려간 것 — 모바일망끼리는 연결이 실패할 수 있다.
// 그때마다 turn_fallback을 남기고 알린다 (DATA-01, OPS-06). turnCode는 그 원인 코드 — 폰이 실패 기록에 붙인다.
const STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

// Cloudflare가 응답하지 않으면 기다리지 않고 STUN으로 간다
const CLOUDFLARE_TIMEOUT_MS = 5000;

export type TurnCode = "env_missing" | "cf_http" | "cf_no_turn_url" | "cf_timeout" | "cf_exception";

type TurnResponse = { iceServers: RTCIceServer[]; turnError: string | null; turnCode: TurnCode | null };

// 브라우저가 막는 53번 포트 URL은 ICE 수집만 늦추므로 뺀다
function dropPort53(server: RTCIceServer): RTCIceServer {
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
    (u) => !/:53(\?|$)/.test(u),
  );
  return { ...server, urls };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get("t");
  if (!isJoinToken(token)) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }

  const { data: room, error } = await createAdminClient()
    .from("rooms")
    .select("id, status, expires_at, engineer_id")
    .eq("join_token", token)
    .maybeSingle();

  // 404는 '세션이 끝났다'는 뜻으로 쓰이므로(고객 화면이 종료 안내로 바뀜) 조회 오류와 구분한다
  if (error) {
    console.error("[turn] 방 조회 실패:", error);
    after(() =>
      notify("alert", {
        title: "DB 조회 실패 (/api/turn)",
        lines: [errorText(error), "고객·엔지니어 모두 TURN 없이 연결을 시작해요."],
        key: "db-lookup",
        cooldownSec: 900,
      }),
    );
    return NextResponse.json({ error: "lookup failed" }, { status: 503 });
  }

  if (
    !room ||
    room.status === "ended" ||
    new Date(room.expires_at) < new Date()
  ) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  // 누가 받았는지는 쿼리(r=e)가 아니라 로그인으로 판단한다 — 링크를 가진 누구나 r=e를 붙일 수 있다
  const who = async () => {
    if (params.get("r") !== "e") return "customer";
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    return user?.id === room.engineer_id ? "engineer" : "customer";
  };

  const startedAt = Date.now();
  const stunOnly = async (turnCode: TurnCode, turnError: string, status?: number) => {
    console.error(`[turn] STUN만 반환: ${turnError}`);
    const by = await who().catch(() => "customer");
    const ms = Date.now() - startedAt;
    after(() => logEvent(room.id, "system", "turn_fallback", { reason: turnCode, status: status ?? null, ms, who: by }));
    return NextResponse.json<TurnResponse>(
      { iceServers: [STUN], turnError, turnCode },
      { headers: { "Cache-Control": "no-store" } },
    );
  };

  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();

  if (!keyId || !apiToken) {
    return stunOnly("env_missing", "CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN 미설정");
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
        signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return stunOnly("cf_http", `cloudflare ${res.status} ${body.slice(0, 200)}`, res.status);
    }
    const data: { iceServers: RTCIceServer[] } = await res.json();
    const turnServers = data.iceServers.map(dropPort53);
    if (!turnServers.some((s) => [s.urls].flat().some((u) => u.startsWith("turn")))) {
      return stunOnly("cf_no_turn_url", "cloudflare 응답에 turn URL 없음");
    }
    return NextResponse.json<TurnResponse>(
      { iceServers: [STUN, ...turnServers], turnError: null, turnCode: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return stunOnly(
      timeout ? "cf_timeout" : "cf_exception",
      `cloudflare 호출 실패: ${e instanceof Error ? e.message : e}`,
    );
  }
}
