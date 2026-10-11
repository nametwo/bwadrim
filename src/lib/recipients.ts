import { createAdminClient } from "./supabase/admin";

// 받는 분 이름표 (ROOM-16). 엔지니어가 직접 붙인 이름(자유 글)을 카톡 1:1 방 해시에 묶어 두고,
// 같은 분께 다시 보내면 카카오 웹훅(ROOM-15)이 오는 대로 상담에 그 이름표를 잇는다.
// 해시는 보내는 사람·받는 사람 한 쌍마다 다르므로 엔지니어마다 따로다. 전화번호는 저장하지 않는다(NFR-07).
// 서버 전용(service role). 화면에서 쓰는 글자 다듬기는 recipient-label.ts

// 한 번 보낼 때 여러 명을 고르면 카카오가 사람마다 몇 초 안에 따로 알려 온다(실기기 0.5초 간격).
// 이 안에 서로 다른 1:1 방이 둘 이상이면 누구에게 보낸 상담인지 정하지 않는다
const BATCH_MS = 30_000;

type Db = ReturnType<typeof createAdminClient>;

// 이 상담에 30초 안에 알려 온 1:1 방 해시들. 둘 이상이면 여러 명에게 한 번에 보낸 것이다
async function recentDirectChats(db: Db, roomId: string): Promise<Set<string>> {
  const since = new Date(Date.now() - BATCH_MS).toISOString();
  const { data, error } = await db
    .from("events")
    .select("props")
    .eq("room_id", roomId)
    .eq("name", "kakao_sent")
    .gte("created_at", since);
  if (error) throw error;
  const hashes = new Set<string>();
  for (const e of (data ?? []) as { props: Record<string, unknown> | null }[]) {
    if (e.props?.chat_type === "DirectChat" && typeof e.props.hash_chat_id === "string") hashes.add(e.props.hash_chat_id);
  }
  return hashes;
}

/**
 * 여러 명에게 보낸 상담에서 받는 분을 비운다. 그 전에 이번 묶음의 알림이 방 없는 이름표를 어느 방에 입양시켰으면 되돌린다.
 * 알림이 0.5초 간격으로 와서, 먼저 온 알림이 입양까지 마친 뒤에 다음 알림이 '여러 명'을 알아채는 일이 흔하다.
 * 이번 묶음에서 입양된 이름표: 지금 상담에 붙은 이름표의 방이 이번 묶음 해시 가운데 하나이고, 이 엔지니어의 다른 상담에는 그 방이 없다.
 * 다른 상담에 그 방이 있으면 이번 묶음 전부터 그분 이름표였으므로 그대로 둔다.
 * 입양하는 알림과 비우는 알림이 동시에 돌 수 있어, 상담에 붙은 이름표는 다시 읽는다
 */
async function clearRecipient(db: Db, roomId: string, engineerId: string, hashes: Set<string>) {
  const { data: room, error: roomError } = await db.from("rooms").select("recipient_id").eq("id", roomId).maybeSingle();
  if (roomError) throw roomError;
  const rid = (room?.recipient_id as string | null | undefined) ?? null;
  if (rid) {
    const { data: label, error: labelError } = await db.from("recipients").select("kakao_hash").eq("id", rid).maybeSingle();
    if (labelError) throw labelError;
    const h = (label?.kakao_hash as string | null | undefined) ?? null;
    if (h && hashes.has(h)) {
      const { count, error: countError } = await db
        .from("rooms")
        .select("id", { count: "exact", head: true })
        .eq("engineer_id", engineerId)
        .eq("kakao_hash", h)
        .neq("id", roomId);
      if (countError) throw countError;
      if (count === 0) {
        const { error: revertError } = await db.from("recipients").update({ kakao_hash: null }).eq("id", rid).eq("kakao_hash", h);
        if (revertError) throw revertError;
      }
    }
  }
  const { error: clearError } = await db.from("rooms").update({ kakao_hash: null, recipient_id: null }).eq("id", roomId);
  if (clearError) throw clearError;
}

/**
 * 카카오 웹훅이 알려 준 1:1 방을 상담에 잇는다 (서버 전용, RLS 우회). 웹훅의 kakao_sent 기록을 남긴 뒤에 부른다.
 * 이미 이름표가 있는 방이면 상담에 이름표를 붙이고 마지막으로 보낸 날을 새로 한다.
 * 처음 보는 방인데 엔지니어가 알림보다 먼저 이 상담에 이름을 적어 뒀으면(방 없는 이름표) 그 이름표에 이 방을 잇는다.
 * 그 밖에 처음 보는 방이면 해시만 남긴다 → 엔지니어 화면이 '누구에게 보냈나요?'를 묻는다.
 * 1:1 방만 잇는다: 나와의 채팅·그룹방·오픈채팅은 받는 분이 한 사람이 아니다.
 * 30초 안에 서로 다른 1:1 방이 둘 이상 오면(여러 명을 한 번에 고름) 상담의 받는 분을 비우고 묻지 않는다.
 * 먼저 온 알림이 방 없는 이름표를 입양했으면 그것도 되돌린다(clearRecipient). 안 그러면 그 이름이 첫 방에 1년 동안 붙어 남는다.
 * 웹훅이 동시에 와도 끝에 비워지도록, 잇고 나서 한 번 더 확인한다. 나중에 한 분께 다시 보내면 그분으로 잇는다.
 * 끝났거나 만료된 상담은 건드리지 않는다(보낸 직후에만 오는 알림이라 정상이면 그럴 일이 없다).
 */
export async function linkKakaoRecipient(roomId: string, chatType: string, hash: string) {
  if (chatType !== "DirectChat") return;
  try {
    const db = createAdminClient();
    const { data: room, error } = await db
      .from("rooms")
      .select("engineer_id, status, expires_at, recipient_id")
      .eq("id", roomId)
      .maybeSingle();
    if (error) throw error;
    if (!room || room.status === "ended" || new Date(room.expires_at) < new Date()) return;

    const before = await recentDirectChats(db, roomId);
    if (before.size > 1) return await clearRecipient(db, roomId, room.engineer_id, before);

    const { data: known, error: findError } = await db
      .from("recipients")
      .select("id")
      .eq("engineer_id", room.engineer_id)
      .eq("kakao_hash", hash)
      .maybeSingle();
    if (findError) throw findError;

    // 알림보다 먼저 적어 둔 이름(방 없는 이름표)이 있으면 그 이름표가 이 방의 이름표가 된다
    let recipientId: string | null = known?.id ?? null;
    if (!recipientId && room.recipient_id) {
      const { data: adopted, error: adoptError } = await db
        .from("recipients")
        .update({ kakao_hash: hash })
        .eq("id", room.recipient_id)
        .is("kakao_hash", null)
        .select("id")
        .maybeSingle();
      if (adoptError) throw adoptError;
      recipientId = (adopted?.id as string | undefined) ?? null;
    }

    const { error: roomError } = await db
      .from("rooms")
      .update({ kakao_hash: hash, recipient_id: recipientId })
      .eq("id", roomId);
    if (roomError) throw roomError;

    const after = await recentDirectChats(db, roomId);
    if (after.size > 1) return await clearRecipient(db, roomId, room.engineer_id, after);
    if (known) {
      await db.from("recipients").update({ last_sent_at: new Date().toISOString() }).eq("id", known.id);
    }
  } catch (e) {
    console.error("[recipients] 카톡 방 잇기 실패:", e);
  }
}
