import { createAdminClient } from "./supabase/admin";
import { notifyEvent } from "./notify-room";
import { notifyUrgent } from "./notify";

// CLAUDE.md의 이벤트 이름 목록과 동기화할 것.
// 예전 기록에는 'resolved_remotely'(출장 없이 해결)도 남아 있다 — 그 질문을 없애 더는 남기지 않는다
export type EventName =
  | "room_created"
  | "link_opened"
  | "camera_granted"
  | "camera_denied"
  | "connected"
  | "relay_used"
  | "pointer_used"
  | "freeze_used"
  | "anchor_used"
  | "guide_used"
  | "photo_taken"
  | "kakao_sent"
  | "turn_issued"
  | "connect_failed"
  | "ended";

export type EventActor = "engineer" | "customer" | "system";

// 지표 기록. 실패해도 기능을 막지 않는다 — 로그와 응급 알림만 남기고 넘어감.
// 기록된 이벤트는 디스코드 일반 채널로도 간다 (OPS-09, 응답을 돌려준 뒤에)
export async function logEvent(
  roomId: string,
  actor: EventActor,
  name: EventName,
  props: Record<string, unknown> = {},
) {
  try {
    const { error } = await createAdminClient()
      .from("events")
      .insert({ room_id: roomId, actor, name, props });
    if (error) throw error;
  } catch (e) {
    console.error(`[events] ${name} 기록 실패:`, e);
    const msg = (e as { message?: unknown } | null)?.message;
    notifyUrgent(
      "events-db",
      `🚨 지표 기록 실패 — ${name} (상담 ${roomId.slice(0, 8)}): ${typeof msg === "string" ? msg : String(e)}. Supabase에 쓰기가 안 되는지 봐 주세요`,
    );
    return;
  }
  notifyEvent(roomId, name, props);
}
