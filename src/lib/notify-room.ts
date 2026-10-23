import { createAdminClient } from "./supabase/admin";
import { engineerNameOf } from "./engineer-name";
import { describeEvent, hasMessage, type NotifyContext } from "./notify-events";
import { allowGeneral, forgetUrgent, notifyEnabled, schedule, sendDiscord, shouldSendUrgent } from "./notify";

// 지표 이벤트를 디스코드로 (OPS-09). logEvent가 기록을 마친 뒤 부른다.
// 상담 정보(엔지니어 이름·받는 분 이름표, 끝날 때는 카메라를 켰었는지·쓴 도구)는 응답을 돌려준 뒤에 찾는다 —
// 고객 화면이 열리는 길(link_opened)에서 기다리지 않게. 못 찾으면 이름 없이 보낸다. 서버 전용

const TOOL_EVENTS = ["pointer_used", "freeze_used", "anchor_used", "guide_used", "photo_taken"];

async function roomContext(roomId: string, name: string): Promise<NotifyContext> {
  const ctx: NotifyContext = { id: roomId, engineer: null, recipient: null };
  const admin = createAdminClient();
  try {
    const { data: room } = await admin.from("rooms").select("engineer_id, recipient_id").eq("id", roomId).maybeSingle();
    if (room?.engineer_id) {
      ctx.engineer = await admin.auth.admin
        .getUserById(room.engineer_id)
        .then(({ data }) => engineerNameOf(data.user))
        .catch(() => null);
    }
    if (room?.recipient_id) {
      const { data: r } = await admin.from("recipients").select("label").eq("id", room.recipient_id).maybeSingle();
      ctx.recipient = typeof r?.label === "string" ? r.label : null;
    }
    if (name === "ended") {
      const { data: events } = await admin.from("events").select("name").eq("room_id", roomId);
      const names = new Set((events ?? []).map((e: { name: string }) => e.name));
      ctx.hadCamera = names.has("camera_granted");
      ctx.tools = TOOL_EVENTS.filter((t) => names.has(t));
    }
  } catch (e) {
    console.warn("[notify] 상담 정보 조회 실패(이름 없이 보냄):", e instanceof Error ? e.message : e);
  }
  return ctx;
}

/** 기록된 이벤트를 디스코드로. 웹훅이 없거나 글이 되지 않는 이벤트(도구 사용 등)면 아무것도 하지 않는다 */
export function notifyEvent(roomId: string, name: string, props: Record<string, unknown>): void {
  if (!notifyEnabled() || !hasMessage(name)) return;
  // 일반 글 수는 지금 센다 — 되풀이 호출이 상담 정보 조회까지 일으키지 않게
  const general = allowGeneral(roomId);
  schedule(async () => {
    const ctx = await roomContext(roomId, name);
    const m = describeEvent(name, props, ctx);
    if (m.general && general) await sendDiscord("general", m.general);
    if (m.urgent && shouldSendUrgent(m.urgent.key)) {
      if (!(await sendDiscord("urgent", m.urgent.text))) forgetUrgent(m.urgent.key);
    }
  });
}
