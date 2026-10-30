import { expect, test } from "@playwright/test";
import { FIXTURE } from "./helpers";

// 개인정보 처리방침 (NFR-10)과 로그인 화면 아래 사업자 정보 (AUTH-02), 응답 보안 헤더 (NFR-11):
//  - 로그인하지 않아도 /privacy가 열린다 (플레이 심사·고객이 볼 수 있게)
//  - 로그인 화면 맨 아래 '개인정보 처리방침'을 누르면 여기로 온다
//  - 고객 시작 화면(JOIN-02) 맨 아래 작은 링크로도 온다. 처리방침의 로고는 누르는 곳이 아니다(엔지니어 로그인으로 보내지 않게)
//  - 엔지니어 화면이 아니라 홈 화면 앱 설정(manifest)이 붙지 않는다
//  - 모든 응답에 보안 헤더가 붙는다

test("로그인 화면 아래 처리방침 링크로 로그인 없이 처리방침을 연다", async ({ page }) => {
  await page.goto("/login");
  const footer = page.getByTestId("business-footer");
  await expect(footer).toContainText("에코정보통신");
  await expect(footer).toContainText("contact@bwadrim.com");
  // '카카오로 시작하기'는 그대로 있다 (AUTH-10)
  await expect(page.getByTestId("kakao-login")).toBeVisible();

  await footer.getByRole("link", { name: "개인정보 처리방침" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "개인정보 처리방침", level: 1 })).toBeVisible();
  await expect(page.getByText("이름과 전화번호는 받지 않아요.")).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  // 로고는 링크가 아니다 — 고객이 눌러 엔지니어 로그인 화면으로 가지 않게
  await expect(page.locator("header").getByRole("link")).toHaveCount(0);
});

test("고객 시작 화면 맨 아래 작은 링크로도 처리방침을 연다 (JOIN-02)", async ({ page }) => {
  await page.goto(`/join/${FIXTURE.rooms[0].join_token}`);
  await expect(page.getByRole("button", { name: /카메라 켜고 시작하기/ })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("join-privacy").click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "개인정보 처리방침", level: 1 })).toBeVisible();
});

test("모든 응답에 보안 헤더가 붙는다 (NFR-11)", async ({ request }) => {
  for (const path of ["/login", "/privacy", `/join/${FIXTURE.rooms[0].join_token}`, "/manifest.webmanifest"]) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
  }
});
