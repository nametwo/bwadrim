import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "로그인 — 봐드림",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-8 px-6 py-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">봐드림</h1>
        <p className="text-gray-600">엔지니어 로그인</p>
      </div>

      <LoginForm next={typeof next === "string" ? next : ""} />

      <p className="text-sm text-gray-400">
        계정은 관리자가 발급합니다. 문의: 사장님께 직접.
      </p>
    </main>
  );
}
