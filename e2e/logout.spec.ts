import { expect, test } from "@playwright/test";
import { SUPABASE_URL, engineerCookie } from "./helpers";

// 로그아웃은 이 기기만 (AUTH-06): 대시보드 '내 계정' → '로그아웃' → 로그인 화면으로 가고, Supabase에는 scope=local로 간다.
// 기본값(global)이면 같은 계정의 모든 기기가 함께 풀려, 사무실 PC에서 로그아웃했다고 통화 중인 폰까지 끊긴다

test("내 계정의 '로그아웃'은 이 기기만 풀고 로그인 화면으로 (AUTH-06)", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await ctx.addCookies([engineerCookie(baseURL!)]);
  const page = await ctx.newPage();
  try {
    await page.goto("/dashboard");
    await page.getByTestId("account-link").click();
    await expect(page).toHaveURL(/\/account$/);
    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

    const last = (await (await fetch(`${SUPABASE_URL}/__last-logout`)).json()) as { scope: string | null } | null;
    expect(last?.scope).toBe("local");

    // 이 브라우저의 로그인은 풀렸다
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  } finally {
    await ctx.close();
  }
});
