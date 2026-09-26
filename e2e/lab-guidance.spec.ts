import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  CLIPS,
  ROOT,
  coverSyntheticCamera,
  custPinCss,
  custState,
  customerGuide,
  engNormToPage,
  engState,
  fakeCamera,
  openLoopback,
  recordCustomerGuide,
  redPixels,
} from "./helpers";

// 고객 안내 (/lab/track 루프백, 운영 통화 화면 컴포넌트 그대로):
//  1) 화면 밖 화살표 — 결정적인 장면: 엔지니어(contain, 프레임 전체가 보임)가 프레임 오른쪽 끝을 탭하면
//     고객 화면(cover, 390x844 패널이라 480x640 영상의 좌우 19%가 잘림)에서는 핀이 잘린 영역에 있다.
//     추적은 되는데(H) 핀이 안 보이는 상태 → 오른쪽 가장자리 화살표 + "화살표 쪽으로 폰을 돌려주세요".
//     (추적기의 화면 밖 추정 hint에 기대지 않으므로 흔들리지 않는다)
//  2) 반복 무늬 — 엔지니어 쪽은 즉시 고정(initialH)이라 붙지만 고객은 스스로 찾을 수 없다(ambiguous):
//     엔지니어 토스트, 고객은 0.8초 기다리지 않고 바로 사진 카드, 엔지니어가 놓치면 "다시 탭해 주세요".

test.use({ launchOptions: fakeCamera(CLIPS.jitter), viewport: { width: 860, height: 960 }, deviceScaleFactor: 2 });
const OUT = path.join(ROOT, "test-results", "screens");

test("화면 밖 화살표: 고객 화면(cover)에서 잘린 곳의 핀 → 가장자리 화살표 + 큰 글씨, 엔지니어 칩", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await openLoopback(page);
  await recordCustomerGuide(page);

  // 프레임 오른쪽 끝 (단말기 바코드 스티커 오른쪽, 무늬 있음). 고객 화면에서 보이는 x 범위는 약 0.19~0.81
  const tap = await engNormToPage(page, { x: 0.9, y: 0.58 });
  await page.mouse.click(tap.x, tap.y);
  await expect.poll(async () => (await engState(page)).trackable, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await custState(page)).state, { timeout: 15_000 }).toBe("tracking");

  // 고객: 추적 중인데 핀이 잘린 영역 → 화살표
  await expect.poll(async () => (await custState(page)).arrow, { timeout: 5_000 }).toBe(true);
  const arrowText = page.getByTestId("cust-arrow-text");
  await expect(arrowText).toBeVisible();
  await expect(arrowText).toHaveText("화살표 쪽으로폰을 돌려주세요");
  await expect(page.getByTestId("cust-card")).toHaveCount(0);
  await expect(page.getByTestId("eng-chip")).toHaveText("고객 화면 밖 — 화살표 안내 중", { timeout: 5_000 });

  // 핀은 정말 고객 화면 오른쪽 밖에 있고, 빨간 화살표는 오른쪽 가장자리에만 그려진다
  const pin = (await custPinCss(page))!;
  console.log(JSON.stringify({ pin }));
  expect(pin.x).toBeGreaterThan(pin.ew + 10);
  expect(pin.y).toBeGreaterThan(150);
  expect(pin.y).toBeLessThan(pin.eh - 150);
  await page.waitForTimeout(300);
  const total = await redPixels(page, "pane-cust");
  const rightStrip = await redPixels(page, "pane-cust", { x: pin.ew - 60, y: pin.y, r: 60 });
  console.log(JSON.stringify({ total, rightStrip }));
  expect(rightStrip).toBeGreaterThan(300);
  expect(rightStrip / total).toBeGreaterThan(0.9);
  await page.getByTestId("pane-cust").screenshot({ path: path.join(OUT, "customer-5-arrow-cover.png") });
  await page.getByTestId("pane-eng").screenshot({ path: path.join(OUT, "engineer-5-arrow-cover.png") });

  // 2초 동안 흔들려도(손떨림 영상) 화살표 안내가 유지되고 카드는 뜨지 않는다
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForTimeout(2000);
  const rows = (await customerGuide(page)).filter((r) => r.t > t0);
  const arrowFrac = rows.filter((r) => r.arrowUi).length / rows.length;
  console.log(JSON.stringify({ frames: rows.length, arrowFrac, card: rows.filter((r) => r.cardUi).length }));
  expect(rows.length).toBeGreaterThan(30);
  expect(arrowFrac).toBeGreaterThan(0.9);
  expect(rows.filter((r) => r.cardUi).length).toBe(0);

  // 가운데를 다시 탭 → 새 앵커가 고객 화면 안 → 화살표 대신 핀과 "빨간 동그라미를 봐주세요"
  const center = await engNormToPage(page, { x: 0.45, y: 0.55 });
  await page.mouse.click(center.x, center.y);
  await expect(page.getByTestId("cust-status")).toHaveText("빨간 동그라미를 봐주세요", { timeout: 15_000 });
  await expect(arrowText).toHaveCount(0);
  await expect(page.getByTestId("eng-chip")).toHaveText("고객 화면에 표시 중", { timeout: 5_000 });
});

