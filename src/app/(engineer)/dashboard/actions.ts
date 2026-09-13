"use server";

import { randomInt } from "node:crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";

// 혼동 쉬운 문자(0/O, 1/I/L) 제외 — supabase/schema.sql의 gen_room_code와 동일
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function genRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export async function createRoom() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let roomId: string | null = null;

  // 코드 유니크 충돌 시 재시도
  for (let attempt = 0; attempt < 3 && !roomId; attempt++) {
    const { data, error } = await supabase
      .from("rooms")
      .insert({ code: genRoomCode(), engineer_id: user.id })
      .select("id")
      .single();

    if (data) {
      roomId = data.id;
    } else if (error && error.code !== "23505") {
      throw new Error(`방 생성 실패: ${error.message}`);
    }
  }

  if (!roomId) throw new Error("방 코드 생성에 계속 실패했습니다.");

  await logEvent(roomId, "engineer", "room_created");
  redirect(`/room/${roomId}`);
}
