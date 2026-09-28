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
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(12px,env(safe-area-inset-top))]">
      <header className="flex h-12 items-center">
        <Link href="/" aria-label="봐드림 첫 화면">
          <Brand />
        </Link>
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
