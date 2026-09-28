import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDuration, formatKstDateTime, kstMonthStartIso } from "@/lib/format";
import { engineerNameOf } from "@/lib/engineer-name";
import { Brand } from "@/components/ui/brand";
import { ChartIcon, ChevronRightIcon, LogoutIcon, MessageIcon, UserIcon } from "@/components/ui/icons";
import { StatCard } from "@/components/ui/stat-card";
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

// 대시보드 (피그마 E02): 파란 버튼은 '새 A/S 시작' 하나, 원격 해결률이 맨 위(영업 자료가 되는 핵심 지표)
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
    <div className="flex min-h-dvh flex-col bg-bg-subtle">
      <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pt-[max(8px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
        <header className="flex min-h-14 items-center justify-between">
          <Brand />
          <div className="-mr-2 flex items-center">
            <Link
              href="/stats"
              className="flex h-touch items-center gap-1.5 rounded-xl px-3 text-label-m text-text-secondary active:bg-bg-muted"
            >
              <ChartIcon className="size-5" />
              통계
            </Link>
            <form action={logout}>
              <button
                type="submit"
                className="flex h-touch items-center gap-1.5 rounded-xl px-3 text-label-m text-text-secondary active:bg-bg-muted"
              >
                <LogoutIcon className="size-5" />
                로그아웃
              </button>
            </form>
          </div>
        </header>

        {name && <h1 className="text-title-m">안녕하세요, {name}님</h1>}

        <form action={createRoom}>
          <NewRoomButton />
        </form>

        <Link href="/stats" aria-label="이번 달 통계 자세히 보기" className="grid grid-cols-2 gap-3">
          <StatCard
            label="이번 달 원격 해결률"
            value={rate === null ? "—" : `${rate}%`}
            sub={rate === null ? "아직 기록이 없어요" : `출장 ${resolved}건 줄였어요`}
            subTone={rate === null ? "secondary" : "success"}
          />
          <StatCard
            label="이번 달 상담"
            value={`${monthRooms.length}건`}
            sub={avg === null ? "평균 시간 —" : `평균 ${formatDuration(avg)}`}
          />
        </Link>

        {open.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-title-s">진행 중인 상담</h2>
            <ul className="flex flex-col gap-2">
              {open.map((room) => {
                const waiting = room.status === "waiting";
                const hoursLeft = Math.max(
                  1,
                  Math.floor((new Date(room.expires_at).getTime() - now.getTime()) / 3_600_000),
                );
                return (
                  <li key={room.id}>
                    <MicAheadLink
                      roomId={room.id}
                      href={`/room/${room.id}`}
                      className="flex items-center gap-3 rounded-xl bg-bg-page px-4 py-3 ring-1 ring-border active:bg-bg-muted"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-2">
                          <span className="text-label-l">{formatKstDateTime(new Date(room.created_at), now)}</span>
                          <StatusChip tone={waiting ? "waiting" : "call"}>{waiting ? "대기 중" : "기록 전"}</StatusChip>
                        </span>
                        <span className="text-body-s text-text-secondary">
                          {waiting
                            ? `고객님이 아직 안 들어왔어요 · 링크 ${hoursLeft}시간 남음`
                            : "통화했지만 결과를 아직 안 남겼어요"}
                        </span>
                      </div>
                      <span className="flex flex-none items-center text-label-m text-text-brand">
                        이어하기
                        <ChevronRightIcon className="size-5" />
                      </span>
                    </MicAheadLink>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="px-1 text-title-s">최근 상담</h2>
          {list.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl bg-bg-page px-6 py-10 text-center">
              <span className="grid size-14 place-items-center rounded-full bg-bg-muted text-icon-secondary">
                <MessageIcon className="size-7" />
              </span>
              <p className="text-label-l">아직 상담이 없어요</p>
              <p className="text-body-m text-text-secondary">
                위의 &lsquo;새 A/S 시작&rsquo;을 누르고
                <br />
                고객님께 문자로 링크를 보내 보세요.
              </p>
            </div>
          ) : past.length === 0 ? (
            <p className="rounded-2xl bg-bg-page py-6 text-center text-body-m text-text-secondary">끝난 상담이 아직 없어요.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {past.map((room) => {
                const result = resultOf(room);
                const d = room.status === "ended" && room.resolved_remotely !== null ? durationSec(room) : null;
                return (
                  <li key={room.id}>
                    {/* 피그마 SessionRow: 고객 이름은 저장하지 않으므로(NFR-07) 시각으로 구분한다 */}
                    <Link
                      href={`/room/${room.id}`}
                      className="flex items-center gap-3 rounded-xl bg-bg-page px-4 py-3 active:bg-bg-muted"
                    >
                      <span className="grid size-11 flex-none place-items-center rounded-full bg-bg-muted text-icon-secondary">
                        <UserIcon className="size-[22px]" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        {/* 서버(Vercel)는 UTC라서 한국 시간으로 고정해 보여 준다 (BUG-06) */}
                        <span className="truncate text-label-l">{formatKstDateTime(new Date(room.created_at), now)}</span>
                        <span className="text-body-s text-text-secondary">
                          {d !== null ? `${formatDuration(d)} 걸림` : result.tone === "ended" ? "기록 없음" : ""}
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
      </main>
    </div>
  );
}
