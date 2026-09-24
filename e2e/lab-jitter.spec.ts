import { expect, test } from "@playwright/test";
import {
  CLIPS,
  custNormToCss,
  custState,
  engState,
  fakeCamera,
  labData,
  loadGt,
  openLoopback,
  pinErrors,
  redPixels,
  summarize,
  waitEngFrame,
} from "./helpers";

// /lab/track 루프백: 고객 화면(내 카메라) ↔ 엔지니어 화면(WebRTC 수신)이 한 페이지 안의 RTCPeerConnection 쌍과
// 실제 DataChannel로 연결된다. 운영 통화 화면 컴포넌트·세션 클래스 그대로. 가짜 카메라 = 정답이 있는 합성 영상.
// 오차는 작업 해상도(긴 변 320) px, 화면 위치는 CSS px.

// 손떨림 영상 (핀이 계속 보임)
test.use({ launchOptions: fakeCamera(CLIPS.jitter), viewport: { width: 860, height: 960 }, deviceScaleFactor: 2 });
const gt = loadGt(CLIPS.jitter);

test("탭 → 고객 화면 같은 자리에 핀 · 선 추가 · 지우기", async ({ page }) => {
  await openLoopback(page);
  await expect(page.getByTestId("eng-hint")).toBeVisible();

  // 핀이 화면 가운데쯤인 프레임에서, 그 프레임의 정답 핀 위치를 탭
  const tap = await waitEngFrame(page, gt, (f) => f.inFrame && f.pin.x > 0.3 && f.pin.x < 0.7 && f.pin.y > 0.3 && f.pin.y < 0.7);
  const tTap = Date.now();
  await page.mouse.click(tap.x, tap.y);

  await expect.poll(async () => (await custState(page)).state, { timeout: 15_000 }).toBe("tracking");
  const acquireMs = Date.now() - tTap;
  await expect.poll(async () => (await engState(page)).customerState, { timeout: 5_000 }).toBe("tracking");
  await expect(page.getByTestId("eng-chip")).toHaveText("고객 화면에 표시 중");
  await expect(page.getByTestId("eng-hint")).toHaveCount(0);
  await page.waitForTimeout(2500);

  // ── 정답과 비교 (프레임별)
  const data = await labData(page);
  expect(data.refs.length).toBe(1);
  const refIdx = data.refs[0].idx!;
  expect(refIdx).not.toBeNull();
  const anchor = data.engAnchor!;
  expect(data.custAnchor?.id).toBe(anchor.id);
  const eng = summarize(pinErrors(gt, data, "eng", anchor, refIdx));
  const custRows = pinErrors(gt, data, "cust", anchor, refIdx);
  const cust = summarize(custRows);
  console.log(JSON.stringify({ tapFrame: tap.idx, refIdx, acquireMs, eng, cust }));
  expect(eng.shown).toBeGreaterThan(20);
  expect(cust.shown).toBeGreaterThan(15);
  expect(eng.median).toBeLessThanOrEqual(2);
  expect(cust.median).toBeLessThanOrEqual(2);
  expect(cust.p95).toBeLessThanOrEqual(4);
  expect(cust.wrong).toBeLessThanOrEqual(Math.max(1, Math.floor(cust.shown * 0.02)));

  // ── 고객 화면(cover)에 실제로 그려진 위치: 마지막 갱신의 핀 CSS 좌표 vs 그 프레임의 정답 CSS 좌표
  const last = custRows.filter((r) => r.est).at(-1)!;
  const estCss = await custNormToCss(page, last.est!);
  const gtCss = await custNormToCss(page, last.gt);
  const cssErr = Math.hypot(estCss.x - gtCss.x, estCss.y - gtCss.y);
  console.log(JSON.stringify({ lastIdx: last.idx, estCss, gtCss, cssErr }));
  expect(cssErr).toBeLessThanOrEqual(6);
  // 오버레이 캔버스에 그 자리(반지름 30px 안)에 빨간 핀이 그려져 있다
  expect(await redPixels(page, "pane-cust", { x: estCss.x, y: estCss.y, r: 30 })).toBeGreaterThan(40);

  // 지표 이벤트
  const pin = data.events.find((e) => e.name === "pointer_used");
  expect(pin?.props).toMatchObject({ kind: "pin", newAnchor: true, trackable: true, customerState: null, seq: 1 });

  // ── 드래그: 핀 옆(같은 앵커 ROI 안)에서 선 → 같은 앵커에 추가, 고객에게도
  const redBefore = await redPixels(page, "pane-cust");
  await page.mouse.move(tap.x - 40, tap.y + 30);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(tap.x - 40 + i * 5, tap.y + 30 - i * 2, { steps: 1 });
  await page.mouse.up();
  await expect.poll(async () => (await engState(page)).kinds.join(","), { timeout: 5_000 }).toBe("pin,stroke");
  await expect.poll(async () => (await custState(page)).n, { timeout: 5_000 }).toBe(2);
  expect((await custState(page)).anchor).toBe(anchor.id);
  await expect.poll(async () => (await custState(page)).state, { timeout: 10_000 }).toBe("tracking");
  await page.waitForTimeout(300);
  const redAfter = await redPixels(page, "pane-cust");
  console.log(JSON.stringify({ redBefore, redAfter }));
  expect(redAfter).toBeGreaterThan(redBefore + 100);
  const stroke = (await labData(page)).events.filter((e) => e.name === "pointer_used")[1];
  expect(stroke?.props).toMatchObject({ kind: "stroke", newAnchor: false, trackable: true, customerState: "tracking", seq: 2 });

  // ── 지우기: 양쪽 다 사라지고 캔버스도 빈다
  await page.getByTestId("eng-clear").click();
  await expect.poll(async () => (await custState(page)).anchor, { timeout: 5_000 }).toBeNull();
  expect((await engState(page)).anchor).toBeNull();
  await page.waitForTimeout(200);
  expect(await redPixels(page, "pane-cust")).toBe(0);
  expect(await redPixels(page, "pane-eng")).toBe(0);
  await expect(page.getByTestId("eng-chip")).toHaveCount(0);
  await expect(page.getByTestId("eng-clear")).toBeDisabled();
  // 첫 주석 뒤에는 안내가 다시 뜨지 않는다
  await expect(page.getByTestId("eng-hint")).toHaveCount(0);
  // 고객 쪽 결과 요약 (지운 앵커 1건)
  const outcome = (await labData(page)).events.find((e) => e.name === "pointer_used:customer");
  expect(outcome?.props).toMatchObject({ side: "customer", end: "cleared", annotations: 2 });
  expect(outcome!.props.acquire_ms as number).toBeLessThan(10_000);
  expect(outcome!.props.tracked_fraction as number).toBeGreaterThan(0.5);
});

