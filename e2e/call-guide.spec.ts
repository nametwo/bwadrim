import { expect, test, type BrowserContextOptions, type Page } from "@playwright/test";
import { CLIPS, FIXTURE, engineerCookie, fakeCamera, mockEvents, mockReset, redPixels } from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 실제 통화 화면(/room/[id] ↔ /join/[token])에서 CALL-15 방향 지시:
//  방향 링을 누르고 있는 동안만 고객 화면에 방향이 뜨고, 떼면 사라진다. 전용 DataChannel 'guide'. 그동안 AR 핀은 잠시 숨는다.
// 진짜 Supabase 없이 — call-anchor.spec.ts와 같은 가짜 서버·가짜 카메라·실제 WebRTC 루프백.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[3]; // 다른 통화 테스트와 동시에 돌아도 서로의 방·기록을 건드리지 않게 방을 따로 쓴다
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ["camera", "microphone"],
};

type Touch = { down(x: number, y: number): Promise<void>; move(x: number, y: number): Promise<void>; up(): Promise<void> };

async function finger(page: Page): Promise<Touch> {
  // 누른 채로 유지·이동: CDP로 손가락을 직접 내리고 올린다 (touchscreen.tap은 바로 뗀다)
  const cdp = await page.context().newCDPSession(page);
  return {
    down: async (x, y) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    },
    move: async (x, y) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    },
    up: async () => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    },
  };
}

test.beforeEach(async () => {
  await mockReset(ROOM.id);
});

