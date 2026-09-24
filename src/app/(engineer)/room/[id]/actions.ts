"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";

// 통화 종료 + 핵심 지표(원격 해결 여부) 기록.
// resolvedRemotely가 null이면 고객과 한 번도 연결되지 않은 세션을 닫은 것 — 원격 해결률에서 뺀다.
export async function endRoom(
  roomId: string,
  resolvedRemotely: boolean | null,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS로 자기 방만 갱신된다. 이미 종료된 방은 건드리지 않아 중복 기록을 막는다
  const { data, error } = await supabase
    .from("rooms")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
      resolved_remotely: resolvedRemotely,
    })
    .eq("id", roomId)
    .neq("status", "ended")
    .select("id, created_at")
    .maybeSingle();

  if (error) throw new Error("종료 처리에 실패했습니다.");

  if (data) {
    const durationSec = Math.round(
      (Date.now() - new Date(data.created_at).getTime()) / 1000,
    );
    await logEvent(roomId, "engineer", "ended", {
      duration_sec: durationSec,
      resolved_remotely: resolvedRemotely,
    });
    if (resolvedRemotely) {
      await logEvent(roomId, "engineer", "resolved_remotely");
    }
  }

  redirect("/dashboard");
}

// 연결 성사 시 상태 전환 (엔지니어 클라이언트에서 호출)
export async function markRoomActive(roomId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("rooms")
    .update({ status: "active" })
    .eq("id", roomId)
    .eq("status", "waiting");
}
