import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { engineerNameOf } from "@/lib/engineer-name";
import { readRoomQuota } from "@/lib/room-quota";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, LogoutIcon } from "@/components/ui/icons";
import { logout } from "../login/actions";
import { DeleteAccount } from "./delete-account";

export const metadata: Metadata = {
  title: "내 계정 | 봐드림",
};

// 내 계정 (AUTH-06·AUTH-11, ROOM-17). 대시보드 위쪽 '내 계정'으로 온다.
// 어떻게 로그인했는지, 이번 달 상담 수와 한도, 로그아웃, 회원 탈퇴
export default async function AccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/account");

  const quota = await readRoomQuota(supabase);
  const name = engineerNameOf(user);
  const kakao = user.app_metadata?.provider === "kakao" || !!user.identities?.some((i) => i.provider === "kakao");
  const rows: [string, string][] = [
    ["로그인", kakao ? "카카오" : (user.email ?? "이메일")],
    [
      "이번 달 상담",
      quota.used === null ? "—" : quota.limit === null ? `${quota.used}건` : `${quota.used} / ${quota.limit}건`,
    ],
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]">
      <header className="flex min-h-14 items-center">
        <Link
          href="/dashboard"
          className="-ml-2 flex h-touch items-center gap-0.5 rounded-xl pr-3 pl-1 text-label-m text-text-secondary active:bg-border"
        >
          <ChevronLeftIcon className="size-6" />
          상담 목록
        </Link>
      </header>

      <h1 className="pt-3 pb-5 text-title-l">{name ? `${name}님 계정` : "내 계정"}</h1>

      <dl className="flex flex-col gap-3 rounded-3xl bg-bg-subtle px-5 py-4" data-testid="account-info">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <dt className="text-body-m text-text-secondary">{k}</dt>
            <dd className="min-w-0 truncate text-label-l text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>

      <BottomCta>
        <form action={logout} className="flex flex-col">
          <Button type="submit" variant="secondary" size="xl" block icon={<LogoutIcon className="size-6" />}>
            로그아웃
          </Button>
        </form>
        <DeleteAccount />
      </BottomCta>
    </main>
  );
}
