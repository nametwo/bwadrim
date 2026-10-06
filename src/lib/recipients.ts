import { createAdminClient } from "./supabase/admin";

// 받는 분 이름표 (ROOM-16). 엔지니어가 직접 붙인 이름(자유 글)을 카톡 1:1 방 해시에 묶어 두고,
// 같은 분께 다시 보내면 카카오 웹훅(ROOM-15)이 오는 대로 상담에 그 이름표를 잇는다.
// 해시는 보내는 사람·받는 사람 한 쌍마다 다르므로 엔지니어마다 따로다. 전화번호는 저장하지 않는다(NFR-07).
// 서버 전용(service role). 화면에서 쓰는 글자 다듬기는 recipient-label.ts

// 한 번 보낼 때 여러 명을 고르면 카카오가 사람마다 몇 초 안에 따로 알려 온다(실기기 0.5초 간격).
// 이 안에 서로 다른 1:1 방이 둘 이상이면 누구에게 보낸 상담인지 정하지 않는다
const BATCH_MS = 30_000;

type Db = ReturnType<typeof createAdminClient>;

async function sentToMany(db: Db, roomId: string) {
  const since = new Date(Date.now() - BATCH_MS).toISOString();
  const { data, error } = await db
    .from("events")
    .select("props")
    .eq("room_id", roomId)
    .eq("name", "kakao_sent")
    .gte("created_at", since);
  if (error) throw error;
  const hashes = new Set(
    ((data ?? []) as { props: Record<string, unknown> | null }[])
      .filter((e) => e.props?.chat_type === "DirectChat")
      .map((e) => e.props?.hash_chat_id),
  );
  return hashes.size > 1;
}

/**
 * 카카오 웹훅이 알려 준 1:1 방을 상담에 잇는다 (서버 전용, RLS 우회). 웹훅의 kakao_sent 기록을 남긴 뒤에 부른다.
 * 이미 이름표가 있는 방이면 상담에 이름표를 붙이고 마지막으로 보낸 날을 새로 한다.
 * 처음 보는 방이면 해시만 남긴다 → 엔지니어 화면이 '누구에게 보냈나요?'를 묻는다.
 * 1:1 방만 잇는다: 나와의 채팅·그룹방·오픈채팅은 받는 분이 한 사람이 아니다.
 * 30초 안에 서로 다른 1:1 방이 둘 이상 오면(여러 명을 한 번에 고름) 상담의 받는 분을 비우고 묻지 않는다.
 * 웹훅이 동시에 와도 끝에 비워지도록, 잇고 나서 한 번 더 확인한다. 나중에 한 분께 다시 보내면 그분으로 잇는다.
 * 끝났거나 만료된 상담은 건드리지 않는다(보낸 직후에만 오는 알림이라 정상이면 그럴 일이 없다).
 */
export async function linkKakaoRecipient(roomId: string, chatType: string, hash: string) {
  if (chatType !== "DirectChat") return;
  try {
    const db = createAdminClient();
    const { data: room, error } = await db
      .from("rooms")
      .select("engineer_id, status, expires_at")
      .eq("id", roomId)
      .maybeSingle();
    if (error) throw error;
    if (!room || room.status === "ended" || new Date(room.expires_at) < new Date()) return;

    const clear = async () => {
      const { error: clearError } = await db.from("rooms").update({ kakao_hash: null, recipient_id: null }).eq("id", roomId);
      if (clearError) throw clearError;
    };
    if (await sentToMany(db, roomId)) return await clear();

    const { data: known, error: findError } = await db
      .from("recipients")
      .select("id")
      .eq("engineer_id", room.engineer_id)
      .eq("kakao_hash", hash)
      .maybeSingle();
    if (findError) throw findError;

    const { error: roomError } = await db
      .from("rooms")
      .update({ kakao_hash: hash, recipient_id: known?.id ?? null })
      .eq("id", roomId);
    if (roomError) throw roomError;

    if (await sentToMany(db, roomId)) return await clear();
    if (known) {
      await db.from("recipients").update({ last_sent_at: new Date().toISOString() }).eq("id", known.id);
    }
  } catch (e) {
    console.error("[recipients] 카톡 방 잇기 실패:", e);
  }
}
