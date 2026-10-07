import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOME_SCREEN_URL, installPlatform, installSteps, isFromHomeScreen, isSamsungInternet, manifestHref } from "./install-guide";

const manifest = (name: string) => JSON.parse(readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8"));

const UA = {
  chrome: "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  safari17:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // OS 버전 칸은 믿지 않고 사파리 버전(Version/)으로 가린다
  safari26:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  kakao:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0",
};

describe("installPlatform (NFR-09)", () => {
  it("폰과 아이패드만 안내한다", () => {
    expect(installPlatform(UA.chrome)).toBe("android");
    expect(installPlatform(UA.samsung)).toBe("samsung");
    expect(installPlatform(UA.safari17)).toBe("ios");
    expect(installPlatform(UA.iosChrome)).toBe("ios");
    expect(installPlatform(UA.ipad, 5)).toBe("ios");
  });

  it("PC와 앱 안 브라우저는 안내하지 않는다", () => {
    expect(installPlatform(UA.mac)).toBeNull();
    expect(installPlatform(UA.ipad, 0)).toBeNull();
    expect(installPlatform(UA.kakao)).toBeNull();
  });
});

describe("삼성 인터넷은 앱으로 설치시키지 않는다 (BUG-24)", () => {
  it("삼성 인터넷만 가린다", () => {
    expect(isSamsungInternet(UA.samsung)).toBe(true);
    expect(isSamsungInternet(UA.chrome)).toBe(false);
    expect(isSamsungInternet(UA.safari26)).toBe(false);
  });

  it("삼성 인터넷에는 바로가기용 웹 앱 설정, 그 밖에는 앱 설정", () => {
    expect(manifestHref(UA.samsung)).toBe("/manifest-samsung.webmanifest");
    expect(manifestHref(UA.chrome)).toBe("/manifest.webmanifest");
    expect(manifestHref(UA.safari26)).toBe("/manifest.webmanifest");
    expect(manifestHref(UA.mac)).toBe("/manifest.webmanifest");
  });

  it("삼성용 설정은 앱 설치 조건을 일부러 못 채운다: display가 browser면 크로미움도 삼성도 앱으로 만들지 않는다", () => {
    const samsung = manifest("manifest-samsung.webmanifest");
    expect(samsung.display).toBe("browser");
    expect(samsung.display_override).toBeUndefined();
    // 바로가기는 이 주소로 열린다 → 설치 화면을 다시 띄우지 않는다
    expect(samsung.start_url).toBe(HOME_SCREEN_URL);
    expect(manifest("manifest.webmanifest").display).toBe("standalone");
  });

  it("홈 화면 바로가기로 열었는지는 from=home으로 안다", () => {
    expect(isFromHomeScreen("?from=home")).toBe(true);
    expect(isFromHomeScreen("?x=1&from=home")).toBe(true);
    expect(isFromHomeScreen("")).toBe(false);
    expect(isFromHomeScreen("?from=kakao")).toBe(false);
  });
});

describe("installSteps (NFR-09)", () => {
  const texts = (ua: string, p: "android" | "samsung" | "ios") => installSteps(ua, p).map((s) => s.text);

  it("아이폰 사파리 26부터는 ⋯ 메뉴 안의 공유, 그 전은 아래 공유 버튼", () => {
    expect(texts(UA.safari26, "ios")[0]).toBe("아래 ⋯ 버튼을 누르고 '공유'를 눌러요");
    expect(texts(UA.safari17, "ios")[0]).toBe("아래 공유 버튼을 눌러요");
    expect(texts(UA.iosChrome, "ios")[0]).toBe("주소창 옆 공유 버튼을 눌러요");
    expect(texts(UA.safari26, "ios").slice(1)).toEqual(["'홈 화면에 추가'를 눌러요", "오른쪽 위 '추가'를 눌러요"]);
  });

  it("아이패드는 위쪽 공유 버튼", () => {
    expect(installSteps(UA.ipad, "ios", 5)[0].text).toBe("위쪽 공유 버튼을 눌러요");
    expect(installSteps(UA.safari26, "ios", 5)[0].text).toBe("아래 ⋯ 버튼을 누르고 '공유'를 눌러요");
  });

  it("안드로이드 크롬은 ⋮ 메뉴, 삼성 인터넷은 아래 메뉴", () => {
    expect(texts(UA.chrome, "android")).toEqual(["오른쪽 위 ⋮ 버튼을 눌러요", "'앱 설치'나 '홈 화면에 추가'를 눌러요", "'설치'를 눌러요"]);
    expect(texts(UA.samsung, "samsung")).toEqual(["아래 메뉴 버튼을 눌러요", "'현재 페이지 추가'를 눌러요", "'홈 화면'을 고르고 '추가'를 눌러요"]);
  });

  it("늘 세 단계", () => {
    for (const [ua, p] of [[UA.chrome, "android"], [UA.samsung, "samsung"], [UA.safari17, "ios"], [UA.safari26, "ios"], [UA.iosChrome, "ios"]] as const) {
      expect(installSteps(ua, p)).toHaveLength(3);
    }
  });
});
