"use server";

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { cleanLabel } from "@/lib/recipient-label";

export type EndRoomResult = { ok: true } | { ok: false; reason: "auth" | "db" };

// 상담 끝내기 (ROOM-10). 고객 링크가 닫힌다(status ended).
// connected: 고객과 연결된 적 있는 상담인지. 'ended' 이벤트에 남겨 통계가 연결 없이 닫은 상담을 평균 시간에서 뺀다.
// redirect() 대신 결과를 돌려준다: 클라이언트에서 직접 부른 액션의 redirect는 promise를 reject해서
// 성공했는데도 실패 안내가 뜬다. 이동은 호출측이 한다.
export async function endRoom(roomId: string, connected: boolean): Promise<EndRoomResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  // 인증 서버 일시 장애는 로그인 풀림이 아니다 — 다시 시도하게 한다
  if (!user) {
    return {
      ok: false,
      reason: isAuthRetryableFetchError(authError) ? "db" : "auth",
    };
  }

  // RLS로 자기 방만 갱신된다. 이미 종료된 방은 건드리지 않아 중복 기록을 막는다.
  // rooms.resolved_remotely(예전 '출장 없이 해결?' 답)는 더 쓰지 않는다 — 예전 기록만 남아 있다
  const { data, error } = await supabase
    .from("rooms")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", roomId)
    .neq("status", "ended")
    .select("id, created_at")
    .maybeSingle();

  if (error) return { ok: false, reason: "db" };

  if (data) {
    const durationSec = Math.round((Date.now() - new Date(data.created_at).getTime()) / 1000);
    await logEvent(roomId, "engineer", "ended", { duration_sec: durationSec, connected });
  }

  return { ok: true };
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

// 고객이 어디까지 왔는지 (ROOM-13): 링크를 열었는지, 카메라를 허용·거부했는지.
// 엔지니어 대기 화면이 몇 초마다 묻는다. 자기 방 기록만 읽힌다(RLS). 실패하면 null — 화면은 모르는 것으로 둔다
export type JoinProgress = {
  linkOpened: boolean;
  // 가장 최근 카메라 결과. 거부했다가 다시 허용할 수 있어서 마지막 것만 본다
  camera: "granted" | "denied" | null;
  // 거부 원인(JOIN-05의 reason: NotAllowedError 등)
  deniedReason: string | null;
  // 카톡 카드가 어느 방에든 간 적이 있는지(카카오 알림 kakao_sent, ROOM-15). 새로고침해도 '보낸 뒤' 화면으로
  kakaoSent: boolean;
  // 받는 분 이름표 (ROOM-16). label이 null이면 아직 이름이 없음 → 보낸 뒤 화면이 이름을 묻는다.
  // auto: 카톡 1:1 방(해시)이 이어져 있어 같은 분께 다시 보내면 이름이 저절로 붙는지. 문자·공유·복사는 false.
  // key는 그 방(없으면 'room') — 카톡 알림이 와서 방이 바뀌면 화면이 카드를 새로 그린다.
  // undefined = 이번에 읽지 못함(화면은 하던 대로 둔다)
  recipient?: { key: string; label: string | null; auto: boolean };
};

export async function getJoinProgress(roomId: string): Promise<JoinProgress | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("events")
    .select("id, name, props")
    .eq("room_id", roomId)
    .in("name", ["link_opened", "camera_granted", "camera_denied", "kakao_sent"])
    .order("id", { ascending: true });
  if (error || !data) return null;

  let linkOpened = false;
  let camera: JoinProgress["camera"] = null;
  let deniedReason: string | null = null;
  let kakaoSent = false;
  for (const e of data as { name: string; props: Record<string, unknown> | null }[]) {
    if (e.name === "kakao_sent") kakaoSent = true;
    if (e.name === "link_opened") linkOpened = true;
    if (e.name === "camera_granted") {
      camera = "granted";
      deniedReason = null;
    }
    if (e.name === "camera_denied") {
      camera = "denied";
      deniedReason = typeof e.props?.reason === "string" ? e.props.reason : null;
    }
  }
  // 카메라를 켰다면 링크는 연 것이다 (link_opened 기록이 실패했어도)
  return {
    linkOpened: linkOpened || camera !== null,
    camera,
    deniedReason,
    kakaoSent,
    recipient: await getRecipient(supabase, roomId),
  };
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

// 이 상담의 받는 분 이름표 (ROOM-16). 칸이 아직 없거나(DB 준비 전) 읽지 못하면 undefined
async function getRecipient(supabase: Supabase, roomId: string): Promise<JoinProgress["recipient"]> {
  const { data: room, error } = await supabase
    .from("rooms")
    .select("kakao_hash, recipient_id")
    .eq("id", roomId)
    .maybeSingle();
  if (error || !room) return undefined;
  const hash = (room.kakao_hash as string | null) ?? null;
  const base = { key: hash ?? "room", auto: !!hash };
  if (!room.recipient_id) return { ...base, label: null };
  const { data: r, error: labelError } = await supabase
    .from("recipients")
    .select("label")
    .eq("id", room.recipient_id)
    .maybeSingle();
  if (labelError) return undefined;
  return { ...base, label: r?.label ?? null };
}

