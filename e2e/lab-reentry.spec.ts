import { expect, test } from "@playwright/test";
import {
  CLIPS,
  custState,
  fakeCamera,
  labData,
  loadGt,
  openLoopback,
  pinErrors,
  pauseCustomerWhen,
  recordCustomerTransitions,
  resumeCustomer,
  summarize,
  waitEngFrame,
} from "./helpers";

// /lab/track 루프백: 고객 화면(내 카메라) ↔ 엔지니어 화면(WebRTC 수신)이 한 페이지 안의 RTCPeerConnection 쌍과
// 실제 DataChannel로 연결된다. 운영 통화 화면 컴포넌트·세션 클래스 그대로. 가짜 카메라 = 정답이 있는 합성 영상.
// 오차는 작업 해상도(긴 변 320) px, 화면 위치는 CSS px.

// 핀이 화면 밖으로 나갔다 돌아오는 영상
test.use({ launchOptions: fakeCamera(CLIPS.reentry), viewport: { width: 860, height: 960 }, deviceScaleFactor: 2 });
const gt = loadGt(CLIPS.reentry);

test("놓치면 사진 카드 → 다시 비추면 핀으로 복귀", async ({ page }) => {
  await openLoopback(page);
  await recordCustomerTransitions(page);
  // 핀이 보이는 앞부분(0~0.4초)에서 탭
  const tap = await waitEngFrame(page, gt, (f) => f.i >= 2 && f.i <= 12);
  await page.mouse.click(tap.x, tap.y);
  await expect.poll(async () => (await custState(page)).state, { timeout: 15_000 }).toBe("tracking");

  // 영상이 핀을 화면 밖으로 → 못 찾는 순간 고객 미리보기를 멈춰 고정 → 0.8초 뒤 사진 카드
  await pauseCustomerWhen(page, "lost");
  const card = page.getByTestId("cust-card");
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card).toContainText("기사님이 표시한 곳을");
  await expect(card).toContainText("비춰주세요");
  await expect(page.getByTestId("cust-status")).toHaveCount(0); // 한 화면에 한 가지
  // 카드 사진: 기준 JPEG (작업 해상도 2배) + 주석 캔버스에 빨간 핀
  const img = card.locator("img");
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(300);
  const cardRed = await card.locator("canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 150 && d[i] > 200 && d[i + 1] < 110 && d[i + 2] < 110) n++;
    return n;
  });
  expect(cardRed).toBeGreaterThan(40);
  // 엔지니어: 고객이 놓쳤다는 칩 + "고객이 보는 카드" 미리보기
  await expect(page.getByTestId("eng-chip")).toHaveText(/고객 화면에서 (놓침|찾는 중…)/, { timeout: 5_000 });
  await expect(page.getByTestId("eng-card-preview")).toBeVisible();

  // 다시 비추면(영상 재생 → 핀이 돌아옴) 카드가 사라지고 다시 핀
  await resumeCustomer(page);
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await custState(page)).state, { timeout: 10_000 }).toBe("tracking");
  await expect(page.getByTestId("eng-chip")).toHaveText(/고객 화면에 표시 중|고객 화면 밖 — 화살표 안내 중/, { timeout: 5_000 });

  const trans = await page.evaluate(() => (window as unknown as { __trans: { t: number; k: string }[] }).__trans);
  console.log(trans.map((x) => `${(x.t / 1000).toFixed(2)} ${x.k}`).join("\n"));
  const d = await labData(page);
  const rows = pinErrors(gt, d, "cust", d.engAnchor!, d.refs[0].idx!);
  const s = summarize(rows);
  console.log(JSON.stringify({ cust: s }));
  // 틀린 곳을 가리키는 것은 거의 없어야 한다 (화면 밖 핀을 그리지 않음)
  expect(s.wrong).toBeLessThanOrEqual(Math.max(2, Math.floor(s.shown * 0.03)));
});
