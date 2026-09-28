import { expect, test, type BrowserContextOptions } from "@playwright/test";
import {
  CLIPS,
  FIXTURE,
  engineerCookie,
  fakeCamera,
  mockEvents,
  mockPatchRoom,
  mockReports,
  mockReset,
  type MockEvent,
} from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 운영 로깅 (DATA-01·07, OPS-06): 통화 흐름에서 새 기록이 실제로 찍히는지.
//  - 정상 통화: 양쪽 call_ready·connected(v·env·pid), TURN 없이 시작한 turn_fallback(e2e는 TURN 키가 비어 있다)
//  - 고객이 '끝내기' 없이 탭을 닫으면: 고객 화면 요약(call_summary), 엔지니어 call_failed {in_call, peer_gone}
//  - 끝난 상담에서 '카메라 켜기': call_failed {room_gone}도 받는다(종료 뒤 유예)
//  - 끝났거나 만료된 링크: link_blocked · 화면 JS 오류: client_error(링크 토큰은 지운다)
// 디스코드 알림은 운영 배포에서만 가므로 여기서는 보내지 않는다.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[5];
const GONE_ROOM = FIXTURE.rooms[6];
const EXPIRED = FIXTURE.rooms[1];
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ["camera", "microphone"],
};

const roomEvents = async (roomId: string) => (await mockEvents()).filter((e) => e.room_id === roomId);
const named = (evs: MockEvent[], name: string, actor?: string) =>
  evs.filter((e) => e.name === name && (!actor || e.actor === actor));

test.beforeEach(async () => {
  await Promise.all([mockReset(ROOM.id), mockReset(GONE_ROOM.id), mockReset(EXPIRED.id)]);
});

test("정상 통화 → 양쪽 call_ready·connected, 탭을 닫으면 고객 요약과 엔지니어 peer_gone", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const hub = new RealtimeHub();
  const engCtx = await browser.newContext(PHONE);
  await engCtx.addCookies([engineerCookie(baseURL!)]);
  await hub.attach(engCtx);
  const custCtx = await browser.newContext(PHONE);
  await hub.attach(custCtx);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });

    // 준비·연결은 양쪽에서 한 번씩 (connected는 연결되고 1초 뒤 다시 확인하고 보낸다)
    await expect
      .poll(async () => {
        const evs = await roomEvents(ROOM.id);
        return ["customer", "engineer"].map(
          (a) => `${a}:${named(evs, "call_ready", a).length}:${named(evs, "connected", a).length}`,
        );
      }, { timeout: 15_000 })
      .toEqual(["customer:1:1", "engineer:1:1"]);

    const evs = await roomEvents(ROOM.id);
    const ready = named(evs, "call_ready", "customer")[0].props;
    expect(ready).toMatchObject({ track: "ok", turn: false, turn_err: "env_missing", env: "development", gum_attempt: 1 });
    expect(typeof ready.ms).toBe("number");
    expect(ready.pid).toMatch(/^[0-9a-f]{16}$/);
    expect(named(evs, "call_ready", "engineer")[0].props).toMatchObject({ mic: "ok", turn: false });
    expect(named(evs, "connected", "customer")[0].props).toMatchObject({ attempt: 1, reconnect: false, relay: false });
    expect(named(evs, "camera_granted")[0].props).toMatchObject({ mic: true, attempt: 1 });
    // TURN 키가 없으니 양쪽 모두 STUN만 — 서버가 남기고, 누가 받았는지는 로그인으로 가린다
    expect(named(evs, "turn_fallback", "system").map((e) => e.props.who).sort()).toEqual(["customer", "engineer"]);
    expect(named(evs, "turn_fallback")[0].props).toMatchObject({ reason: "env_missing" });
    expect(named(evs, "call_failed")).toEqual([]);

    // 고객이 '끝내기' 없이 탭을 닫음 → 고객 화면 요약(sendBeacon), 엔지니어는 연결을 잃은 것을 남긴다
    await cp.close({ runBeforeUnload: true });
    await expect
      .poll(async () => (await mockReports()).find((r) => r.room_id === ROOM.id && r.actor === "customer")?.report.phase, {
        timeout: 10_000,
      })
      .toBe("call:connected");
    const cust = (await mockReports()).find((r) => r.room_id === ROOM.id && r.actor === "customer")!.report;
    expect(cust).toMatchObject({ role: "customer", env: "development" });
    expect(cust.call).toMatchObject({ attempts: 1, connects: 1 });
    expect(cust.quality).toBeTruthy();

    await expect
      .poll(async () => named(await roomEvents(ROOM.id), "call_failed", "engineer").map((e) => `${e.props.stage}:${e.props.reason}`), {
        timeout: 20_000,
      })
      .toEqual(["in_call:peer_gone"]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub));
    await engCtx.close();
    await custCtx.close();
  }
});

test("링크를 연 사이 상담이 끝났으면 call_failed {room_gone}을 남긴다 (종료 뒤에도 받음)", async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const cp = await ctx.newPage();
  try {
    await cp.goto(`/join/${GONE_ROOM.join_token}`);
    await mockPatchRoom(GONE_ROOM.id, { status: "ended" });
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-gone")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => named(await roomEvents(GONE_ROOM.id), "call_failed").map((e) => e.props.stage), { timeout: 10_000 })
      .toEqual(["room_gone"]);
  } finally {
    await ctx.close();
  }
});

test("만료된 링크는 link_blocked, 화면 JS 오류는 client_error (토큰은 지움)", async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const p = await ctx.newPage();
  try {
    await p.goto(`/join/${EXPIRED.join_token}`);
    await expect(p.getByText("링크가 만료됐어요")).toBeVisible();
    await expect
      .poll(async () => named(await roomEvents(EXPIRED.id), "link_blocked").map((e) => e.props.reason), { timeout: 10_000 })
      .toEqual(["expired"]);

    await p.goto(`/join/${GONE_ROOM.join_token}`);
    await p.getByRole("button", { name: /카메라 켜고 시작하기/ }).waitFor();
    await p.evaluate((token) => {
      setTimeout(() => {
        throw new Error(`boom ${token}`);
      });
    }, GONE_ROOM.join_token);
    await expect
      .poll(async () => named(await roomEvents(GONE_ROOM.id), "client_error").map((e) => e.props.msg), { timeout: 10_000 })
      .toEqual(["boom [token]"]);
  } finally {
    await ctx.close();
  }
});
