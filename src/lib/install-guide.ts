import { detectInApp } from "./in-app-browser";

// 엔지니어 홈 화면 앱 설치 안내 (NFR-09). 웹에서는 설치를 대신 눌러 줄 수 없어서(아이폰은 설치 창도 못 띄움)
// 기기·브라우저마다 누를 곳을 글로 알려 준다. 안드로이드 크롬이 설치 창을 띄울 수 있게 되면 화면은 버튼 하나로 바뀐다.

export type InstallPlatform = "android" | "ios";

export type InstallStep = {
  icon: "more-vertical" | "more" | "share" | "menu" | "add-home" | "check";
  text: string;
  sub?: string;
};

/** 설치 안내를 띄울 폰인지. PC·앱 안 브라우저(카톡 등, AUTH-09가 먼저 인터넷 앱으로 넘김)는 null */
export function installPlatform(ua: string, maxTouchPoints = 0): InstallPlatform | null {
  if (detectInApp(ua)) return null;
  // iPadOS 13+ 사파리는 맥처럼 보인다 — 맥인데 터치가 되면 아이패드
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
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
  if (/SamsungBrowser/.test(ua)) {
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
