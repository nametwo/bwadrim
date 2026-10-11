import { describe, expect, it } from "vitest";
import { detectInApp, detectWebView, externalOpenUrl, IN_APP_LABEL } from "./in-app-browser";

const UA = {
  // 이름을 모르는 앱의 안드로이드 웹뷰: '; wv)'가 붙는다
  androidWebView:
    "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  // 이름을 모르는 앱의 아이폰 웹뷰(WKWebView): 'Safari/'가 없다
  iosWebView: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
  kakaoIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0",
  kakaoAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36;KAKAOTALK 2410610",
  // 아이패드 사파리(맥처럼 보임)·PC
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  pc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
};

describe("detectWebView (JOIN-10)", () => {
  it("이름을 모르는 앱의 웹뷰를 알아본다", () => {
    expect(detectWebView(UA.androidWebView)).toBe(true);
    expect(detectWebView(UA.iosWebView)).toBe(true);
  });

  it("인터넷 앱은 웹뷰가 아니다", () => {
    expect(detectWebView(UA.androidChrome)).toBe(false);
    expect(detectWebView(UA.samsung)).toBe(false);
    expect(detectWebView(UA.iosSafari)).toBe(false);
    expect(detectWebView(UA.iosChrome)).toBe(false);
    expect(detectWebView(UA.ipad)).toBe(false);
    expect(detectWebView(UA.pc)).toBe(false);
  });

  it("이름을 아는 앱(카카오톡 등)은 detectInApp이 맡는다", () => {
    expect(detectWebView(UA.kakaoIos)).toBe(false);
    expect(detectWebView(UA.kakaoAndroid)).toBe(false);
    expect(detectInApp(UA.kakaoIos)).toBe("kakaotalk");
    expect(detectInApp(UA.kakaoAndroid)).toBe("kakaotalk");
  });

  it("detectInApp은 웹뷰를 모른다 (엔지니어 화면 AUTH-09·설치 안내는 그대로)", () => {
    expect(detectInApp(UA.androidWebView)).toBeNull();
    expect(detectInApp(UA.iosWebView)).toBeNull();
  });

  it("웹뷰는 자동으로 넘길 주소가 없고 '이 앱'이라 부른다", () => {
    expect(externalOpenUrl("webview", "https://example.com/join/x")).toBeNull();
    expect(IN_APP_LABEL.webview).toBe("이 앱");
  });
});
