import { createAdminClient } from "./supabase/admin";
import { alertOnEvent, errorText } from "./alert-rules";
import { appEnv, appVersion, notify } from "./alerts";
import { redactProps } from "./redact";

// CLAUDE.md의 이벤트 이름 목록과 동기화할 것 (DATA-01)
export type EventName =
  | "room_created"
  | "link_opened"
  | "link_blocked"
  | "camera_granted"
  | "camera_denied"
  | "call_ready"
  | "call_stuck"
  | "call_failed"
  | "connected"
  | "relay_used"
  | "turn_fallback"
  | "client_error"
  | "pointer_used"
  | "freeze_used"
  | "anchor_used"
  | "guide_used"
  | "photo_taken"
  | "ended"
  | "resolved_remotely";

export type EventActor = "engineer" | "customer" | "system";

// 지표 기록. 실패해도 기능을 막지 않는다 — 로그와 응급 알림만 남기고 넘어감.
// 모든 기록에 배포 버전(v)과 환경(env)을 붙인다: 바꾸기 전후를 나누고, 로컬·Preview 기록을 지표에서 빼려고.
// roomId가 null이면 어느 상담인지 모르는 서버 기록(예: 방 조회 오류) — 통계 화면(RLS)에는 안 보인다.
export async function logEvent(
  roomId: string | null,
  actor: EventActor,
  name: EventName,
  props: Record<string, unknown> = {},
) {
  const clean = {
    ...(redactProps(props) as Record<string, unknown>),
    v: appVersion(),
    env: appEnv(),
  };
  try {
    const { error } = await createAdminClient()
      .from("events")
      .insert({ room_id: roomId, actor, name, props: clean });
    if (error) throw error;
  } catch (e) {
    console.error(`[events] ${name} 기록 실패:`, e);
    // 기록 자체가 안 되면 events 표로는 알 수 없다 — 바로 응급 알림
    await notify("alert", {
      title: "지표 기록 실패 (events insert)",
      lines: [`이벤트: ${name}`, `오류: ${errorText(e)}`],
      key: "events-insert",
      cooldownSec: 1800,
    });
    return;
  }
  await alertOnEvent(roomId, actor, name, clean);
}
