import { expect, test } from "@playwright/test";
import { FIXTURE, SUPABASE_URL, engineerCookie } from "./helpers";

// 회원 (AUTH-10·AUTH-11)과 한 달 상담 한도 (ROOM-17):
//  - 로그인 화면은 '카카오로 시작하기' 하나. 이메일 로그인은 아래 '이메일로 로그인'으로 연다
//  - 카카오 동의 화면에서 돌아오면(/auth/callback) 로그인 쿠키를 받고 원래 가려던 화면으로. 코드가 틀리면 로그인 화면에 안내
//  - 내 계정에 '이번 달 상담 N / 30건', 한도를 다 쓰면 대시보드 '새 A/S 시작' 대신 안내. 화면을 열어 둔 사이 다 써도 DB가 막는다
//  - 내 계정 → 회원 탈퇴 → 확인 창 → 계정 삭제(서비스 키) → 로그인 화면 '탈퇴했어요'
// 가짜 Supabase는 같은 사용자를 모든 테스트가 같이 쓴다. 탈퇴는 지우지 않고 기록만 하고, 한도는 테스트가 끝나면 되돌린다

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function setRoomLimit(limit: number | null) {
  await fetch(`${SUPABASE_URL}/__faults`, { method: "POST", body: JSON.stringify({ roomLimit: limit }) });
}

test("로그인 화면: 카카오 하나, 이메일 로그인은 열어야 보인다", async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  try {
    const page = await ctx.newPage();
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/카카오 계정으로\s*시작해 주세요/);
    await expect(page.getByTestId("kakao-login")).toHaveText("카카오로 시작하기");
    await expect(page.getByLabel("이메일")).toHaveCount(0);

    await page.getByTestId("email-login-open").click();
    await expect(page.getByLabel("이메일")).toBeVisible();
    await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
    await expect(page.getByText("이메일 계정은 관리자에게 받아 주세요.")).toBeVisible();
    await page.getByRole("button", { name: "카카오로 시작하기" }).click();
    await expect(page.getByTestId("kakao-login")).toBeVisible();

    await page.goto("/login?error=kakao");
    // (Next의 화면 바뀜 알림도 role=alert라 글로 찾는다)
    await expect(page.getByText("카카오 로그인을 마치지 못했어요. 다시 눌러 주세요.")).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("카카오로 시작하기 → 카카오 동의 → 돌아오면 원래 가려던 화면 (AUTH-10)", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext(PHONE);
  try {
    const page = await ctx.newPage();
    // 카카오 동의 화면 대신: Supabase가 카카오로 넘기는 주소를 가로채 바로 돌아온다
    let authorize: URL | null = null;
    await page.route(`${SUPABASE_URL}/auth/v1/authorize**`, async (route) => {
      authorize = new URL(route.request().url());
      const back = new URL(authorize.searchParams.get("redirect_to")!);
      back.searchParams.set("code", "e2e-kakao-code");
      await route.fulfill({ status: 302, headers: { location: back.toString() } });
    });

    await page.goto("/stats?period=7");
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByTestId("kakao-login").click();
    await expect(page).toHaveURL(/\/stats\?period=7$/, { timeout: 20_000 });
    await expect(page.getByText(/최근 7일 · 상담/)).toBeVisible();

    expect(authorize!.searchParams.get("provider")).toBe("kakao");
    expect(authorize!.searchParams.get("code_challenge")).toBeTruthy();
    const redirect = new URL(authorize!.searchParams.get("redirect_to")!);
    expect(redirect.origin).toBe(new URL(baseURL!).origin);
    expect(redirect.pathname).toBe("/auth/callback");
    expect(redirect.searchParams.get("next")).toBe("/stats?period=7");

    // 틀린 코드·코드 없음 → 로그인 화면 안내
    const fresh = await browser.newContext(PHONE);
    const p2 = await fresh.newPage();
    await p2.goto("/auth/callback?code=wrong");
    await expect(p2).toHaveURL(/\/login\?error=kakao$/);
    await expect(p2.getByText("카카오 로그인을 마치지 못했어요. 다시 눌러 주세요.")).toBeVisible();
    await p2.goto("/auth/callback?next=%2F%2Fevil.example");
    await expect(p2).toHaveURL(/\/login\?error=kakao$/);
    await fresh.close();
  } finally {
    await ctx.close();
  }
});

test("한 달 상담 한도: N / 30건, 다 쓰면 안내, 그사이 다 써도 DB가 막는다 (ROOM-17)", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext(PHONE);
  await ctx.addCookies([engineerCookie(baseURL!)]);
  try {
    const page = await ctx.newPage();
    // 이번 달 상담 수와 한도는 내 계정에 있다 (대시보드의 이번 달 카드는 2026-10-21에 뺐다)
    await page.goto("/account");
    const usage = await page.getByTestId("account-info").textContent();
    const used = Number(usage!.match(/(\d+) \/ 30건/)![1]);
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: /새 A\/S 시작/ })).toBeVisible();

    // 화면을 열어 둔 사이 한도에 닿음 → 눌러도 상담이 생기지 않고 안내
    await setRoomLimit(used);
    await page.getByRole("button", { name: /새 A\/S 시작/ }).click();
    await expect(page.getByTestId("room-limit")).toContainText(`이번 달 상담 ${used}건을 다 썼어요`, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("button", { name: /새 A\/S 시작/ })).toHaveCount(0);
    await expect(page.getByText("contact@bwadrim.com")).toBeVisible();

    await page.goto("/account");
    await expect(page.getByTestId("account-info")).toContainText(`${used} / ${used}건`);
  } finally {
    await setRoomLimit(null);
    await ctx.close();
  }
});

test("내 계정 → 회원 탈퇴 → 확인 → 로그인 화면 '탈퇴했어요' (AUTH-11)", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext(PHONE);
  await ctx.addCookies([engineerCookie(baseURL!)]);
  try {
    const page = await ctx.newPage();
    await page.goto("/dashboard");
    await page.getByTestId("account-link").click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("김도현님 계정");
    await expect(page.getByTestId("account-info")).toContainText("engineer@e2e.test");
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();

    await page.getByTestId("delete-open").click();
    const sheet = page.getByTestId("delete-sheet");
    await expect(sheet).toContainText("탈퇴할까요?");
    await sheet.getByRole("button", { name: "취소" }).click();
    await expect(sheet).toHaveCount(0);

    await page.getByTestId("delete-open").click();
    await page.waitForTimeout(700); // 확인 창을 연 직후의 두 번째 탭 보호(armMs)
    await page.getByTestId("delete-confirm").click();
    await expect(page).toHaveURL(/\/login\?deleted=1$/, { timeout: 20_000 });
    await expect(page.getByTestId("account-deleted")).toContainText("탈퇴했어요");
    const deleted = (await (await fetch(`${SUPABASE_URL}/__deleted-users`)).json()) as string[];
    expect(deleted).toContain(FIXTURE.user.id);
  } finally {
    await ctx.close();
  }
});

test("로그인하지 않고 내 계정을 열면 로그인 화면으로 (AUTH-04)", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
});
