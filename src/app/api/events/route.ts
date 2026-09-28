import { NextResponse, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logEvent, type EventName } from "@/lib/events";
import { appEnv, appVersion, notify } from "@/lib/alerts";
import { errorText } from "@/lib/alert-rules";
import { isJoinToken } from "@/lib/join-token";
import { redactProps } from "@/lib/redact";

// 브라우저 쪽 지표 기록 (DATA-01·04·07). events 표엔 anon insert 정책이 없으므로 이 API를 거친다.
//   고객: 유효한 링크 토큰(token)을 아는 요청
//   엔지니어: role=engineer + 로그인 쿠키가 그 상담의 주인일 때 (token 또는 room id)
// call_summary는 events가 아니라 call_reports에 화면(pid)마다 한 줄로 덮어쓴다.
// 기록은 응답을 보낸 뒤(after) 한다 — 폰이 떠나는 중(sendBeacon)이어도 막히지 않게.

type Role = "customer" | "engineer";

const ALLOWED: Record<Role, readonly string[]> = {
  customer: [
    "camera_granted",
    "camera_denied",
    "call_ready",
    "call_stuck",
    "call_failed",
    "connected",
    "relay_used",
    "client_error",
    "call_summary",
  ],
  engineer: [
    "call_ready",
    "call_stuck",
    "call_failed",
    "connected",
    "relay_used",
    "client_error",
    "call_summary",
  ],
};

// 상담이 끝나거나 만료된 뒤에도 받는 기록 — 실패·요약은 끝나는 순간에 가장 많이 생긴다.
// 끝없이 받지 않게 만료 후 하루까지만, 상담마다 개수도 제한한다 (BUG-15)
const LATE_OK = new Set(["call_failed", "client_error", "call_summary"]);
const LATE_GRACE_MS = 24 * 3600_000;
const MAX_PER_ROOM = 50;
const MAX_REPORTS_PER_ROOM = 40;

const MAX_BODY = 24_000;
const MAX_PROPS: Record<string, number> = { call_summary: 16_000 };
const DEFAULT_MAX_PROPS = 4_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PID_RE = /^[0-9a-f]{16}$/;

interface Body {
  token?: unknown;
  room?: unknown;
  role?: unknown;
  pid?: unknown;
  name?: unknown;
  props?: unknown;
}

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return bad(413, "too large");
  let body: Body;
  try {
    body = JSON.parse(text) as Body;
  } catch {
    return bad(400, "invalid body");
  }
  if (!body || typeof body !== "object") return bad(400, "invalid body");

  const role: Role = body.role === "engineer" ? "engineer" : "customer";
  const name = typeof body.name === "string" ? body.name : "";
  if (!ALLOWED[role].includes(name)) return bad(400, "invalid event");

  const pid = typeof body.pid === "string" && PID_RE.test(body.pid) ? body.pid : null;
  if (name === "call_summary" && !pid) return bad(400, "pid required");

  const rawProps = body.props ?? {};
  if (typeof rawProps !== "object" || rawProps === null || Array.isArray(rawProps)) return bad(400, "invalid props");
  const props = rawProps as Record<string, unknown>;
  if (JSON.stringify(props).length > (MAX_PROPS[name] ?? DEFAULT_MAX_PROPS)) return bad(413, "props too large");

  // 어느 상담인지: 고객은 링크 토큰, 엔지니어는 토큰이나 상담 id
  const admin = createAdminClient();
  let query = admin.from("rooms").select("id, status, expires_at, engineer_id");
  if (isJoinToken(body.token)) query = query.eq("join_token", body.token);
  else if (role === "engineer" && typeof body.room === "string" && UUID_RE.test(body.room)) query = query.eq("id", body.room);
  else return bad(400, "invalid event");

  const { data: room, error: lookupError } = await query.maybeSingle();
  if (lookupError) {
    console.error("[events] 방 조회 실패:", lookupError);
    after(() =>
      notify("alert", {
        title: "DB 조회 실패 (/api/events)",
        lines: [errorText(lookupError)],
        key: "db-lookup",
        cooldownSec: 900,
      }),
    );
    return bad(503, "lookup failed");
  }
  if (!room) return bad(404, "room not found");

  if (role === "engineer") {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user || user.id !== room.engineer_id) return bad(403, "not owner");
  }

  const expiresAt = new Date(room.expires_at).getTime();
  const open = room.status !== "ended" && expiresAt > Date.now();
  if (!open && !(LATE_OK.has(name) && expiresAt + LATE_GRACE_MS > Date.now())) {
    return bad(404, "room not found");
  }

  // 상담·쪽(고객/엔지니어)마다 개수 제한 — 링크를 가진 누구나 부를 수 있어서 (BUG-15).
  // 쪽마다 따로 세야 고객 쪽 기록이 엔지니어 기록 자리를 다 쓰지 못한다. 셀 수 없으면(오류) 받는다
  if (LATE_OK.has(name)) {
    if (name === "call_summary") {
      const { data: existing } = await admin
        .from("call_reports")
        .select("pid")
        .eq("room_id", room.id)
        .eq("actor", role)
        .limit(MAX_REPORTS_PER_ROOM + 1);
      if (existing && existing.length >= MAX_REPORTS_PER_ROOM && !existing.some((r) => r.pid === pid)) {
        return bad(429, "too many");
      }
    } else {
      const { count } = await admin
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("room_id", room.id)
        .eq("actor", role)
        .eq("name", name);
      if ((count ?? 0) >= MAX_PER_ROOM) return bad(429, "too many");
    }
  }

  const roomId = room.id as string;
  after(async () => {
    if (name === "call_summary") {
      const report = {
        ...(redactProps(props) as Record<string, unknown>),
        v: appVersion(),
        env: appEnv(),
      };
      const { error } = await admin
        .from("call_reports")
        .upsert(
          { room_id: roomId, pid, actor: role, report, updated_at: new Date().toISOString() },
          { onConflict: "room_id,pid" },
        );
      if (error) {
        console.error("[events] call_reports 기록 실패:", error);
        await notify("alert", {
          title: "상담 요약 기록 실패 (call_reports)",
          lines: [errorText(error), "supabase/schema.sql을 다시 실행했는지 확인해 주세요 (OPS-04)."],
          key: "reports-upsert",
          cooldownSec: 3600,
        });
      }
      return;
    }
    await logEvent(roomId, role, name as EventName, pid ? { ...props, pid } : props);
  });

  return new NextResponse(null, { status: 204 });
}
