import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/ui/brand";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "로그인 — 봐드림",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col px-5 pt-[max(16px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <header className="py-2">
        <Link href="/" aria-label="봐드림 첫 화면">
          <Brand />
        </Link>
      </header>

      <div className="flex flex-1 flex-col justify-center gap-8 py-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-title-l text-text-primary">엔지니어 로그인</h1>
          <p className="text-body-m text-text-secondary">원격 A/S를 하려면 로그인해 주세요.</p>
        </div>

        <LoginForm next={typeof next === "string" ? next : ""} />
      </div>

      <p className="text-center text-body-s text-text-secondary">
        계정은 관리자에게 받으세요. 고객님은 로그인하지 않아도 돼요.
      </p>
    </main>
  );
}
