import { expect, test } from "@playwright/test";

// 개인정보 처리방침 (NFR-10)과 로그인 화면 아래 사업자 정보 (AUTH-02):
//  - 로그인하지 않아도 /privacy가 열린다 (플레이 심사·고객이 볼 수 있게)
//  - 로그인 화면 맨 아래 '개인정보 처리방침'을 누르면 여기로 온다
//  - 엔지니어 화면이 아니라 홈 화면 앱 설정(manifest)이 붙지 않는다

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
});
