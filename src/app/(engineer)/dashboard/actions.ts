"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";

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
  if (error || !data) throw new Error(`방 생성 실패: ${error?.message}`);
  const roomId = data.id;

  await logEvent(roomId, "engineer", "room_created");
  redirect(`/room/${roomId}`);
}
