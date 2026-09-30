import { headers } from "next/headers";
import { detectInApp, IN_APP_LABEL } from "@/lib/in-app-browser";
import { OpenInBrowser } from "@/components/open-in-browser";

// 엔지니어 화면(로그인·대시보드·상담·통계)도 메신저 앱 안 브라우저면 인터넷 앱으로 넘긴다 (AUTH-09).
// 앱 안에서는 마이크가 잘 안 켜지고(CALL-01), 로그인도 인터넷 앱과 따로라 거기서 다시 해야 한다
export default async function EngineerLayout({ children }: LayoutProps<"/">) {
  const inApp = detectInApp((await headers()).get("user-agent") ?? "");
  if (!inApp) return children;

  return (
    <OpenInBrowser
      kind={inApp}
      testId="eng-in-app"
      title={
        <>
          크롬이나 사파리에서
          <br />
          열어 주세요
        </>
      }
      body={
        <>
          {IN_APP_LABEL[inApp]} 안에서는
          <br />
          마이크가 잘 안 켜져요.
        </>
      }
    >
      {children}
    </OpenInBrowser>
  );
}
