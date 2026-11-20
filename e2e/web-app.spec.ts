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

test("앱 연결 파일: 로그인 없이 넘김 없이 열리고, 플레이 앱 패키지와 지문이 있다 (OPS-08)", async ({ request }) => {
  const res = await request.get("/.well-known/assetlinks.json", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  const links = (await res.json()) as { relation: string[]; target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
  const app = links.find((l) => l.target.package_name === "com.bwadrim.app");
  expect(app?.relation).toContain("delegate_permission/common.handle_all_urls");
  for (const fp of app!.target.sha256_cert_fingerprints) expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test("앱처럼: 글자는 선택되지 않고 입력칸·처리방침은 선택된다 · 번역 제안 없음 (NFR-12)", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("translate", "no");
  // 안드로이드 크롬은 translate="no"만으로는 번역 제안을 계속 띄운다 — 구글이 읽는 메타가 있어야 한다
  await expect(page.locator('head meta[name="google"]')).toHaveAttribute("content", "notranslate");
  const style = (sel: string) =>
    page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { select: cs.userSelect || cs.webkitUserSelect, touch: cs.touchAction };
    });
  expect((await style("body")).select).toBe("none");
  expect((await style("body")).touch).toBe("manipulation");
  // 당겨서 새로고침: 안드로이드 크롬은 html에만 주면 그대로 새로고침한다(2026-11-20 앱 안 크롬 133) — body에도
  expect(await page.locator("html").evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe("none");
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe("none");

  await page.getByTestId("email-login-open").click();
  expect((await style('input[name="email"]')).select).toBe("text");

  await page.goto("/privacy");
  expect((await style("main")).select).toBe("text");
});

test("앱처럼: 링크·글자를 꾹 눌러도 크롬 메뉴가 뜨지 않고, 입력칸·복사할 글에서는 뜬다 (NFR-12)", async ({ page }) => {
  await page.goto("/login");
  // 크롬은 꾹 누르면 contextmenu를 보내고, 막히지 않으면 '새 탭에서 열기'·'링크 다운로드' 메뉴를 띄운다
  const menuBlocked = (sel: string) =>
    page.locator(sel).first().evaluate((el) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await menuBlocked("a")).toBe(true);
  expect(await menuBlocked("h1")).toBe(true);
  await page.getByTestId("email-login-open").click();
  expect(await menuBlocked('input[name="email"]')).toBe(false);

  await page.goto("/privacy");
  expect(await menuBlocked("main p")).toBe(false);
});

test("앱처럼: 상담 목록에서 들어가면 오른쪽에서, 돌아오면 왼쪽에서 밀려 들어온다 (NFR-12)", async ({ browser, baseURL }) => {
  const { ctx, page } = await engineerPage(browser, baseURL!, PHONE);
  try {
    await page.goto("/dashboard");
    // 넘김 효과: 들어가는 링크는 nav-forward, 돌아오는 링크는 nav-back으로 넘긴다
    const types: string[][] = [];
    await page.exposeFunction("__vt", (t: string[]) => types.push(t));
    await page.evaluate(() => {
      const orig = document.startViewTransition?.bind(document);
      if (!orig) return;
      document.startViewTransition = ((arg: StartViewTransitionOptions | ViewTransitionUpdateCallback) => {
        const t = typeof arg === "object" && arg && "types" in arg ? [...(arg.types ?? [])] : [];
        (window as unknown as { __vt: (t: string[]) => void }).__vt(t);
        return orig(arg as StartViewTransitionOptions);
      }) as typeof document.startViewTransition;
    });
    await page.getByRole("link", { name: "통계" }).click();
    await expect(page).toHaveURL(/\/stats$/);
    await expect(page.getByText(/최근 30일 · 상담/)).toBeVisible();
    await page.getByRole("link", { name: "상담 목록" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect.poll(() => types.flat()).toEqual(expect.arrayContaining(["nav-forward", "nav-back"]));
  } finally {
    await ctx.close();
  }
});
