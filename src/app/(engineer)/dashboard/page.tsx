import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "../login/actions";

export const metadata: Metadata = {
  title: "대시보드 — 봐드림",
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy가 1차로 막지만, 데이터 접근 지점에서 한 번 더 확인
  if (!user) redirect("/login");

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

      <p className="text-sm text-gray-500">{user.email}</p>

      {/* 다음 단계: 방 생성 버튼 + 최근 방 목록 */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <p className="text-gray-400">
          방 생성 기능은 다음 단계에서 붙습니다.
        </p>
      </div>
    </main>
  );
}
