import type { Metadata } from "next";
import { Brand } from "@/components/ui/brand";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "로그인 | 봐드림",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(12px,env(safe-area-inset-top))]">
      {/* 사이트 주소(/)가 곧 이 화면이라(AUTH-01) 로고는 누르는 곳이 아니다 */}
      <header className="flex h-12 items-center">
        <Brand />
      </header>

      <h1 className="pt-8 pb-8 text-title-l text-text-primary">
        엔지니어 계정으로
        <br />
        로그인해 주세요
      </h1>

      <LoginForm next={typeof next === "string" ? next : ""} />
    </main>
  );
}
