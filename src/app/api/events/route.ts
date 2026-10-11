import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/events";
import { parseCustomerEvent } from "@/lib/customer-event";

// 고객(anon) 쪽 지표 이벤트 수집. events 테이블엔 anon insert 정책이 없으므로
// 유효한 고객 링크 토큰을 아는 요청만 이 API를 통해 기록한다.
// 부가정보는 이벤트마다 정해 둔 형식만 남긴다(customer-event.ts). 횟수 제한은 아직 없다(BUG-15)

// 고객 화면이 보내는 본문은 100자 남짓이다. 이보다 크면 읽지 않는다
const MAX_BODY = 2048;

export async function POST(request: Request) {
  // 길이가 적혀 오면 읽기 전에 거른다. 안 적혀 와도(chunked) 읽은 뒤 다시 잰다
  if (Number(request.headers.get("content-length")) > MAX_BODY) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const event = parseCustomerEvent(raw);
  if (!event) {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }

  const { data: room } = await createAdminClient()
    .from("rooms")
    .select("id, status, expires_at")
    .eq("join_token", event.token)
    .maybeSingle();

  if (
    !room ||
    room.status === "ended" ||
    new Date(room.expires_at) < new Date()
  ) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  await logEvent(room.id, "customer", event.name, event.props);
  return new NextResponse(null, { status: 204 });
}
