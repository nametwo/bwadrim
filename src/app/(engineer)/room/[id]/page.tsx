import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatDuration, formatKstDateTime } from "@/lib/format";
import { BottomCta } from "@/components/ui/bottom-cta";
import { buttonClass } from "@/components/ui/button";
import { CarIcon, CheckIcon, ChevronLeftIcon, ClockIcon } from "@/components/ui/icons";
import { NewRoomButton } from "../../dashboard/new-room-button";
import { createRoom } from "../../dashboard/actions";
import { CallPanel } from "./call-panel";

export const metadata: Metadata = {
  title: "원격 A/S — 봐드림",
};

export default async function RoomPage({ params }: PageProps<"/room/[id]">) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS가 자기 방만 돌려준다
  const { data: room } = await supabase
    .from("rooms")
    .select("id, join_token, status, resolved_remotely, created_at, expires_at, ended_at")
    .eq("id", id)
    .single();

  if (!room) notFound();

  const expired = new Date(room.expires_at) < new Date();
  const createdAt = new Date(room.created_at);

  // 종료됐거나, 종료 처리 없이 24시간이 지나 고객 링크가 막힌 세션 (ROOM-11).
  // 제목이 곧 결과다('출장 없이 해결했어요'). 시각·걸린 시간은 아래 카드에
  if (room.status === "ended" || expired) {
    const ended = room.status === "ended";
    const result = !ended
      ? { title: "만료된 상담이에요", icon: <ClockIcon />, tint: "bg-bg-muted text-icon-secondary" }
      : room.resolved_remotely === true
        ? { title: "출장 없이 해결했어요", icon: <CheckIcon />, tint: "bg-success-tint text-text-success" }
        : room.resolved_remotely === false
          ? { title: "방문이 필요했어요", icon: <CarIcon />, tint: "bg-danger-tint text-text-danger" }
          : { title: "연결 없이 닫은 상담이에요", icon: <ClockIcon />, tint: "bg-bg-muted text-icon-secondary" };
    const rows: [string, string][] = [["시작", formatKstDateTime(createdAt)]];
    if (ended && room.ended_at) {
      rows.push(["끝", formatKstDateTime(new Date(room.ended_at))]);
      rows.push([
        "걸린 시간",
        formatDuration((new Date(room.ended_at).getTime() - createdAt.getTime()) / 1000),
      ]);
    }

    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]">
        <header className="flex min-h-14 items-center">
          <Link
            href="/dashboard"
            className="-ml-2 flex h-touch items-center gap-0.5 rounded-xl pr-3 pl-1 text-label-m text-text-secondary active:bg-bg-muted"
          >
            <ChevronLeftIcon className="size-6" />
            상담 목록
          </Link>
        </header>

        <section className="flex flex-col gap-2 pt-3">
          <div className={`mb-5 grid size-14 place-items-center rounded-full [&>svg]:size-7 ${result.tint}`}>{result.icon}</div>
          <h1 className="text-title-l">{result.title}</h1>
          <p className="text-body-m text-text-secondary">
            {ended ? "고객님께 보낸 링크는 더 이상 열리지 않아요" : "만든 지 24시간이 지나 링크가 더 이상 열리지 않아요"}
          </p>
        </section>

        <dl className="mt-8 flex flex-col gap-3 rounded-3xl bg-bg-subtle px-5 py-4">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <dt className="text-body-m text-text-secondary">{k}</dt>
              <dd className="text-label-l text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>

        <BottomCta>
          <form action={createRoom}>
            <NewRoomButton />
          </form>
          <Link href="/dashboard" className={buttonClass({ variant: "ghost", size: "m", block: true })}>
            상담 목록으로
          </Link>
        </BottomCta>
      </main>
    );
  }

  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const joinUrl = `${proto}://${host}/join/${room.join_token}`;

  return (
    <CallPanel
      roomId={room.id}
      joinToken={room.join_token}
      joinUrl={joinUrl}
      createdLabel={formatKstDateTime(createdAt)}
      everConnected={room.status === "active"}
    />
  );
}
