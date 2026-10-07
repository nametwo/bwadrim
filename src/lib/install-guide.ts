import { detectInApp } from "./in-app-browser";

// 엔지니어 홈 화면 앱 설치 안내 (NFR-09). 웹에서는 설치를 대신 눌러 줄 수 없어서(아이폰은 설치 창도 못 띄움)
// 기기·브라우저마다 누를 곳을 글로 알려 준다. 안드로이드 크롬이 설치 창을 띄울 수 있게 되면 화면은 버튼 하나로 바뀐다.

// samsung = 갤럭시 삼성 인터넷. 앱으로 설치시키지 않고 홈 화면 바로가기로만 둔다 (BUG-24)
export type InstallPlatform = "android" | "samsung" | "ios";

export type InstallStep = {
  icon: "more-vertical" | "more" | "share" | "menu" | "add-home" | "check";
  text: string;
  sub?: string;
};

/** 삼성 인터넷인지 (BUG-24). 삼성 인터넷은 홈 화면 앱을 자기가 만든 APK로 설치하는데, 2026년 들어 Play 프로텍트가
 *  이 APK를 'Android 이전 버전에 맞게 개발된 앱'이라며 '안전하지 않은 앱 차단됨'으로 막는다. 우리 쪽 설정으로는 그 APK를 고칠 수 없다 */
export function isSamsungInternet(ua: string): boolean {
  return /SamsungBrowser\//.test(ua);
}

/** 엔지니어 화면에 붙일 웹 앱 설정. 삼성 인터넷에는 앱으로 설치되지 않는 설정(display: browser)을 준다 (BUG-24).
 *  설정을 아예 빼면 안 된다: 크로미움은 설정이 없어도 /dashboard 같은 최상위 주소를 앱으로 설치해 준다(설정이 browser면 안 함) */
export function manifestHref(ua: string): string {
  return isSamsungInternet(ua) ? "/manifest-samsung.webmanifest" : "/manifest.webmanifest";
}

/** 홈 화면 바로가기로 열었다는 표시 (삼성 인터넷). 바로가기가 이 주소를 담게 해서, 아이콘으로 열면 설치 화면을 다시 띄우지 않는다 */
export const HOME_SCREEN_URL = "/dashboard?from=home";
export const isFromHomeScreen = (search: string) => new URLSearchParams(search).get("from") === "home";

/** 설치 안내를 띄울 폰인지. PC·앱 안 브라우저(카톡 등, AUTH-09가 먼저 인터넷 앱으로 넘김)는 null */
export function installPlatform(ua: string, maxTouchPoints = 0): InstallPlatform | null {
  if (detectInApp(ua)) return null;
  // iPadOS 13+ 사파리는 맥처럼 보인다 — 맥인데 터치가 되면 아이패드
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return isSamsungInternet(ua) ? "samsung" : "android";
  return null;
}

/** 브라우저 메뉴로 직접 홈 화면에 추가하는 세 단계 (아이폰은 늘, 안드로이드는 설치 창을 못 띄울 때) */
export function installSteps(ua: string, platform: InstallPlatform, maxTouchPoints = 0): InstallStep[] {
  if (platform === "ios") {
    // 아이패드는 공유 버튼이 아래가 아니라 위쪽 도구 막대에 있다
    const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
    // 아이폰의 크롬·엣지·파이어폭스 등은 공유 버튼이 주소창 옆에 있다
    const safari = !/CriOS|FxiOS|EdgiOS|OPiOS|Whale|NAVER/i.test(ua);
    // iOS 26 사파리 기본 모양(Compact)은 공유 버튼이 ⋯ 메뉴 안에 들어갔다. 예전 모양을 고른 폰도 있어 둘 다 말한다
    const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
    const first: InstallStep = ipad
      ? { icon: "share", text: "위쪽 공유 버튼을 눌러요", sub: "안 보이면 ⋯ 버튼 안에 있어요" }
      : !safari
      ? { icon: "share", text: "주소창 옆 공유 버튼을 눌러요" }
      : version >= 26
        ? { icon: "more", text: "아래 ⋯ 버튼을 누르고 '공유'를 눌러요", sub: "공유 버튼이 바로 보이면 그걸 눌러요" }
        : { icon: "share", text: "아래 공유 버튼을 눌러요" };
    return [
      first,
      { icon: "add-home", text: "'홈 화면에 추가'를 눌러요", sub: "안 보이면 아래로 내려 보세요" },
      { icon: "check", text: "오른쪽 위 '추가'를 눌러요" },
    ];
  }
  if (platform === "samsung") {
    // 앱 설치는 뜨지 않고(웹 앱 설정이 display: browser) '홈 화면'은 바로가기를 만든다
    return [
      { icon: "menu", text: "아래 메뉴 버튼을 눌러요" },
      { icon: "add-home", text: "'현재 페이지 추가'를 눌러요", sub: "'홈 화면에 추가'로 보이는 폰도 있어요" },
      { icon: "check", text: "'홈 화면'을 고르고 '추가'를 눌러요" },
    ];
  }
  return [
    { icon: "more-vertical", text: "오른쪽 위 ⋮ 버튼을 눌러요" },
    { icon: "add-home", text: "'앱 설치'나 '홈 화면에 추가'를 눌러요" },
    { icon: "check", text: "'설치'를 눌러요" },
  ];
}