test("통화: 방향 링을 누르는 동안만 고객 화면에 방향 · 굴리면 방향 전환 · 가까이 · 방향키 · AR 핀 잠시 숨김 · 멈춤 중 비활성 (guide_used 기록)", async ({
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
    await expect(ep.getByTestId("eng-waiting")).toBeVisible();

    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });

    const pad = ep.getByRole("group", { name: /방향 링/ });
    await expect(pad).toBeVisible({ timeout: 10_000 });
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const band = cp.getByTestId("guide-band");

    // 1) 오른쪽 팔을 누르고 있는 동안 고객 화면에 '오른쪽으로'. 상태 문구는 숨긴다
    const f1 = await finger(ep);
    await f1.down(cx + 70, cy);
    await expect(band).toHaveAttribute("data-cmd", "right", { timeout: 5_000 });
    await expect(band).toContainText("오른쪽으로");
    // 고객 화면 오른쪽 가장자리에 노란 원 화살표
    await expect(cp.getByTestId("guide-arrow")).toHaveAttribute("data-dir", "right");
    await expect(cp.getByTestId("cust-status")).toBeHidden();
    // 엔지니어 화면의 '고객 화면' 알약도 노랗게 '오른쪽으로' (피그마 GuidePill)
    await expect(ep.getByTestId("eng-guide-pill").filter({ visible: true })).toHaveAttribute("data-cmd", "right");
    // 0.4초마다 다시 보내므로 1.5초 넘게 눌러도 그대로 있다
    await ep.waitForTimeout(2000);
    await expect(band).toHaveAttribute("data-cmd", "right");
    // 2) 누른 채 위로 굴리면 떼지 않고 '위쪽으로'
    await f1.move(cx, cy - 70);
    await expect(band).toHaveAttribute("data-cmd", "up", { timeout: 5_000 });
    // 3) 떼면 사라지고 상태 문구가 돌아온다
    await f1.up();
    await expect(band).toHaveCount(0, { timeout: 5_000 });
    await expect(cp.getByTestId("cust-status")).toBeVisible();
    await expect.poll(async () => (await mockEvents()).map((e) => e.name)).toContain("guide_used");

    // 4) 톡 짧게 눌러도 1초는 보인다
    const f2 = await finger(ep);
    await f2.down(cx - 70, cy);
    await ep.waitForTimeout(80);
    await f2.up();
    await expect(band).toHaveAttribute("data-cmd", "left", { timeout: 3_000 });
    await expect(band).toHaveCount(0, { timeout: 5_000 });

    // 5) 링 아래 알약: 오른쪽 반 = 가까이, 누른 채 왼쪽으로 밀면 떼지 않고 멀리
    const zoom = ep.getByRole("group", { name: /가까이·멀리/ });
    const zb = (await zoom.boundingBox())!;
    const f3 = await finger(ep);
    await f3.down(zb.x + zb.width * 0.75, zb.y + zb.height / 2);
    await expect(band).toHaveAttribute("data-cmd", "closer", { timeout: 5_000 });
    await expect(cp.getByTestId("guide-arrow")).toHaveCount(0);
    await f3.move(zb.x + zb.width * 0.25, zb.y + zb.height / 2);
    await expect(band).toHaveAttribute("data-cmd", "farther", { timeout: 5_000 });
    await f3.up();
    await expect(band).toHaveCount(0, { timeout: 5_000 });

    // 5-1) 가운데 구멍을 톡 누르기만 하면 아무것도 보내지 않고, '고객 화면' 알약 자리에 쓰는 법이 잠깐 뜬다
    const f7 = await finger(ep);
    await f7.down(cx, cy);
    await f7.up();
    await expect(ep.getByTestId("eng-guide-pill").filter({ visible: true })).toContainText("방향을 누르고 있는 동안만");
    await ep.waitForTimeout(600);
    await expect(band).toHaveCount(0);

    // 6) PC처럼 방향키를 누르고 있는 동안
    await ep.keyboard.down("ArrowDown");
    await expect(band).toHaveAttribute("data-cmd", "down", { timeout: 5_000 });
    await ep.keyboard.up("ArrowDown");
    await expect(band).toHaveCount(0, { timeout: 5_000 });

    // 7) AR 핀(CALL-14)이 있을 때 방향 지시를 누르면 고객 화면의 핀·핀 안내는 잠시 숨고, 떼면 돌아온다
    const engVideo = ep.getByTestId("eng-video");
    await engVideo.scrollIntoViewIfNeeded();
    const vb = (await engVideo.boundingBox())!;
    const f5 = await finger(ep);
    await f5.down(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await ep.waitForTimeout(800);
    await f5.up();
    await expect(cp.getByTestId("cust-status")).toHaveText("빨간 동그라미를 봐주세요", { timeout: 20_000 });
    await expect.poll(() => redPixels(cp, null), { timeout: 10_000 }).toBeGreaterThan(50);
    await pad.scrollIntoViewIfNeeded();
    const box3 = (await pad.boundingBox())!;
    const f6 = await finger(ep);
    await f6.down(box3.x + box3.width / 2 + 70, box3.y + box3.height / 2);
    await expect(band).toHaveAttribute("data-cmd", "right", { timeout: 5_000 });
    await expect.poll(() => redPixels(cp, null), { timeout: 5_000 }).toBeLessThanOrEqual(0);
    await expect(cp.getByTestId("cust-status")).toBeHidden();
    await f6.up();
    await expect(band).toHaveCount(0, { timeout: 5_000 });
    await expect(cp.getByTestId("cust-status")).toHaveText("빨간 동그라미를 봐주세요", { timeout: 10_000 });
    await expect.poll(() => redPixels(cp, null), { timeout: 10_000 }).toBeGreaterThan(50);

    // 8) 화면을 멈추면 방향 링 자리에 파란 '라이브로'(피그마 E08) — 그 자리를 눌러도 고객 화면에 방향이 뜨지 않는다
    const box2 = (await pad.boundingBox())!;
    await ep.getByRole("button", { name: /멈추고 그리기/ }).click();
    await expect(pad).toHaveCount(0, { timeout: 5_000 });
    const live = ep.getByRole("button", { name: "라이브로" });
    await expect(live).toBeVisible();
    const f4 = await finger(ep);
    // 위쪽 팔 자리 (가운데 '라이브로' 버튼은 가로로 넓어서 좌우 팔 자리를 덮는다)
    await f4.down(box2.x + box2.width / 2, box2.y + 8);
    await ep.waitForTimeout(1000);
    await expect(band).toHaveCount(0);
    await f4.up();
    await expect(live).toBeVisible();
    // 라이브로 돌아가면 방향 링도 돌아온다
    await live.click();
    await expect(pad).toBeVisible({ timeout: 5_000 });

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
