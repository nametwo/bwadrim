import { expect, test, type Browser, type BrowserContextOptions } from "@playwright/test";
import { engineerCookie } from "./helpers";

// 엔지니어 화면의 웹 앱 설정 (OPS-08, BUG-24). 홈 화면에 추가하라고 권하는 화면은 없다(NFR-09 폐기):
//  - 앱 설정(manifest)은 엔지니어 화면에만 붙고 고객 링크(/join)에는 없다 → 고객 폰에 '앱 설치'가 뜨지 않는다.
//    플레이 스토어 앱(TWA)이 이 설정에서 이름·아이콘·색을 가져간다
//  - 크롬이 스스로 띄우는 '앱 설치' 띠는 막는다
//  - 삼성 인터넷은 앱으로 설치되지 않는 설정(display: browser), 서비스 워커 없음. 예전 서비스 워커는 지운다
//  - 로그인 화면을 거쳐도 주소 뒤 조건이 남는다 (AUTH-04, BUG-33)

const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 16; SM-S931N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36",
};

async function engineerPage(browser: Browser, baseURL: string, opts: BrowserContextOptions = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([engineerCookie(baseURL)]);
  return { ctx, page: await ctx.newPage() };
}

const swCount = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

test("앱 설정은 엔지니어 화면에만 붙고, 크롬의 '앱 설치' 띠는 막는다", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.android });
  try {
    await page.goto("/dashboard");
    await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "봐드림");
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "봐드림", start_url: "/dashboard", display: "standalone" });
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of manifest.icons as { src: string }[]) expect((await page.request.get(icon.src)).ok()).toBe(true);

    // 크롬이 '설치할 수 있어요'를 보내면 기본 동작(작은 설치 띠)을 막는다
    const prevented = await page.evaluate(() => {
      const e = new Event("beforeinstallprompt", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);

    // 고객 링크(형식이 틀린 링크 화면): 앱 설정 없음
    await page.goto("/join/not-a-token");
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("삼성 인터넷: 앱으로 설치되지 않는 설정 · 서비스 워커 없음 (BUG-24)", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.samsung });
  try {
    await page.goto("/dashboard");
    // 크로미움은 설정이 없어도 최상위 주소를 앱으로 설치해 주므로 빼지 않고 browser로 준다
    await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute("href", "/manifest-samsung.webmanifest");
    const manifest = await (await page.request.get("/manifest-samsung.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "봐드림", display: "browser", start_url: "/dashboard" });
    expect(await swCount(page)).toBe(0);
  } finally {
    await ctx.close();
  }
});

test("예전 서비스 워커: 엔지니어 화면을 열면 /sw.js 등록만 지운다 (BUG-24)", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.samsung });
  // 2026-10-07 전 배포가 남긴 등록이 있는 폰처럼. 브라우저는 서비스 워커 스크립트 요청을 테스트가 가로채게 두지 않아 등록 목록을 흉내 낸다
  await ctx.addInitScript(() => {
    const w = window as unknown as { __swUnregistered: string[] };
    w.__swUnregistered = [];
    const reg = (path: string) => ({
      active: { scriptURL: location.origin + path },
      waiting: null,
      installing: null,
      unregister: async () => {
        w.__swUnregistered.push(path);
        return true;
      },
    });
    Object.defineProperty(navigator.serviceWorker, "getRegistrations", { value: async () => [reg("/sw.js"), reg("/other-sw.js")] });
  });
  try {
    await page.goto("/dashboard");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __swUnregistered: string[] }).__swUnregistered))
      .toEqual(["/sw.js"]);
  } finally {
    await ctx.close();
  }
});

test("예전 서비스 워커: 브라우저가 이번 /sw.js를 받으면 스스로 지운다 (BUG-24)", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.samsung });
  try {
    // 엔지니어 화면 밖(화면의 정리 스크립트가 돌지 않는 곳)에서 등록해 본다
    await page.goto("/join/not-a-token");
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.register("/sw.js", { scope: "/" })).scope);
    expect(scope).toMatch(/\/$/);
    await expect.poll(() => swCount(page), { timeout: 10_000 }).toBe(0);
  } finally {
    await ctx.close();
  }
});

test("로그아웃된 채 조건이 붙은 주소를 열면 로그인 뒤 그 조건 그대로 돌아온다 (AUTH-04, BUG-33)", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext(PHONE);
  try {
    const page = await ctx.newPage();
    await page.goto("/stats?period=7");
    await expect(page).toHaveURL(/\/login\?next=%2Fstats%3Fperiod%3D7$/);
    const next = await page.locator('input[type="hidden"][name="next"]').inputValue();
    expect(next).toBe("/stats?period=7");

    // 가짜 Supabase는 비밀번호 로그인을 하지 않는다. 로그인이 남기는 세션 쿠키를 넣고,
    // 로그인 액션처럼 폼의 next(쿼리 포함)로 간다
    await ctx.addCookies([engineerCookie(baseURL!)]);
    await page.goto(next);
    await expect(page).toHaveURL(/\/stats\?period=7$/);
    await expect(page.getByText(/최근 7일 · 상담/)).toBeVisible();
  } finally {
    await ctx.close();
  }
});
