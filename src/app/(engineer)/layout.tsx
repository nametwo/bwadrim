import type { Metadata } from "next";
import { headers } from "next/headers";
import { detectInApp, IN_APP_LABEL } from "@/lib/in-app-browser";
import { OpenInBrowser } from "@/components/open-in-browser";
import { InstallCatcher } from "@/components/install-prompt";

// 엔지니어 화면만 홈 화면 앱으로 설치된다 (NFR-09). 고객 링크(/join)에는 앱 설정을 걸지 않아
// 고객 폰에 '앱 설치' 안내가 뜨지 않는다
// 크롬은 페이지를 불러오자마자 '설치할 수 있어요'(beforeinstallprompt)를 한 번만 보낸다. 리액트가 뜨기 전에 받아 두려고
// HTML에 바로 실행되는 짧은 스크립트를 둔다. 화면(install-prompt.tsx)이 뜨면 여기 담아 둔 것을 가져간다
const CATCH_INSTALL = `(function(w){if(w.__bwInstallHooked)return;w.__bwInstallHooked=1;w.addEventListener('beforeinstallprompt',function(e){e.preventDefault();w.__bwInstall=e;});w.addEventListener('appinstalled',function(){w.__bwInstalled=1;w.__bwInstall=null;});})(window);`;

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "봐드림", statusBarStyle: "default" },
};

// 엔지니어 화면(로그인·대시보드·상담·통계)도 메신저 앱 안 브라우저면 인터넷 앱으로 넘긴다 (AUTH-09).
// 앱 안에서는 마이크가 잘 안 켜지고(CALL-01), 로그인도 인터넷 앱과 따로라 거기서 다시 해야 한다
export default async function EngineerLayout({ children }: LayoutProps<"/">) {
  const inApp = detectInApp((await headers()).get("user-agent") ?? "");
  if (!inApp) {
    return (
      <>
        <script dangerouslySetInnerHTML={{ __html: CATCH_INSTALL }} />
        <InstallCatcher />
        {children}
      </>
    );
  }

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
