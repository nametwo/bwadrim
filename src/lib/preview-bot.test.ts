import { describe, expect, it } from "vitest";
import { detectInApp } from "./in-app-browser";
import { isPreviewBot } from "./preview-bot";

// 미리보기 봇 (출처는 preview-bot.ts 주석)
const BOTS = {
  카카오톡: "kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984",
  카카오톡_겸용: "facebookexternalhit/1.1; kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984",
  아이메시지:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  구글메시지: "GoogleMessages/20.2 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  페이스북: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  라인: "facebookexternalhit/1.1;line-poker/1.0",
  왓츠앱: "WhatsApp/2.22.20.72 A",
  텔레그램: "TelegramBot (like TwitterBot)",
  슬랙: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  디스코드: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  스카이프: "Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com",
  구글검색: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  네이버검색: "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)",
};

// 사람이 쓰는 브라우저 — 앱 안 브라우저도 사람이다 (JOIN-10)
const PEOPLE = {
  안드로이드_크롬:
    "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  삼성인터넷:
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  아이폰_사파리:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  카톡_앱안:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0",
  카톡_앱안_안드로이드:
    "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36;KAKAOTALK 2610820",
  페이스북_앱안:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0]",
  라인_앱안:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0",
  네이버_앱안:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.6.3)",
  구글앱:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/330.0.661302523 Mobile/15E148 Safari/604.1",
  큐봇_폰: "Mozilla/5.0 (Linux; Android 12; CUBOT KINGKONG 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  PC_크롬:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
};

describe("isPreviewBot", () => {
  it.each(Object.entries(BOTS))("%s 미리보기·수집기는 봇", (_, ua) => {
    expect(isPreviewBot(ua)).toBe(true);
  });

  it.each(Object.entries(PEOPLE))("%s는 사람", (_, ua) => {
    expect(isPreviewBot(ua)).toBe(false);
  });

  it("User-Agent가 없으면 사람이 연 게 아니다", () => {
    expect(isPreviewBot("")).toBe(true);
    expect(isPreviewBot("   ")).toBe(true);
  });

  it("앱 안 브라우저로 알아보는 UA는 모두 사람이다", () => {
    for (const ua of [PEOPLE.카톡_앱안, PEOPLE.카톡_앱안_안드로이드, PEOPLE.페이스북_앱안, PEOPLE.라인_앱안, PEOPLE.네이버_앱안]) {
      expect(detectInApp(ua)).not.toBeNull();
      expect(isPreviewBot(ua)).toBe(false);
    }
  });
});
