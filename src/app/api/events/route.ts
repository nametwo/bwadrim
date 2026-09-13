import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent, type EventName } from "@/lib/events";

// 고객(anon) 쪽 지표 이벤트 수집. events 테이블엔 anon insert 정책이 없으므로
// 유효한 방 코드를 아는 요청만 이 API를 통해 기록한다.
const CUSTOMER_EVENTS: EventName[] = [
  "camera_granted",
  "camera_denied",
  "connected",
  "relay_used",
];

export async function POST(request: Request) {
  let body: { code?: string; name?: string; props?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { code, name } = body;
  if (
    typeof code !== "string" ||
    !CUSTOMER_EVENTS.includes(name as EventName)
  ) {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }

  const { data: room } = await createAdminClient()
    .from("rooms")
    .select("id, status, expires_at")
    .eq("code", code.toUpperCase())
    .maybeSingle();

  if (
    !room ||
    room.status === "ended" ||
    new Date(room.expires_at) < new Date()
  ) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  await logEvent(room.id, "customer", name as EventName, body.props ?? {});
  return new NextResponse(null, { status: 204 });
}
