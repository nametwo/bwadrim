import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatDuration, formatKstDateTime } from "@/lib/format";
import { endedConnected } from "@/lib/metrics";
import { BottomCta } from "@/components/ui/bottom-cta";
import { buttonClass } from "@/components/ui/button";
import { CheckIcon, ChevronLeftIcon, ClockIcon } from "@/components/ui/icons";
import { NewRoomButton } from "../../dashboard/new-room-button";
import { createRoom } from "../../dashboard/actions";
import { kakaoShareArgs } from "@/lib/kakao-webhook";
import { CallPanel } from "./call-panel";
import { RecipientCard } from "./recipient-card";

export const metadata: Metadata = {
  title: "원격 A/S | 봐드림",
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
  // 제목은 지금 상태 하나('상담이 끝났어요'). 시각·걸린 시간은 아래 카드에
  if (room.status === "ended" || expired) {
    const ended = room.status === "ended";
    // 고객과 연결됐었는지 (metrics.endedConnected). 예전 상담은 방에 남은 해결 여부로, 그 밖에는 'ended' 기록으로.
    // 기록을 못 읽었으면(null) 모르는 것이라 '연결 없이 닫은 상담'으로 단정하지 않고 '상담이 끝났어요'로 둔다
    let connected: boolean | null = ended && endedConnected(null, room.resolved_remotely);
    if (ended && !connected) {
      const { data: endedEvents, error } = await supabase
        .from("events")
        .select("props")
        .eq("room_id", room.id)
        .eq("name", "ended");
      connected = error
        ? null
        : ((endedEvents ?? []) as { props: Record<string, unknown> | null }[]).some((e) => endedConnected(e.props));
    }
    const result = !ended
      ? { key: "expired", title: "만료된 상담이에요", icon: <ClockIcon />, tint: "bg-bg-muted text-icon-secondary" }
      : connected === false
        ? { key: "not-connected", title: "연결 없이 닫은 상담이에요", icon: <ClockIcon />, tint: "bg-bg-muted text-icon-secondary" }
        : { key: "ended", title: "상담이 끝났어요", icon: <CheckIcon />, tint: "bg-success-tint text-text-success" };
    // 받는 분 이름표 (ROOM-16). 이름이 없으면 여기서 붙인다. 칸이 없거나(DB 준비 전) 못 읽으면 안 보인다
    let recipient: { label: string | null; auto: boolean } | null = null;
    const { data: sentTo, error: sentToError } = await supabase
      .from("rooms")
      .select("kakao_hash, recipient_id")
      .eq("id", room.id)
      .maybeSingle();
    if (!sentToError && sentTo) {
      recipient = { label: null, auto: !!sentTo.kakao_hash };
      if (sentTo.recipient_id) {
        const { data: r, error: labelError } = await supabase.from("recipients").select("label").eq("id", sentTo.recipient_id).maybeSingle();
        recipient = labelError ? null : { ...recipient, label: r?.label ?? null };
      }
    }

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

        <section data-testid="room-closed" data-state={result.key} className="flex flex-col gap-2 pt-3">
          <div className={`mb-5 grid size-14 place-items-center rounded-full [&>svg]:size-7 ${result.tint}`}>{result.icon}</div>
          <h1 className="text-title-l">{result.title}</h1>
          <p className="text-body-m text-text-secondary">
            {ended ? "고객님께 보낸 링크는 이제 안 열려요" : "만든 지 24시간이 지나서 링크가 닫혔어요"}
          </p>
        </section>

        {recipient && (
          <div className="mt-8">
            <RecipientCard roomId={room.id} label={recipient.label} auto={recipient.auto} />
          </div>
        )}

        <dl className={`${recipient ? "mt-3" : "mt-8"} flex flex-col gap-3 rounded-3xl bg-bg-subtle px-5 py-4`}>
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
      kakaoArgs={kakaoShareArgs(room.id, process.env.KAKAO_ADMIN_KEY)}
    />
  );
}
