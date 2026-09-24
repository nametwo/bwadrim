"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";

// 통화 종료 + 핵심 지표(원격 해결 여부) 기록
export async function endRoom(roomId: string, resolvedRemotely: boolean) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS로 자기 방만 갱신된다
  const { data, error } = await supabase
    .from("rooms")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
      resolved_remotely: resolvedRemotely,
    })
    .eq("id", roomId)
    .select("id, created_at")
    .single();

  if (error || !data) throw new Error("종료 처리에 실패했습니다.");

  const durationSec = Math.round(
    (Date.now() - new Date(data.created_at).getTime()) / 1000,
  );
  await logEvent(roomId, "engineer", "ended", { duration_sec: durationSec });
  if (resolvedRemotely) {
    await logEvent(roomId, "engineer", "resolved_remotely");
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

// ───────────────────────── 주석 지표 (pointer_used · freeze_used) ─────────────────────────
// 클라이언트가 보내는 값은 믿지 않는다: 로그인 확인 → 자기 방인지(RLS) 확인 → 허용된 필드만 골라 기록.

const TRACK_STATES = ["searching", "tracking", "weak", "lost"] as const;
const REFERENCE_REASONS = ["low_texture", "pin_blank", "ambiguous"] as const;

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** 로그인한 엔지니어의 방이면 방 id, 아니면 null */
async function ownRoomId(roomId: unknown): Promise<string | null> {
  if (typeof roomId !== "string" || roomId.length === 0 || roomId.length > 64) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  // RLS가 자기 방만 돌려준다
  const { data } = await supabase.from("rooms").select("id").eq("id", roomId).maybeSingle();
  return data?.id ?? null;
}

/** 주석(핀·선) 확정 1건. props: kind, newAnchor, trackable, customerState (+ referenceReason, seq) */
export async function logPointerUsed(roomId: string, props: unknown) {
  const id = await ownRoomId(roomId);
  if (!id) return;
  const p = (typeof props === "object" && props !== null ? props : {}) as Record<string, unknown>;
  const kind = pick(p.kind, ["pin", "stroke"] as const);
  if (!kind) return;
  const seq = typeof p.seq === "number" && Number.isInteger(p.seq) && p.seq > 0 && p.seq < 1e6 ? p.seq : null;
  await logEvent(id, "engineer", "pointer_used", {
    kind,
    newAnchor: p.newAnchor === true,
    trackable: boolOrNull(p.trackable),
    customerState: pick(p.customerState, TRACK_STATES),
    referenceReason: pick(p.referenceReason, REFERENCE_REASONS),
    seq,
  });
}

/** 정지 화면 켬 1건. props: hasAnchor, customerState */
export async function logFreezeUsed(roomId: string, props: unknown) {
  const id = await ownRoomId(roomId);
  if (!id) return;
  const p = (typeof props === "object" && props !== null ? props : {}) as Record<string, unknown>;
  await logEvent(id, "engineer", "freeze_used", {
    hasAnchor: p.hasAnchor === true,
    customerState: pick(p.customerState, TRACK_STATES),
  });
}
