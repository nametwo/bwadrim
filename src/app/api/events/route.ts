import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent, type EventName } from "@/lib/events";

// 고객(anon) 쪽 지표 이벤트 수집. events 테이블엔 anon insert 정책이 없으므로
// 유효한 방 코드를 아는 요청만 이 API를 통해 기록한다.
// pointer_used(고객): 기사님 표시 하나에 대한 고객 화면의 추적 결과 요약 (찾기까지 걸린 시간, 보인 비율 등).
const CUSTOMER_EVENTS: EventName[] = [
  "camera_granted",
  "camera_denied",
  "connected",
  "relay_used",
  "pointer_used",
];

/** 요청 본문 상한 (바이트) — 지표 props는 작다 */
const MAX_BODY_BYTES = 4096;
const MAX_PROPS = 16;
const MAX_STRING = 64;

type Prop = string | number | boolean | null;

// 고객 pointer_used: 이 필드만, 이 형식만 받는다
const OUTCOME_NUMBERS = ["anchor_ms", "acquire_ms", "tracked_ms", "card_ms", "arrow_ms", "annotations"] as const;
const OUTCOME_ENDS = ["replaced", "cleared", "ended"];
/** 시간 필드 상한 (ms, 하루) */
const MAX_MS = 86_400_000;

function cleanOutcome(raw: Record<string, unknown>): Record<string, Prop> | null {
  const out: Record<string, Prop> = { side: "customer" };
  for (const k of OUTCOME_NUMBERS) {
    const v = raw[k];
    if (v === null && k === "acquire_ms") {
      out[k] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_MS) return null;
    out[k] = Math.round(v);
  }
  const f = raw.tracked_fraction;
  if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 1) return null;
  out.tracked_fraction = Math.round(f * 1000) / 1000;
  const end = raw.end;
  if (typeof end !== "string" || !OUTCOME_ENDS.includes(end)) return null;
  out.end = end;
  return out;
}

/** 그 밖의 이벤트: 평평한 원시값만, 개수·길이 제한 */
function cleanProps(raw: Record<string, unknown>): Record<string, Prop> {
  const out: Record<string, Prop> = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_PROPS)) {
    if (k.length > MAX_STRING) continue;
    if (typeof v === "string") out[k] = v.slice(0, 512);
    else if (typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export async function POST(request: Request) {
  let body: { code?: string; name?: string; props?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { code, name } = body ?? {};
  if (
    typeof code !== "string" ||
    code.length > 32 ||
    !CUSTOMER_EVENTS.includes(name as EventName)
  ) {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }

  const rawProps =
    typeof body.props === "object" && body.props !== null && !Array.isArray(body.props)
      ? (body.props as Record<string, unknown>)
      : {};
  const props = name === "pointer_used" ? cleanOutcome(rawProps) : cleanProps(rawProps);
  if (!props) {
    return NextResponse.json({ error: "invalid props" }, { status: 400 });
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

  await logEvent(room.id, "customer", name as EventName, props);
  return new NextResponse(null, { status: 204 });
}