test("정지 화면에서 탭 · 재생 · 고객 카메라 전환 뒤에도 추적", async ({ page }) => {
  await openLoopback(page);
  // 정지
  await page.getByTestId("eng-freeze").click();
  await expect(page.getByTestId("eng-freeze")).toHaveText("재생");
  expect(await page.evaluate(() => document.querySelector<HTMLVideoElement>("[data-testid=eng-video]")!.paused)).toBe(true);
  expect((await engState(page)).frozen).toBe(true);
  const freeze = (await labData(page)).events.find((e) => e.name === "freeze_used");
  expect(freeze?.props).toMatchObject({ hasAnchor: false });

  // 멈춘 화면 가운데 탭 → 핀 (엔지니어 쪽은 멈춘 프레임 위 그대로), 고객은 스스로 찾는다
  const box = (await page.getByTestId("eng-video").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect.poll(async () => (await engState(page)).kinds.join(","), { timeout: 5_000 }).toBe("pin");
  await expect.poll(async () => (await custState(page)).state, { timeout: 15_000 }).toBe("tracking");
  expect(await redPixels(page, "pane-eng")).toBeGreaterThan(40);

  // 재생
  await page.getByTestId("eng-freeze").click();
  await expect(page.getByTestId("eng-freeze")).toHaveText("정지");
  expect(await page.evaluate(() => document.querySelector<HTMLVideoElement>("[data-testid=eng-video]")!.paused)).toBe(false);
  expect((await engState(page)).frozen).toBe(false);

  // 고객 카메라 전환 (같은 <video>에 새 스트림, replaceTrack) → 같은 앵커로 계속 추적
  const anchorId = (await custState(page)).anchor;
  const tFlip = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "카메라 전환" }).click();
  await page.waitForTimeout(500);
  await expect
    .poll(
      async () => {
        const d = await labData(page);
        return d.log.filter((r) => r.side === "cust" && r.t > tFlip + 400 && r.state === "tracking").length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(10);
  expect((await custState(page)).anchor).toBe(anchorId);
});
