import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ShareButtons } from "./share-buttons";
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
    .select("id, code, status, created_at, expires_at")
    .eq("id", id)
    .single();

  if (!room) notFound();

  const expired = new Date(room.expires_at) < new Date();

  // 종료됐거나, 종료 처리 없이 24시간이 지나 고객 링크가 막힌 세션
  if (room.status === "ended" || expired) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col gap-6 px-6 py-8">
        <header className="flex items-center gap-3">
          <Link href="/dashboard" className="text-2xl text-gray-400">
            ←
          </Link>
          <h1 className="text-xl font-bold">원격 A/S</h1>
        </header>
        <p className="py-16 text-center text-gray-400">
          {room.status === "ended"
            ? "종료된 세션입니다."
            : "만료된 세션입니다. 만든 지 24시간이 지나 고객 링크가 더 이상 열리지 않아요."}
          <br />
          새 세션은 대시보드에서 시작하세요.
        </p>
      </main>
    );
  }

  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const joinUrl = `${proto}://${host}/join/${room.code}`;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col gap-6 px-6 py-8">
      <header className="flex items-center gap-3">
        <Link href="/dashboard" className="text-2xl text-gray-400">
          ←
        </Link>
        <h1 className="text-xl font-bold">원격 A/S</h1>
      </header>

      <section className="flex flex-col items-center gap-2 rounded-2xl bg-gray-50 py-8">
        <p className="text-sm text-gray-500">접속 코드</p>
        <p className="font-mono text-4xl font-bold tracking-[0.3em]">
          {room.code}
        </p>
        <p className="mt-2 break-all px-6 text-center text-sm text-gray-400">
          {joinUrl}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <p className="text-sm font-medium text-gray-500">
          고객님께 링크를 보내세요
        </p>
        <ShareButtons joinUrl={joinUrl} />
      </section>

      <CallPanel
        roomId={room.id}
        code={room.code}
        everConnected={room.status === "active"}
      />
    </main>
  );
}
