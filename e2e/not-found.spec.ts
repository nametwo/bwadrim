import { expect, test } from "@playwright/test";
import { engineerCookie } from "./helpers";

// 없는 주소·남의 상담 화면 (AUTH-08, BUG-13). 누가 보는지에 따라 다르다:
//  - 로그인한 엔지니어: '상담 목록으로'
//  - 로그인하지 않은 사람(링크가 잘못 온 사장님 등): 버튼 없이 할 일만. 엔지니어 로그인 화면(/)으로 보내지 않는다
// 실험실(/lab/guide)은 운영에서만 숨기므로(CALL-15) 여기서는 열리는지만 본다

const FAKE_ROOM = "/room/e2e00000-0000-4000-8000-00000000ffff";

test("로그인한 엔지니어에게는 '상담 목록으로'", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await ctx.addCookies([engineerCookie(baseURL!)]);
  const page = await ctx.newPage();
  try {
    await page.goto(FAKE_ROOM);
    const screen = page.getByTestId("not-found");
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await expect(screen).toContainText("볼 수 없는 상담이에요");
    await expect(screen).not.toContainText("사장님");
    await page.getByTestId("not-found-dashboard").click();
    await expect(page).toHaveURL(/\/dashboard$/);
  } finally {
    await ctx.close();
  }
});

test("로그인하지 않은 사람에게는 버튼 없이 사장님 안내만", async ({ page }) => {
  await page.goto("/no-such-page");
  const screen = page.getByTestId("not-found");
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(screen).toContainText("문자나 카톡으로 받으신 링크를 다시 눌러 주세요");
  await expect(screen.getByRole("link")).toHaveCount(0);
  await expect(screen.getByRole("button")).toHaveCount(0);
});

test("실험실은 운영이 아닌 곳에서 열린다 (CALL-15)", async ({ page }) => {
  await page.goto("/lab/guide");
  await expect(page.getByRole("heading", { name: "방향 지시 실험실" })).toBeVisible({ timeout: 30_000 });
});
