"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { isRoomLimitError } from "@/lib/room-quota";

export async function createRoom() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 고객 링크 토큰(join_token)은 DB가 채운다 (ROOM-12)
  const { data, error } = await supabase
    .from("rooms")
    .insert({ engineer_id: user.id })
    .select("id")
    .single();
  // 이번 달 상담을 다 썼으면 DB가 막는다 (ROOM-17). 대시보드가 '이번 달 상담을 다 썼어요'를 보여 준다
  if (isRoomLimitError(error)) redirect("/dashboard");
  if (error || !data) throw new Error(`방 생성 실패: ${error?.message}`);
  const roomId = data.id;

  await logEvent(roomId, "engineer", "room_created");
  redirect(`/room/${roomId}`);
}
