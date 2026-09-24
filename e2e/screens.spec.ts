import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  CLIPS,
  ROOT,
  custState,
  engState,
  fakeCamera,
  loadGt,
  openLoopback,
  pauseCustomerWhen,
  resumeCustomer,
  waitEngFrame,
} from "./helpers";

// 화면 확인용 스크린숏 (폰 크기 390x844 패널 = 운영 통화 화면 컴포넌트 그대로). test-results/screens/*.png
// 상태가 잠깐만 유지되는 장면(화살표·카드)은 그 순간 고객 미리보기 <video>를 멈춰 고정한 뒤 찍는다
// (새 프레임이 없으면 추적 상태도 그대로다). 찍고 나면 다시 재생.

test.use({ launchOptions: fakeCamera(CLIPS.reentry), viewport: { width: 860, height: 960 }, deviceScaleFactor: 2 });
const gt = loadGt(CLIPS.reentry);
const OUT = path.join(ROOT, "test-results", "screens");

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

async function shoot(page: Page, name: string) {
  await page.getByTestId("pane-cust").screenshot({ path: path.join(OUT, `customer-${name}.png`) });
  await page.getByTestId("pane-eng").screenshot({ path: path.join(OUT, `engineer-${name}.png`) });
}

test("스크린숏: 안내 · 핀 · 화면 밖 화살표 · 사진 카드", async ({ page }) => {
  test.setTimeout(90_000);
  await openLoopback(page);
  await shoot(page, "0-before-tap");

  const tap = await waitEngFrame(page, gt, (f) => f.i >= 2 && f.i <= 10);
  await page.mouse.click(tap.x, tap.y);
  await expect.poll(async () => (await custState(page)).state, { timeout: 15_000 }).toBe("tracking");

  // 핀 (고객 화면 가운데쯤에서 멈춤)
  await pauseCustomerWhen(page, "pin-center");
  await expect.poll(async () => (await engState(page)).customerState, { timeout: 5_000 }).toBe("tracking");
  await page.waitForTimeout(400);
  await shoot(page, "1-pin");
  await resumeCustomer(page);

  // 화면 밖 화살표
  await pauseCustomerWhen(page, "arrow");
  await expect(page.getByTestId("cust-arrow-text")).toBeVisible();
  await expect(page.getByTestId("eng-chip")).toHaveText("고객 화면 밖 — 화살표 안내 중", { timeout: 5_000 });
  await page.waitForTimeout(300);
  await shoot(page, "2-arrow");
  await resumeCustomer(page);

  // 사진 카드 (못 찾은 채 0.8초)
  await pauseCustomerWhen(page, "lost");
  await expect(page.getByTestId("cust-card")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("eng-card-preview")).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await shoot(page, "3-card");
  await resumeCustomer(page);
});

test("스크린숏: 무늬 없는 면 → 엔지니어 토스트 · 고객 카드", async ({ page }) => {
  await openLoopback(page, "&synthetic=blank");
  const box = (await page.getByTestId("eng-video").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await expect(page.getByTestId("eng-toast")).toHaveText("무늬가 적어 고정이 어려워요 — 고객에게 사진 카드로 보여줘요", {
    timeout: 10_000,
  });
  expect((await engState(page)).trackable).toBe(false);
  await expect(page.getByTestId("cust-card")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("eng-card-preview")).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, "4-untrackable");
  // 토스트는 잠시 뒤 사라진다
  await expect(page.getByTestId("eng-toast")).toHaveCount(0, { timeout: 8_000 });
});
