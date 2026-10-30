import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { iosBrowserApp, isIOSDevice, isSamsungInternet, manifestHref } from "./browser-kind";

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
  iosFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15",
  iosEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/129.0.2792.84 Mobile/15E148 Safari/605.1.15",
  iosOpera:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/5.0.0 Version/18.0 Mobile/15E148 Safari/604.1",
  iosWhale:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Whale/3.10.2.1 Mobile/15E148 Safari/604.1",
  iosNaver:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.6.3)",
};

describe("isIOSDevice (JOIN-05)", () => {
  it("아이폰·아이패드, 맥처럼 보여도 터치가 되면 아이패드", () => {
    expect(isIOSDevice(UA.safari17)).toBe(true);
    expect(isIOSDevice(UA.iosChrome)).toBe(true);
    expect(isIOSDevice(UA.ipad, 5)).toBe(true);
  });

  it("터치가 안 되는 맥과 안드로이드는 아니다", () => {
    expect(isIOSDevice(UA.ipad, 0)).toBe(false);
    expect(isIOSDevice(UA.ipad)).toBe(false);
    expect(isIOSDevice(UA.mac, 0)).toBe(false);
    expect(isIOSDevice(UA.chrome, 5)).toBe(false);
  });
});

describe("iosBrowserApp (JOIN-05)", () => {
  it("사파리면 null", () => {
    expect(iosBrowserApp(UA.safari17)).toBeNull();
    expect(iosBrowserApp(UA.safari26)).toBeNull();
    expect(iosBrowserApp(UA.ipad)).toBeNull();
  });

  it("사파리가 아니면 설정 앱에 보이는 앱 이름", () => {
    expect(iosBrowserApp(UA.iosChrome)).toBe("Chrome");
    expect(iosBrowserApp(UA.iosFirefox)).toBe("Firefox");
    expect(iosBrowserApp(UA.iosEdge)).toBe("Edge");
    expect(iosBrowserApp(UA.iosOpera)).toBe("Opera");
    expect(iosBrowserApp(UA.iosWhale)).toBe("Whale");
    expect(iosBrowserApp(UA.iosNaver)).toBe("NAVER");
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
    expect(samsung.start_url).toBe("/dashboard");
    expect(manifest("manifest.webmanifest").display).toBe("standalone");
  });
});
