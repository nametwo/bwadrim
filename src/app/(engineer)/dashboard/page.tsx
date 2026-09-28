import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDuration, formatKstDateTime, kstMonthStartIso } from "@/lib/format";
import { engineerNameOf } from "@/lib/engineer-name";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Brand } from "@/components/ui/brand";
import { ChartIcon, ChevronRightIcon, ClockIcon, LogoutIcon, MessageIcon, PencilIcon } from "@/components/ui/icons";
import { StatusChip, type ChipTone } from "@/components/ui/status-chip";
import { logout } from "../login/actions";
import { createRoom } from "./actions";
import { NewRoomButton } from "./new-room-button";
import { MicAheadLink } from "./mic-ahead-link";

export const metadata: Metadata = {
  title: "상담 목록 — 봐드림",
};

type Room = {
  id: string;
  status: string;
  resolved_remotely: boolean | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
};

// 종료 처리 안 한 채 24시간이 지난 세션은 고객 링크가 막혔으므로 '만료'로 본다 (DB 상태는 그대로)
function isOpen(room: { status: string; expires_at: string }, now: Date) {
  return room.status !== "ended" && new Date(room.expires_at) >= now;
}

// 끝난 상담의 결과 표시 (ROOM-04) — 피그마 StatusChip
function resultOf(room: Room): { text: string; tone: ChipTone } {
  if (room.status !== "ended") return { text: "만료", tone: "ended" };
  if (room.resolved_remotely === true) return { text: "원격 해결", tone: "resolved" };
  if (room.resolved_remotely === false) return { text: "방문 필요", tone: "visit" };
  return { text: "연결 안 됨", tone: "ended" };
}

function durationSec(room: { created_at: string; ended_at: string | null }) {
  return room.ended_at ? (new Date(room.ended_at).getTime() - new Date(room.created_at).getTime()) / 1000 : null;
}

// 대시보드 (피그마 E02). 회색 바탕에 흰 카드 세 장 — 이번 달(원격 해결률이 가장 큰 숫자, 영업 자료가 되는 핵심 지표),
// 진행 중(내가 이어서 할 일), 최근 상담. 파란 버튼은 '새 A/S 시작' 하나, 한 손으로 누르게 화면 아래에 붙인다.
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy가 1차로 막지만, 데이터 접근 지점에서 한 번 더 확인
  if (!user) redirect("/login");

  const [{ data: rooms }, { data: month }] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, status, resolved_remotely, created_at, expires_at, ended_at")
      .order("created_at", { ascending: false })
      .limit(20),
    // 이번 달(한국 시간) 요약
    supabase
      .from("rooms")
      .select("status, resolved_remotely, created_at, ended_at")
      .gte("created_at", kstMonthStartIso()),
  ]);

  const now = new Date();
  const name = engineerNameOf(user);
  const list = (rooms ?? []) as Room[];
  const open = list.filter((r) => isOpen(r, now));
  const past = list.filter((r) => !isOpen(r, now));

  // 원격 해결률 = 답한 상담 중 '네' 비율 (DATA-02와 같은 기준). 평균 시간도 답한 상담만
  const monthRooms = (month ?? []) as Pick<Room, "status" | "resolved_remotely" | "created_at" | "ended_at">[];
  const answered = monthRooms.filter((r) => r.status === "ended" && r.resolved_remotely !== null);
  const resolved = answered.filter((r) => r.resolved_remotely === true).length;
  const rate = answered.length ? Math.round((resolved / answered.length) * 100) : null;
  const durations = answered.map(durationSec).filter((d): d is number => d !== null);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

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
          {/* 이번 달: 원격 해결률 한 숫자를 가장 크게, 나머지는 아래 한 줄. 누르면 통계 (DATA-06) */}
          <Link
            href="/stats"
            aria-label="이번 달 통계 자세히 보기"
            className="flex flex-col rounded-3xl bg-bg-page p-5 transition-colors active:bg-bg-subtle"
          >
            <span className="flex items-center justify-between text-label-m text-text-secondary">
              이번 달 원격 해결률
              <ChevronRightIcon className="size-5 text-icon-secondary" />
            </span>
            <span className="mt-1 flex items-baseline gap-2">
              <span className="text-display-l text-text-primary">{rate === null ? "—" : `${rate}%`}</span>
              <span className={`text-label-m ${rate === null ? "text-text-secondary" : "text-text-success"}`}>
                {rate === null ? "아직 기록이 없어요" : `출장 ${resolved}건 줄였어요`}
              </span>
            </span>
            {rate !== null && (
              <span aria-hidden="true" className="mt-3 h-2 overflow-hidden rounded-full bg-bg-muted">
                <span className="block h-full rounded-full bg-success" style={{ width: `${rate}%` }} />
              </span>
            )}
            <span className="mt-4 grid grid-cols-2 border-t border-border pt-4">
              <MiniStat label="상담" value={`${monthRooms.length}건`} />
              <MiniStat label="평균 시간" value={avg === null ? "—" : formatDuration(avg)} />
            </span>
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
                          {waiting ? <ClockIcon className="size-[22px]" /> : <PencilIcon className="size-[22px]" />}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-label-l">{waiting ? "고객님 기다리는 중" : "결과 기록 전"}</span>
                          <span className="truncate text-body-s text-text-secondary">
                            {formatKstDateTime(new Date(room.created_at), now)}
                            {waiting && ` · 링크 ${hoursLeft}시간 남음`}
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
                <p className="text-body-m text-text-secondary">아래 &lsquo;새 A/S 시작&rsquo;으로 시작해 보세요</p>
              </div>
            ) : past.length === 0 ? (
              <p className="px-5 pt-2 pb-5 text-body-m text-text-secondary">끝난 상담이 아직 없어요.</p>
            ) : (
              <ul>
                {past.map((room) => {
                  const result = resultOf(room);
                  const d = room.status === "ended" && room.resolved_remotely !== null ? durationSec(room) : null;
                  return (
                    <li key={room.id}>
                      {/* 피그마 SessionRow: 고객 이름은 저장하지 않으므로(NFR-07) 시각으로 구분한다 */}
                      <Link href={`/room/${room.id}`} className="flex items-center gap-3 px-5 py-3 active:bg-bg-subtle">
                        <span className="flex min-w-0 flex-1 flex-col">
                          {/* 서버(Vercel)는 UTC라서 한국 시간으로 고정해 보여 준다 (BUG-06) */}
                          <span className="truncate text-label-l">{formatKstDateTime(new Date(room.created_at), now)}</span>
                          <span className="text-body-s text-text-secondary">
                            {d !== null ? `${formatDuration(d)} 걸림` : "기록 없음"}
                          </span>
                        </span>
                        <StatusChip tone={result.tone}>{result.text}</StatusChip>
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-body-s text-text-secondary">{label}</span>
      <span className="text-title-s text-text-primary">{value}</span>
    </span>
  );
}
