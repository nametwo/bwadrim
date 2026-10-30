import type { SupabaseClient } from "@supabase/supabase-js";
import { kstMonthStartIso } from "./format";

// 한 달 상담 한도 (ROOM-17). 한도는 DB가 정하고(엔지니어마다, 기본 30건) 넘으면 DB가 상담 만들기를 막는다.
// 화면은 '12 / 30건'과 다 썼을 때 안내만 한다. 못 읽은 값은 null — 0건이나 한도 없음으로 단정하지 않는다
export type RoomQuota = { used: number | null; limit: number | null };

export async function readRoomQuota(supabase: SupabaseClient): Promise<RoomQuota> {
  const [count, limit] = await Promise.all([
    // 이번 달(한국 시간) 만든 상담 수. 줄은 받지 않고 개수만(HEAD)
    supabase.from("rooms").select("id", { count: "exact", head: true }).gte("created_at", kstMonthStartIso()),
    supabase.rpc("my_room_limit"),
  ]);
  return {
    used: count.error || count.count === null ? null : count.count,
    limit: limit.error || typeof limit.data !== "number" ? null : limit.data,
  };
}

/** 이번 달 한도를 다 썼는지. 둘 중 하나라도 못 읽었으면 막지 않는다(막는 것은 DB가 한다) */
export function quotaFull({ used, limit }: RoomQuota): boolean {
  return used !== null && limit !== null && used >= limit;
}

/** DB 트리거가 한도로 막았을 때의 오류 (supabase/schema.sql enforce_room_limit) */
export function isRoomLimitError(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "P0001" && error.message === "room_limit";
}
