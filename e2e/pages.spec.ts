import fs from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContextOptions } from "@playwright/test";
import { CLIPS, FIXTURE, ROOT, engineerCookie, fakeCamera, mockEvents, mockReset, redPixels } from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 운영 페이지 (/join/[code], /room/[id]) — 진짜 Supabase 없이:
//  REST·Auth = e2e/mock-supabase.mjs (Next 서버가 부른다), Realtime = 브라우저 WebSocket 가로채기 (e2e/realtime-mock.ts).
// 지표 이벤트는 가짜 Supabase가 기록한 것을 읽어 확인한다. 이 파일의 테스트는 가짜 DB를 공유하므로 차례로 돈다.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[0];
const EXPIRED = FIXTURE.rooms[1];
const OUT = path.join(ROOT, "test-results", "screens");
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ["camera", "microphone"],
};

test.beforeEach(async () => {
  await mockReset();
});

test("고객 /join: 코드 확인 → 큰 버튼 하나 → 카메라 미리보기 (로그인 없음)", async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(`/join/${ROOM.code.toLowerCase()}`);
  const start = page.getByRole("button", { name: /카메라 켜기/ });
  await expect(start).toBeVisible();
  const box = (await start.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(64); // 큰 버튼
  await expect.poll(async () => (await mockEvents()).map((e) => e.name)).toContain("link_opened");

  await start.click();
  const video = page.getByTestId("cust-video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…");
  await expect.poll(async () => (await mockEvents()).map((e) => e.name)).toContain("camera_granted");
  // 고객 쪽 기록 금지: localStorage·sessionStorage에 아무것도 없다
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await ctx.close();
});

test("고객 /join: 없는 코드·만료된 코드 안내", async ({ page }) => {
  await page.goto("/join/NOPE22");
  await expect(page.getByRole("heading", { name: "주소를 확인해 주세요" })).toBeVisible();
  await page.goto(`/join/${EXPIRED.code}`);
  await expect(page.getByRole("heading", { name: "종료된 연결이에요" })).toBeVisible();
});

test("엔지니어 /room: 로그인 없으면 로그인으로, 로그인하면 코드·연결 준비", async ({ browser, baseURL }) => {
  const anon = await browser.newPage();
  await anon.goto(`/room/${ROOM.id}`);
  await expect(anon).toHaveURL(/\/login\?next=%2Froom%2F/);
  await anon.close();

  const ctx = await browser.newContext(PHONE);
  await ctx.addCookies([engineerCookie(baseURL!)]);
  const page = await ctx.newPage();
  await page.goto(`/room/${ROOM.id}`);
  await expect(page.getByText(ROOM.code, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /연결 준비/ }).click();
  await expect(page.getByText("고객님 접속 대기 중…")).toBeVisible();
  await ctx.close();
});