test("반복 무늬: 엔지니어 토스트 · 고객은 바로 사진 카드 · 놓치면 다시 탭 안내", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await openLoopback(page, "&synthetic=repeat");
  await recordCustomerGuide(page);
  const tap = await engNormToPage(page, { x: 0.5, y: 0.45 });
  await page.mouse.click(tap.x, tap.y);

  // 엔지니어: 즉시 고정이라 자기 화면엔 붙어 있다 (trackable, ambiguous)
  await expect.poll(async () => (await engState(page)).trackable, { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId("eng-toast")).toHaveText("같은 무늬가 반복돼요 — 고객에게 사진 카드로 보여줘요", { timeout: 5_000 });
  expect((await engState(page)).state).toBe("tracking");
  expect(await redPixels(page, "pane-eng")).toBeGreaterThan(40);

  // 고객: 카드가 추적기의 첫 "찾을 수 없음" 갱신과 함께 바로 (0.8초 탐색을 기다리지 않음)
  const card = page.getByTestId("cust-card");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("eng-chip")).toHaveText("고객에게 사진 카드로 안내 중", { timeout: 5_000 });
  const rows = await customerGuide(page);
  const got = rows.find((r) => r.anchor !== null)!;
  const untrack = rows.find((r) => r.reason === "untrackable")!;
  const shown = rows.find((r) => r.cardUi)!;
  const sessionCard = rows.find((r) => r.showCard);
  const cardAfterAnchor = shown.t - got.t;
  const cardAfterUntrackable = shown.t - untrack.t;
  console.log(JSON.stringify({ cardAfterAnchor, cardAfterUntrackable, sessionCardAfterAnchor: sessionCard ? sessionCard.t - got.t : null }));
  // 화면은 추적기의 첫 "찾을 수 없음"(기준 설정 직후)과 같은 프레임 또는 다음 프레임에 카드를 띄운다
  // (세션의 0.8초 카드 타이머를 기다리지 않는다). 받은 뒤부터 그때까지는 기준 이미지 디코딩 + 추적기 기준 설정
  // = 추적기 몫이라 기록만 한다 (이 기계에서 두 브라우저 동시 실행 시 0.8~1.0초).
  expect(cardAfterUntrackable).toBeLessThan(100);
  expect(cardAfterAnchor).toBeLessThan(5000);
  await page.waitForTimeout(300);
  await page.getByTestId("pane-cust").screenshot({ path: path.join(OUT, "customer-6-repeat-card.png") });
  await page.getByTestId("pane-eng").screenshot({ path: path.join(OUT, "engineer-6-repeat-toast.png") });

  // 손으로 가림 → 엔지니어도 놓침. 반복 무늬라 다시 찾을 방법이 없다 → "다시 탭해 주세요"
  const retap = page.getByTestId("eng-retap");
  await expect(retap).toHaveCount(0);
  await coverSyntheticCamera(page, true);
  await expect(retap).toBeVisible({ timeout: 5_000 });
  await coverSyntheticCamera(page, false);
  await page.waitForTimeout(1200);
  await expect(retap).toBeVisible(); // 걷어도 스스로는 못 찾는다
  expect(await engState(page)).toMatchObject({ state: expect.stringMatching(/lost|searching/), trackable: true });
  await page.getByTestId("pane-eng").screenshot({ path: path.join(OUT, "engineer-7-retap.png") });

  // 다시 탭 → 새 앵커로 다시 붙고 안내가 사라진다
  const before = (await engState(page)).anchor;
  await page.mouse.click(tap.x, tap.y);
  await expect.poll(async () => (await engState(page)).anchor, { timeout: 5_000 }).not.toBe(before);
  await expect.poll(async () => (await engState(page)).state, { timeout: 5_000 }).toBe("tracking");
  await expect(retap).toHaveCount(0);
});
