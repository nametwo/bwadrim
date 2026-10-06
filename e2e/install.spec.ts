import { expect, test, type Browser, type BrowserContextOptions } from "@playwright/test";
import { engineerCookie } from "./helpers";
import { fireInstallPrompt } from "./screens/browser-hooks";

// 엔지니어 홈 화면 앱 설치 유도 (NFR-09):
//  - 폰 브라우저로 상담 목록을 열면 설치 화면이 먼저 뜬다. 안드로이드는 크롬이 설치 창을 띄울 수 있으면 '봐드림 앱 설치' 버튼 하나,
//    아직이면 메뉴로 설치하는 세 단계. 아이폰은 늘 세 단계(사파리 26부터는 ⋯ 메뉴 안의 공유)
//  - '다음에 할게요'면 이 창(탭)을 닫을 때까지 다시 묻지 않는다. 다른 화면에 갔다 와도
//  - 홈 화면 아이콘으로 연 앱(standalone)·PC에는 뜨지 않는다
//  - 앱 설정(manifest)은 엔지니어 화면에만 붙고 고객 링크(/join)에는 없다 → 고객 폰에 '앱 설치'가 뜨지 않는다

const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  iphone26:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
};

async function engineerPage(browser: Browser, baseURL: string, opts: BrowserContextOptions & { standalone?: boolean } = {}) {
  const { standalone, ...ctxOpts } = opts;
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addCookies([engineerCookie(baseURL)]);
  if (standalone) {
    // 홈 화면 아이콘으로 연 앱처럼: display-mode가 standalone
    await ctx.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q.includes("display-mode: standalone") ? ({ ...real(q), matches: true, media: q } as MediaQueryList) : real(q);
    });
  }
  return { ctx, page: await ctx.newPage() };
}

test("안드로이드: 메뉴 세 단계 → 설치 창 준비되면 버튼 하나 → 설치했어요 → 이 창에서는 다시 안 뜬다", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.android });
  try {
    await page.goto("/dashboard");
    const prompt = page.getByTestId("install-prompt");
    await expect(prompt).toHaveAttribute("data-mode", "steps", { timeout: 15_000 });
    await expect(prompt).toHaveAttribute("data-platform", "android");
    await expect(prompt).toContainText("봐드림을홈 화면에 두세요");
    await expect(prompt).toContainText("다음부터 아이콘만 누르면 바로 열려요");
    await expect(page.getByTestId("install-steps")).toContainText("오른쪽 위 ⋮ 버튼을 눌러요");
    await expect(page.getByTestId("install-button")).toHaveCount(0);

    // 크롬이 '설치할 수 있어요'를 보내면 버튼 하나로
    await fireInstallPrompt(page, "accepted");
    await expect(prompt).toHaveAttribute("data-mode", "button");
    await expect(page.getByTestId("install-steps")).toHaveCount(0);
    await page.getByTestId("install-button").click();
    await expect(prompt).toHaveAttribute("data-mode", "done");
    await expect(prompt).toContainText("다음부터 홈 화면의 봐드림 아이콘을 눌러 주세요");
    expect(await page.evaluate(() => (window as unknown as { __installPrompted?: number }).__installPrompted)).toBe(1);

    await page.getByTestId("install-close").click();
    await expect(prompt).toHaveCount(0);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("install-prompt")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("안드로이드: 크롬이 페이지가 뜨자마자 신호를 보내도(리액트가 뜨기 전) 버튼 하나로 뜬다", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.android });
  // 크롬처럼 문서를 다 읽자마자 보낸다 — 화면 코드(useEffect)가 붙기 전
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt(): Promise<void>; userChoice: Promise<unknown> };
      e.prompt = async () => {};
      e.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
      window.dispatchEvent(e);
      (window as unknown as { __firedPrevented?: boolean }).__firedPrevented = e.defaultPrevented;
    });
  });
  try {
    await page.goto("/dashboard");
    await expect(page.getByTestId("install-prompt")).toHaveAttribute("data-mode", "button", { timeout: 15_000 });
    // 크롬 자체 설치 띠는 막았다
    expect(await page.evaluate(() => (window as unknown as { __firedPrevented?: boolean }).__firedPrevented)).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("안드로이드: 설치 창에서 취소하면 메뉴 세 단계로 돌아간다", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.android });
  try {
    await page.goto("/dashboard");
    const prompt = page.getByTestId("install-prompt");
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    await fireInstallPrompt(page, "dismissed");
    await page.getByTestId("install-button").click();
    await expect(prompt).toHaveAttribute("data-mode", "steps");
  } finally {
    await ctx.close();
  }
});

test("아이폰: 세 단계와 다시 로그인 안내 · '다음에 할게요'면 다른 화면에 갔다 와도 안 뜬다", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.iphone26 });
  try {
    await page.goto("/dashboard");
    const prompt = page.getByTestId("install-prompt");
    await expect(prompt).toHaveAttribute("data-platform", "ios", { timeout: 15_000 });
    await expect(prompt).toHaveAttribute("data-mode", "steps");
    const steps = page.getByTestId("install-steps").locator("li");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("아래 ⋯ 버튼을 누르고 '공유'를 눌러요");
    await expect(steps.nth(1)).toContainText("'홈 화면에 추가'를 눌러요");
    await expect(steps.nth(2)).toContainText("오른쪽 위 '추가'를 눌러요");
    await expect(prompt).toContainText("아이폰은 홈 화면 아이콘으로 처음 열 때 한 번만 다시 로그인해요.");
    await expect(page.getByTestId("install-finished")).toHaveText("다 했어요");

    await page.getByTestId("install-later").click();
    await expect(prompt).toHaveCount(0);
    await page.goto("/stats");
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("install-prompt")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("홈 화면 아이콘으로 연 앱·PC에는 안 뜨고, 앱 설정은 엔지니어 화면에만 붙는다", async ({ browser, baseURL }) => {
  const app = await engineerPage(browser, baseURL!, { ...PHONE, userAgent: UA.android, standalone: true });
  const pc = await engineerPage(browser, baseURL!, { viewport: { width: 1280, height: 800 } });
  try {
    for (const { page } of [app, pc]) {
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      await expect(page.getByTestId("install-prompt")).toHaveCount(0);
    }

    // 엔지니어 화면: manifest와 아이폰 홈 화면 앱 표시
    const page = pc.page;
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "봐드림");
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "봐드림", start_url: "/dashboard", display: "standalone" });
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of manifest.icons as { src: string }[]) expect((await page.request.get(icon.src)).ok()).toBe(true);

    // 고객 링크(형식이 틀린 링크 화면): 앱 설정 없음
    await page.goto("/join/not-a-token");
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  } finally {
    await app.ctx.close();
    await pc.ctx.close();
  }
});
