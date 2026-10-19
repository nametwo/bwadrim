import type { Metadata } from "next";
import { BusinessFooter } from "@/components/business-footer";
import { Brand } from "@/components/ui/brand";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "로그인 | 봐드림",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const { next, error, deleted } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(12px,env(safe-area-inset-top))]">
      {/* 사이트 주소(/)가 곧 이 화면이라(AUTH-01) 로고는 누르는 곳이 아니다 */}
      <header className="flex h-12 items-center">
        <Brand />
      </header>

      <LoginForm next={typeof next === "string" ? next : ""} kakaoFailed={error === "kakao"} deleted={deleted === "1"} />
      {/* '로그인'은 화면 아래에 붙어 있고, 사업자 정보는 내려야 보인다 */}
      <BusinessFooter />
    </main>
  );
}
