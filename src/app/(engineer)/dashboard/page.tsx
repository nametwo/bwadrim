import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "../login/actions";
import { createRoom } from "./actions";

export const metadata: Metadata = {
  title: "대시보드 — 봐드림",
};

const STATUS_LABEL: Record<string, string> = {
  waiting: "대기 중",
  active: "연결됨",
  ended: "종료",
  expired: "만료",
};

// 종료 처리 안 한 채 24시간이 지난 세션은 고객 링크가 막혔으므로 '만료'로 보여 준다 (DB 상태는 그대로)
function displayStatus(room: { status: string; expires_at: string }) {
  if (room.status !== "ended" && new Date(room.expires_at) < new Date()) {
    return "expired";
  }
  return room.status;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy가 1차로 막지만, 데이터 접근 지점에서 한 번 더 확인
  if (!user) redirect("/login");

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, code, status, resolved_remotely, created_at, expires_at")
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col gap-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">봐드림</h1>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-lg px-3 py-2 text-sm text-gray-500"
          >
            로그아웃
          </button>
        </form>
      </header>

      <form action={createRoom}>
        <button
          type="submit"
          className="h-16 w-full rounded-2xl bg-black text-xl font-semibold text-white active:opacity-80"
        >
          + 새 원격 A/S 시작
        </button>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-gray-500">최근 세션</h2>
        {!rooms?.length ? (
          <p className="py-8 text-center text-gray-400">
            아직 세션이 없습니다.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-gray-100">
            {rooms.map((room) => (
              <li key={room.id}>
                <Link
                  href={`/room/${room.id}`}
                  className="flex items-center justify-between py-4 active:bg-gray-50"
                >
                  <div className="flex flex-col">
                    <span className="font-mono text-lg font-semibold tracking-widest">
                      {room.code}
                    </span>
                    <span className="text-sm text-gray-400">
                      {/* 서버(Vercel)는 UTC라서 시간대를 지정하지 않으면 9시간 이르게 보인다 */}
                      {new Date(room.created_at).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {room.resolved_remotely && " · 원격 해결"}
                    </span>
                  </div>
                  {(() => {
                    const status = displayStatus(room);
                    return (
                      <span
                        className={`rounded-full px-3 py-1 text-sm ${
                          status === "active"
                            ? "bg-green-100 text-green-700"
                            : status === "waiting"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {STATUS_LABEL[status] ?? status}
                      </span>
                    );
                  })()}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