test("통화: 엔지니어가 탭 → 고객 화면에 핀 · 지우기 · 정지 · 종료 (지표 이벤트 포함)", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  fs.mkdirSync(OUT, { recursive: true });
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
      if (m.type() === "error" || m.type() === "warning") logs.push(`[${who} ${m.type()}] ${m.text()}`);
    });
  }

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await expect(ep.getByText("고객님 접속 대기 중…")).toBeVisible();

    await cp.goto(`/join/${ROOM.code}`);
    await cp.getByRole("button", { name: /카메라 켜기/ }).click();

    // 연결되면 엔지니어 화면 전체가 영상 + 첫 사용 안내
    const engVideo = ep.getByTestId("eng-video");
    await expect(ep.getByTestId("eng-stage")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => engVideo.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
    await expect(ep.getByTestId("eng-hint")).toBeVisible();
    // 버튼은 아래쪽, 48px 이상 (한 손 조작)
    for (const id of ["eng-hangup", "eng-clear", "eng-freeze"]) {
      const b = (await ep.getByTestId(id).boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(48);
      expect(b.width).toBeGreaterThanOrEqual(48);
      expect(b.y).toBeGreaterThan(844 - 120);
    }
    await ep.waitForTimeout(1500);
    await ep.screenshot({ path: path.join(OUT, "page-engineer-connected.png") });
    await cp.screenshot({ path: path.join(OUT, "page-customer-connected.png") });

    // 탭 (손가락)
    const vb = (await engVideo.boundingBox())!;
    await ep.touchscreen.tap(vb.x + vb.width * 0.5, vb.y + vb.height * 0.5);
    await expect(ep.getByTestId("eng-chip")).toHaveText("고객 화면에 표시 중", { timeout: 20_000 });
    await expect.poll(() => redPixels(cp, null), { timeout: 10_000 }).toBeGreaterThan(40);
    await expect(cp.getByTestId("cust-status")).toHaveText("빨간 동그라미를 봐주세요");
    await expect(ep.getByTestId("eng-hint")).toHaveCount(0);
    await ep.waitForTimeout(600);
    await ep.screenshot({ path: path.join(OUT, "page-engineer-pin.png") });
    await cp.screenshot({ path: path.join(OUT, "page-customer-pin.png") });

    // 지표: 엔지니어 pointer_used (서버 액션 → 로그인·방 확인 → 기록)
    await expect
      .poll(async () => (await mockEvents()).filter((e) => e.name === "pointer_used" && e.actor === "engineer").length, { timeout: 10_000 })
      .toBe(1);
    const pu = (await mockEvents()).find((e) => e.name === "pointer_used" && e.actor === "engineer")!;
    expect(pu.room_id).toBe(ROOM.id);
    expect(pu.props).toMatchObject({ kind: "pin", newAnchor: true, trackable: true, seq: 1 });

    // 고객 카메라 전환 (replaceTrack + 같은 <video>에 새 미리보기) → 핀이 계속 붙어 있다
    const oldTrack = await cp.getByTestId("cust-video").evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0].id);
    await cp.getByRole("button", { name: "카메라 전환" }).click();
    await expect
      .poll(() => cp.getByTestId("cust-video").evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0].id))
      .not.toBe(oldTrack);
    await cp.waitForTimeout(1500);
    await expect.poll(() => redPixels(cp, null), { timeout: 10_000 }).toBeGreaterThan(40);
    await expect(ep.getByTestId("eng-chip")).toHaveText("고객 화면에 표시 중", { timeout: 10_000 });

    // 정지 → freeze_used, 재생
    await ep.getByTestId("eng-freeze").click();
    await expect(ep.getByTestId("eng-freeze")).toHaveText("재생");
    await expect
      .poll(async () => (await mockEvents()).filter((e) => e.name === "freeze_used").map((e) => e.props), { timeout: 10_000 })
      .toEqual([{ hasAnchor: true, customerState: "tracking" }]);
    await ep.getByTestId("eng-freeze").click();
    await expect(ep.getByTestId("eng-freeze")).toHaveText("정지");

    // 지우기 → 고객 화면에서도 사라지고, 고객 쪽 추적 결과 요약이 pointer_used(customer)로
    await ep.getByTestId("eng-clear").click();
    await expect.poll(() => redPixels(cp, null), { timeout: 5_000 }).toBe(0);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요");
    await expect
      .poll(async () => (await mockEvents()).filter((e) => e.name === "pointer_used" && e.actor === "customer").length, { timeout: 10_000 })
      .toBe(1);
    const outcome = (await mockEvents()).find((e) => e.name === "pointer_used" && e.actor === "customer")!;
    expect(outcome.props).toMatchObject({ side: "customer", end: "cleared", annotations: 1 });
    expect(outcome.props.acquire_ms as number).toBeLessThan(15_000);
    expect(outcome.props.tracked_fraction as number).toBeGreaterThan(0.3);

    // 종료 → 고객 "상담이 끝났습니다", 엔지니어 "출장 없이 해결됐나요?" → 대시보드
    await ep.getByTestId("eng-hangup").click();
    await expect(cp.getByRole("heading", { name: "상담이 끝났습니다" })).toBeVisible({ timeout: 10_000 });
    await ep.getByRole("button", { name: "네, 원격으로 해결" }).click();
    await ep.waitForURL(/\/dashboard/);

    const names = (await mockEvents()).map((e) => `${e.actor}:${e.name}`);
    console.log(JSON.stringify({ events: names, broadcasts: describeHub(hub) }));
    for (const n of ["customer:link_opened", "customer:camera_granted", "customer:connected", "engineer:pointer_used", "engineer:freeze_used", "customer:pointer_used", "engineer:ended", "engineer:resolved_remotely"]) {
      expect(names).toContain(n);
    }
    expect(logs.filter((l) => l.includes("pageerror"))).toEqual([]);
  } finally {
    if (logs.length) console.log(logs.slice(0, 20).join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});
