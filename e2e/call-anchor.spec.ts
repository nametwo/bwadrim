import { expect, test, type BrowserContextOptions, type Page } from "@playwright/test";
import { CLIPS, FIXTURE, engineerCookie, fakeCamera, mockEvents, mockReset, redPixels } from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 실제 통화 화면(/room/[id] ↔ /join/[token])에서 CALL-08·CALL-14 제스처:
//  짧게 탭 = 3초 빨간 동그라미, 길게 누름(0.5초) = 물체에 붙는 AR 핀.
// 진짜 Supabase 없이 — REST·Auth는 e2e/mock-supabase.mjs, Realtime은 브라우저 WebSocket 가로채기(realtime-mock.ts).
// 가짜 카메라 = 벤치 합성 영상(손떨림, 세로 480x640). 두 페이지는 같은 Chromium의 다른 컨텍스트, WebRTC는 실제 루프백.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[0];
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ["camera", "microphone"],
};

async function holdAt(page: Page, x: number, y: number, ms: number) {
  // 터치 길게 누르기: CDP로 손가락을 내렸다가 ms 뒤 뗀다 (touchscreen.tap은 바로 뗀다)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test.beforeEach(async () => {
  await mockReset(ROOM.id);
});

test("통화: 짧게 탭 = 빨간 동그라미, 길게 누름 = 고객 화면에 붙는 핀 · 핀 지우기 (anchor_used 기록)", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const hub = new RealtimeHub();
  const engCtx = await browser.newContext(PHONE);
  await engCtx.addCookies([engineerCookie(baseURL!)]);
  const custCtx = await browser.newContext(PHONE);
  await hub.attach(engCtx);
  await hub.attach(custCtx);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs: string[] = [];
  for (const [who, p] of [["eng", ep], ["cust", cp]] as const) {
    p.on("pageerror", (e) => logs.push(`[${who} pageerror] ${e.message}`));
    p.on("console", (m) => {
      if (m.type() === "error") logs.push(`[${who} error] ${m.text()}`);
    });
  }

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await expect(ep.getByTestId("eng-wait-title")).toHaveText("고객님을 기다리고 있어요");

    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜기/ }).click();

    const engVideo = ep.getByTestId("eng-video");
    await expect.poll(() => engVideo.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
    // 추적기가 첫 프레임을 받을 시간
    await ep.waitForTimeout(1500);

    const vb = (await engVideo.boundingBox())!;
    const cx = vb.x + vb.width * 0.5;
    const cy = vb.y + vb.height * 0.5;

    // 1) 짧게 탭 → 레이저 포인터 (CALL-08). 핀은 생기지 않는다
    await ep.touchscreen.tap(cx, cy);
    await expect(cp.getByTestId("pointer-marker")).toBeVisible({ timeout: 5_000 });
    await expect(ep.getByRole("button", { name: "핀 지우기" })).toHaveCount(0);
    await expect.poll(async () => (await mockEvents()).map((e) => e.name)).toContain("pointer_used");
    await ep.waitForTimeout(3500); // 동그라미가 사라질 때까지

    // 2) 길게 누름 → AR 핀 (CALL-14): 엔지니어·고객 화면 모두 핀, 고객 상태 문구가 핀 안내로
    await holdAt(ep, cx, cy, 800);
    await expect(ep.getByRole("button", { name: "핀 지우기" })).toBeVisible({ timeout: 5_000 });
    await expect(ep.getByText("고객 화면에 표시 중")).toBeVisible({ timeout: 20_000 });
    await expect(cp.getByTestId("cust-status")).toHaveText("빨간 동그라미를 봐주세요", { timeout: 20_000 });
    await expect.poll(() => redPixels(ep, "eng-stage"), { timeout: 10_000 }).toBeGreaterThan(50);
    await expect.poll(() => redPixels(cp, null), { timeout: 10_000 }).toBeGreaterThan(50);
    await expect.poll(async () => (await mockEvents()).map((e) => e.name)).toContain("anchor_used");
    // 핀 위치 ≈ 누른 곳: 엔지니어 영상 가운데를 눌렀으니 고객 영상(전체 표시)도 가운데 근처.
    // 3초 뒤(레이저 포인터라면 사라졌을 때)에도 그 자리에 남아 있다 — 가짜 카메라는 계속 손떨림
    const cv = (await cp.getByTestId("cust-video").boundingBox())!;
    const near = { x: cv.width / 2, y: cv.height / 2, r: 70 }; // 캔버스(영상과 같은 자리) 기준
    const engNear = { x: cx - vb.x, y: cy - vb.y, r: 70 };
    await cp.waitForTimeout(3500);
    expect(await redPixels(cp, null, near)).toBeGreaterThan(50);
    expect(await redPixels(ep, "eng-stage", engNear)).toBeGreaterThan(50);

    // 3) 핀 지우기 → 양쪽에서 사라진다
    await ep.getByRole("button", { name: "핀 지우기" }).click();
    await expect(ep.getByRole("button", { name: "핀 지우기" })).toHaveCount(0);
    await expect.poll(() => redPixels(cp, null), { timeout: 10_000 }).toBeLessThanOrEqual(0);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요");

    // 4) 누른 채 움직이면(드래그) 아무것도 안 한다
    const cdp = await ep.context().newCDPSession(ep);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + 40, y: cy }] });
    await ep.waitForTimeout(800);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await expect(ep.getByRole("button", { name: "핀 지우기" })).toHaveCount(0);
    await expect(cp.getByTestId("pointer-marker")).toHaveCount(0);

    expect(logs.filter((l) => l.includes("pageerror"))).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) {
      console.log("hub:", describeHub(hub));
      console.log(logs.join("\n"));
    }
    await engCtx.close();
    await custCtx.close();
  }
});
