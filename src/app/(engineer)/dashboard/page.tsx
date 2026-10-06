import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDuration, formatKstDateTime, formatKstRange, kstMonthStartIso } from "@/lib/format";
import { endedConnected } from "@/lib/metrics";
import { engineerNameOf } from "@/lib/engineer-name";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Brand } from "@/components/ui/brand";
import { ChartIcon, ChevronRightIcon, ClockIcon, LogoutIcon, MessageIcon, RefreshIcon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/status-chip";
import { logout } from "../login/actions";
import { createRoom } from "./actions";
import { NewRoomButton } from "./new-room-button";
import { MicAheadLink } from "./mic-ahead-link";

export const metadata: Metadata = {
  title: "상담 목록 | 봐드림",
};

type Room = {
  id: string;
  status: string;
  // 예전 기록의 해결 여부. 이제 쓰지 않는 칸이지만 예전 상담이 연결됐었는지 가리는 데 쓴다
  resolved_remotely: boolean | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
};

// 종료 처리 안 한 채 24시간이 지난 세션은 고객 링크가 막혔으므로 '만료'로 본다 (DB 상태는 그대로)
function isOpen(room: { status: string; expires_at: string }, now: Date) {
  return room.status !== "ended" && new Date(room.expires_at) >= now;
}

// 끝난 상담의 상태 (ROOM-04) — 피그마 StatusChip. 결과를 매기지 않으므로 모두 중립색(회색)
function statusOf(room: Room, connected: boolean) {
  if (room.status !== "ended") return "만료";
  return connected ? "끝남" : "연결 안 됨";
}

function durationSec(room: { created_at: string; ended_at: string | null }) {
  return room.ended_at ? (new Date(room.ended_at).getTime() - new Date(room.created_at).getTime()) / 1000 : null;
}

// 대시보드 (피그마 E02). 회색 바탕에 흰 카드 세 장 — 이번 달(상담 수 한 숫자, 누르면 통계),
// 진행 중(내가 이어서 할 일), 최근 상담. 파란 버튼은 '새 A/S 시작' 하나, 한 손으로 누르게 화면 아래에 붙인다.
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy가 1차로 막지만, 데이터 접근 지점에서 한 번 더 확인
  if (!user) redirect("/login");

  const [{ data: rooms }, month] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, status, resolved_remotely, created_at, expires_at, ended_at")
      .order("created_at", { ascending: false })
      .limit(20),
    // 이번 달(한국 시간) 만든 상담 수. 줄은 받지 않고 개수만(HEAD)
    supabase.from("rooms").select("id", { count: "exact", head: true }).gte("created_at", kstMonthStartIso()),
  ]);

  const now = new Date();
  const name = engineerNameOf(user);
  const list = (rooms ?? []) as Room[];
  const open = list.filter((r) => isOpen(r, now));
  const past = list.filter((r) => !isOpen(r, now));
  const monthCount = month.count ?? 0;

  // 끝난 상담이 고객과 연결됐었는지 (metrics.endedConnected와 같은 판정).
  // 예전 상담은 방에 남은 해결 여부로, 그 밖에는 'ended' 기록으로 가린다. 목록에 보이는 방 것만 한 번에 읽는다(RLS로 자기 방만)
  const connectedIds = new Set(
    past.filter((r) => r.status === "ended" && endedConnected(null, r.resolved_remotely)).map((r) => r.id),
  );
  const unknown = past.filter((r) => r.status === "ended" && !connectedIds.has(r.id)).map((r) => r.id);
  // 기록을 못 읽었으면 연결 여부를 모른다 — '연결 안 됨'으로 단정하지 않고 '끝남'(걸린 시간 없이)으로 둔다
  let endedReadFailed = false;
  if (unknown.length > 0) {
    const { data: ended, error } = await supabase
      .from("events")
      .select("room_id, props")
      .eq("name", "ended")
      .in("room_id", unknown);
    endedReadFailed = !!error;
    for (const e of (ended ?? []) as { room_id: string; props: Record<string, unknown> | null }[]) {
      if (endedConnected(e.props)) connectedIds.add(e.room_id);
    }
  }

  const labels = await recipientLabels(supabase, list.map((r) => r.id));

  return (
    <div className="flex min-h-dvh flex-col bg-bg-muted">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]">
        <header className="flex min-h-14 items-center justify-between">
          <Brand />
          <div className="-mr-2 flex items-center">
            <Link
              href="/stats"
              className="flex h-touch items-center gap-1.5 rounded-xl px-3 text-label-m text-text-secondary active:bg-border"
            >
              <ChartIcon className="size-5" />
              통계
            </Link>
            <form action={logout}>
              <button
                type="submit"
                className="flex h-touch items-center gap-1.5 rounded-xl px-3 text-label-m text-text-secondary active:bg-border"
              >
                <LogoutIcon className="size-5" />
                로그아웃
              </button>
            </form>
          </div>
        </header>

        <h1 className="pt-3 pb-5 text-title-l">{name ? `${name}님, 안녕하세요` : "안녕하세요"}</h1>

        <div className="flex flex-col gap-3">
          {/* 이번 달 상담 수 한 숫자. 누르면 통계 (DATA-06) */}
          <Link
            href="/stats"
            data-testid="month-card"
            aria-label={`이번 달 상담 ${monthCount}건, 통계 보기`}
            className="flex flex-col rounded-3xl bg-bg-page p-5 transition-colors active:bg-bg-subtle"
          >
            <span className="flex items-center justify-between text-label-m text-text-secondary">
              이번 달 상담
              <ChevronRightIcon className="size-5 text-icon-secondary" />
            </span>
            <span className="mt-1 text-display-l text-text-primary">{monthCount}건</span>
          </Link>

          {open.length > 0 && (
            <section className="rounded-3xl bg-bg-page py-2">
              <h2 className="px-5 pt-3 pb-1 text-title-s">
                진행 중 <span className="text-text-secondary">{open.length}</span>
              </h2>
              <ul>
                {open.map((room) => {
                  const waiting = room.status === "waiting";
                  const hoursLeft = Math.max(
                    1,
                    Math.floor((new Date(room.expires_at).getTime() - now.getTime()) / 3_600_000),
                  );
                  return (
                    <li key={room.id}>
                      {/* 무엇을 이어서 할지(상태)가 먼저, 시각은 보조 */}
                      <MicAheadLink
                        roomId={room.id}
                        href={`/room/${room.id}`}
                        className="flex items-center gap-3 px-5 py-3 active:bg-bg-subtle"
                      >
                        <span
                          className={`grid size-11 flex-none place-items-center rounded-full ${
                            waiting ? "bg-warning-tint text-text-warning" : "bg-primary-tint text-icon-brand"
                          }`}
                        >
                          {waiting ? <ClockIcon className="size-[22px]" /> : <RefreshIcon className="size-[22px]" />}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          {/* 연결된 뒤 '통화 끝내기' 없이 나간 상담. 누르면 다시 연결하거나 끝낼 수 있다 */}
                          <span className="text-label-l">{waiting ? "고객님 기다리는 중" : "끝내지 않은 상담"}</span>
                          <span className={`text-body-s text-text-secondary ${labels.has(room.id) ? "break-keep" : "truncate"}`}>
                            {labels.has(room.id) && `${labels.get(room.id)} · `}
                            {formatKstDateTime(new Date(room.created_at), now)} · 링크 {hoursLeft}시간 남음
                          </span>
                        </span>
                        <ChevronRightIcon aria-label="이어하기" className="size-5 flex-none text-icon-secondary" />
                      </MicAheadLink>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="rounded-3xl bg-bg-page py-2">
            <h2 className="px-5 pt-3 pb-1 text-title-s">최근 상담</h2>
            {list.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 pt-6 pb-8 text-center">
                <span className="mb-2 grid size-14 place-items-center rounded-full bg-bg-muted text-icon-secondary">
                  <MessageIcon className="size-7" />
                </span>
                <p className="text-label-l">아직 상담이 없어요</p>
                <p className="text-body-m text-text-secondary">아래 &lsquo;새 A/S 시작&rsquo;을 눌러 보세요</p>
              </div>
            ) : past.length === 0 ? (
              <p className="px-5 pt-2 pb-5 text-body-m text-text-secondary">끝난 상담이 아직 없어요.</p>
            ) : (
              <ul>
                {past.map((room) => {
                  // 걸린 시간은 고객과 연결됐다 끝난 상담만 (통계의 상담당 평균과 같은 기준)
                  const connected = room.status === "ended" && connectedIds.has(room.id);
                  const d = connected ? durationSec(room) : null;
                  const chip = statusOf(room, connected || (endedReadFailed && room.status === "ended"));
                  const label = labels.get(room.id);
                  // 이름표가 없으면 시작~끝 시각으로 — 전화 앱 최근 기록·문자 앱 검색과 맞춰 보게
                  const when = formatKstRange(new Date(room.created_at), room.ended_at ? new Date(room.ended_at) : null, now);
                  const took = d !== null ? `${formatDuration(d)} 걸림` : "기록 없음";
                  return (
                    <li key={room.id}>
                      {/* 피그마 SessionRow: 받는 분 이름표가 있으면 그 이름(ROOM-16), 없으면 시작~끝 시각으로 구분한다 */}
                      <Link href={`/room/${room.id}`} className="flex items-center gap-3 px-5 py-3 active:bg-bg-subtle">
                        <span className="flex min-w-0 flex-1 flex-col">
                          {/* 서버(Vercel)는 UTC라서 한국 시간으로 고정해 보여 준다 (BUG-06) */}
                          <span className="truncate text-label-l" data-testid={label ? "room-label" : undefined}>
                            {label ?? when}
                          </span>
                          <span className="truncate text-body-s text-text-secondary">{label ? `${when} · ${took}` : took}</span>
                        </span>
                        <StatusChip tone="ended">{chip}</StatusChip>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <BottomCta bg="muted">
          <form action={createRoom}>
            <NewRoomButton />
          </form>
        </BottomCta>
      </main>
    </div>
  );
}

// 목록에 보이는 상담의 받는 분 이름표 (ROOM-16): 상담 id → 이름. 자기 것만 읽힌다(RLS).
// 칸이 아직 없거나(DB 준비 전) 읽지 못하면 빈 채로 — 목록은 예전처럼 시각으로 보인다
async function recipientLabels(supabase: Awaited<ReturnType<typeof createClient>>, roomIds: string[]) {
  const out = new Map<string, string>();
  if (roomIds.length === 0) return out;
  const { data: links, error } = await supabase.from("rooms").select("id, recipient_id").in("id", roomIds);
  const pairs = ((error ? [] : links) ?? []) as { id: string; recipient_id: string | null }[];
  const ids = [...new Set(pairs.map((p) => p.recipient_id).filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  const { data: rs } = await supabase.from("recipients").select("id, label").in("id", ids);
  const byId = new Map(((rs ?? []) as { id: string; label: string }[]).map((r) => [r.id, r.label]));
  for (const p of pairs) {
    const label = p.recipient_id && byId.get(p.recipient_id);
    if (label) out.set(p.id, label);
  }
  return out;
}