export type NameRecipientResult =
  | { ok: true; label: string }
  | { ok: false; reason: "auth" | "empty" | "db" };

// 받는 분 이름 붙이기·고치기 (ROOM-16). 이미 이름표가 있으면 이름만 고친다.
// 카톡 1:1 방(해시)이 있는 상담: 처음이면 그 방의 이름표를 만들고, 같은 분께 보냈지만 이름이 없던 내 다른 상담에도 함께 붙인다.
//   그 뒤로 같은 분께 카톡을 보내면 저절로 붙고, 고치면 그분께 보낸 모든 상담의 이름이 같이 바뀐다.
// 방이 없는 상담(문자·공유·복사, 카톡 알림이 아직 안 옴): 이 상담에만 붙는 이름표를 만든다.
//   카톡 알림이 나중에 오면 이 이름표에 그 방이 이어진다(linkKakaoRecipient)
export async function nameRecipient(roomId: string, raw: string): Promise<NameRecipientResult> {
  const label = cleanLabel(raw);
  if (!label) return { ok: false, reason: "empty" };

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: isAuthRetryableFetchError(authError) ? "db" : "auth" };

  // RLS로 자기 상담·자기 이름표만 읽고 바뀐다
  const { data: room, error } = await supabase
    .from("rooms")
    .select("kakao_hash, recipient_id, created_at")
    .eq("id", roomId)
    .maybeSingle();
  if (error || !room) return { ok: false, reason: "db" };

  if (room.recipient_id) {
    const { error: renameError } = await supabase.from("recipients").update({ label }).eq("id", room.recipient_id);
    return renameError ? { ok: false, reason: "db" } : { ok: true, label };
  }

  if (!room.kakao_hash) {
    // 이 상담에만 붙는 이름표. 보관 기간은 이 상담을 만든 때부터(OPS-06)
    const { data: own, error: ownError } = await supabase
      .from("recipients")
      .insert({ engineer_id: user.id, label, last_sent_at: room.created_at })
      .select("id")
      .single();
    if (ownError || !own) return { ok: false, reason: "db" };
    const { error: linkError } = await supabase
      .from("rooms")
      .update({ recipient_id: own.id })
      .eq("id", roomId)
      .is("recipient_id", null);
    return linkError ? { ok: false, reason: "db" } : { ok: true, label };
  }

  // 웹훅이 늦게 와서 상담에는 아직 안 이어졌지만 같은 방 이름표가 이미 있을 수도 있다
  const { data: existing, error: findError } = await supabase
    .from("recipients")
    .select("id")
    .eq("kakao_hash", room.kakao_hash)
    .maybeSingle();
  if (findError) return { ok: false, reason: "db" };

  let recipientId = existing?.id as string | undefined;
  if (recipientId) {
    const { error: renameError } = await supabase.from("recipients").update({ label }).eq("id", recipientId);
    if (renameError) return { ok: false, reason: "db" };
  } else {
    // 보관 기간은 '그분께 마지막으로 보낸 날'부터다(OPS-06). 이름을 붙인 날이 아니라, 그 방으로 보낸 내 상담 중 가장 늦게 만든 때로
    const { data: last } = await supabase
      .from("rooms")
      .select("created_at")
      .eq("kakao_hash", room.kakao_hash)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: created, error: insertError } = await supabase
      .from("recipients")
      .insert({
        engineer_id: user.id,
        label,
        kakao_hash: room.kakao_hash,
        ...(last?.created_at ? { last_sent_at: last.created_at } : {}),
      })
      .select("id")
      .single();
    if (insertError?.code === "23505") {
      // 다른 화면에서 같은 분 이름을 막 붙였다(unique 충돌) — 그 이름표를 이 이름으로 고친다
      const { data: raced, error: raceError } = await supabase
        .from("recipients")
        .update({ label })
        .eq("kakao_hash", room.kakao_hash)
        .select("id")
        .single();
      if (raceError || !raced) return { ok: false, reason: "db" };
      recipientId = raced.id as string;
    } else {
      if (insertError || !created) return { ok: false, reason: "db" };
      recipientId = created.id as string;
    }
  }

  const { error: linkError } = await supabase
    .from("rooms")
    .update({ recipient_id: recipientId })
    .eq("kakao_hash", room.kakao_hash)
    .is("recipient_id", null);
  return linkError ? { ok: false, reason: "db" } : { ok: true, label };
}

// 레이저 포인터·화면 멈춤·AR 핀·방향 지시 첫 사용 기록 (세션 화면을 열 때마다 1번씩). 자기 방인지는 RLS로 확인
export async function logToolUsed(
  roomId: string,
  name: "pointer_used" | "freeze_used" | "anchor_used" | "guide_used" | "photo_taken",
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data } = await supabase
    .from("rooms")
    .select("id")
    .eq("id", roomId)
    .maybeSingle();
  if (data) await logEvent(roomId, "engineer", name);
}
