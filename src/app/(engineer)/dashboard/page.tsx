import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDuration, formatKstDateTime, kstMonthStartIso } from "@/lib/format";
import { Brand } from "@/components/ui/brand";
import { ChartIcon, ChevronRightIcon, LogoutIcon, MessageIcon } from "@/components/ui/icons";
import { logout } from "../login/actions";
import { createRoom } from "./actions";
import { NewRoomButton } from "./new-room-button";

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
function isOpen(room: Room, now: Date) {
  return room.status !== "ended" && new Date(room.expires_at) >= now;
}

// 끝난 상담의 결과 표시 (ROOM-04)
function resultOf(room: Room): { text: string; cls: string } {
  if (room.status !== "ended") return { text: "만료", cls: "bg-bg-muted text-text-secondary" };
  if (room.resolved_remotely === true) return { text: "원격 해결", cls: "bg-success-tint text-text-success" };
  if (room.resolved_remotely === false) return { text: "출장 필요", cls: "bg-warning-tint text-text-warning" };
  return { text: "연결 안 됨", cls: "bg-bg-muted text-text-secondary" };
}

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
    // 이번 달(한국 시간) 요약 — 원격 해결 건수가 영업 자료다
    supabase.from("rooms").select("resolved_remotely").gte("created_at", kstMonthStartIso()),
  ]);

  const now = new Date();
  const list = (rooms ?? []) as Room[];
  const open = list.filter((r) => isOpen(r, now));
  const past = list.filter((r) => !isOpen(r, now));
  const monthTotal = month?.length ?? 0;
  const monthResolved = month?.filter((r) => r.resolved_remotely === true).length ?? 0;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-5 pt-[max(8px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
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

      <section className="flex flex-col gap-2">
        <form action={createRoom}>
          <NewRoomButton />
        </form>
        <p className="text-center text-body-s text-text-secondary">누르면 고객님께 보낼 링크가 만들어져요</p>
      </section>

      <Link
        href="/stats"
        className="flex items-center gap-4 rounded-2xl bg-bg-subtle px-4 py-3.5 active:bg-bg-muted"
      >
        <div className="flex flex-1 flex-col">
          <span className="text-body-s text-text-secondary">이번 달</span>
          <span className="text-label-l text-text-primary">
            상담 {monthTotal}건 · 출장 없이 해결 <span className="text-text-success">{monthResolved}건</span>
          </span>
        </div>
        <ChevronRightIcon className="size-5 text-icon-secondary" />
      </Link>

      {open.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-title-s">진행 중인 상담</h2>
          <ul className="flex flex-col gap-2">
            {open.map((room) => {
              const waiting = room.status === "waiting";
              const hoursLeft = Math.max(
                1,
                Math.floor((new Date(room.expires_at).getTime() - now.getTime()) / 3_600_000),
              );
              return (
                <li key={room.id}>
                  <Link
                    href={`/room/${room.id}`}
                    className="flex items-center gap-3 rounded-2xl bg-bg-page px-4 py-4 shadow-card ring-1 ring-border active:bg-bg-subtle"
                  >
                    <span
                      aria-hidden="true"
                      className={`size-3 flex-none rounded-full ${waiting ? "bg-warning" : "bg-success"}`}
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-label-l text-text-primary">
                        {formatKstDateTime(new Date(room.created_at), now)}
                      </span>
                      <span className="text-body-s text-text-secondary">
                        {waiting
                          ? `대기 중 · 고객님이 아직 안 들어왔어요 · 링크 ${hoursLeft}시간 남음`
                          : "연결됨 · 해결 여부를 아직 안 골랐어요"}
                      </span>
                    </div>
                    <span className="flex flex-none items-center text-label-m text-text-brand">
                      이어하기
                      <ChevronRightIcon className="size-5" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-title-s">최근 상담</h2>
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-bg-subtle px-6 py-10 text-center">
            <span className="grid size-14 place-items-center rounded-full bg-bg-page text-icon-secondary">
              <MessageIcon className="size-7" />
            </span>
            <p className="text-label-l text-text-primary">아직 상담이 없어요</p>
            <p className="text-body-m text-text-secondary">
              위의 &lsquo;새 A/S 시작&rsquo;을 누르고
              <br />
              고객님께 문자로 링크를 보내 보세요.
            </p>
          </div>
        ) : past.length === 0 ? (
          <p className="py-6 text-center text-body-m text-text-secondary">끝난 상담이 아직 없어요.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {past.map((room) => {
              const result = resultOf(room);
              const duration =
                room.status === "ended" && room.ended_at && room.resolved_remotely !== null
                  ? formatDuration((new Date(room.ended_at).getTime() - new Date(room.created_at).getTime()) / 1000)
                  : null;
              return (
                <li key={room.id}>
                  <Link
                    href={`/room/${room.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3.5 active:bg-bg-subtle"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {/* 서버(Vercel)는 UTC라서 한국 시간으로 고정해 보여 준다 (BUG-06) */}
                      <span className="text-label-l text-text-primary">
                        {formatKstDateTime(new Date(room.created_at), now)}
                      </span>
                      <span className="flex items-center gap-2 text-body-s text-text-secondary">
                        <span className={`rounded-full px-2 py-0.5 text-label-s ${result.cls}`}>{result.text}</span>
                        {duration && <span>{duration}</span>}
                      </span>
                    </div>
                    <ChevronRightIcon className="size-5 flex-none text-icon-secondary" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
