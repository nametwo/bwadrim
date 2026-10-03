import { expect, test, type BrowserContextOptions, type Page } from "@playwright/test";
import { CLIPS, FIXTURE, engineerCookie, fakeCamera, mockEvents, mockReset, mockRooms } from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 통화 끝내기 흐름 (ROOM-10·13, JOIN-08·04, 피그마 E03·E04·E10·C18·C19):
//  - 고객이 링크를 열면 엔지니어 대기 화면의 '고객 진행 상황'이 바뀐다
//  - 엔지니어 '종료' → '통화를 끝낼까요?'. '계속 통화하기'면 이어지고, '통화 끝내기'면 상담이 닫히고 바로 상담 목록으로
//  - 고객 '통화 종료' → 확인 창. '계속하기'면 이어지고, '끝내기'면 상담도 닫힌다(엔지니어 화면 '고객님이 통화를 끝냈어요').
//    고객 끝난 화면에 다시 연결 버튼은 없고, 링크를 다시 열면 '상담이 이미 끝났어요'
//  - 연결 없이 '상담 닫기' → '닫기'
//  - 고객 마이크를 못 쓰면(전화 통화 중 등) 카메라만으로 연결하고 엔지니어 화면에 알린다
// 진짜 Supabase 없이 — 다른 통화 테스트와 같은 가짜 서버·가짜 카메라·실제 WebRTC 루프백.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[2];
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ["camera", "microphone"],
};

// 확인 창이 뜬 직후(0.6초)의 탭은 일부러 무시하므로 조금 기다렸다 누른다
const ARM_WAIT_MS = 700;

async function open(hub: RealtimeHub, browser: import("@playwright/test").Browser, baseURL: string, engineer: boolean) {
  const ctx = await browser.newContext(PHONE);
  if (engineer) await ctx.addCookies([engineerCookie(baseURL)]);
  await hub.attach(ctx);
  return ctx;
}

function collectErrors(pages: [string, Page][]) {
  const logs: string[] = [];
  for (const [who, p] of pages) p.on("pageerror", (e) => logs.push(`[${who} pageerror] ${e.message}`));
  return logs;
}

test.beforeEach(async () => {
  await mockReset(ROOM.id);
});

// 이 방의 기록: 상태, 'ended' 이벤트 props, 이벤트 이름들
async function roomRecord() {
  const room = (await mockRooms()).find((r) => r.id === ROOM.id);
  const events = (await mockEvents()).filter((e) => e.room_id === ROOM.id);
  return {
    status: room?.status,
    resolvedRemotely: room?.resolved_remotely ?? null,
    ended: events.filter((e) => e.name === "ended").map((e) => e.props),
    names: events.map((e) => e.name),
  };
}

async function connect(ep: Page, cp: Page) {
  await ep.goto(`/room/${ROOM.id}`);
  await ep.getByRole("button", { name: /연결 준비/ }).click();
  await cp.goto(`/join/${ROOM.join_token}`);
  await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
  await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
  await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
}

test("끝내기: 엔지니어·고객 확인 창과 계속하기 · 고객이 끝내면 상담도 닫힘 · 다시 연결 없음", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const hub = new RealtimeHub();
  const engCtx = await open(hub, browser, baseURL!, true);
  const custCtx = await open(hub, browser, baseURL!, false);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs = collectErrors([["eng", ep], ["cust", cp]]);
  const connected = () => expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    // 아직 링크를 안 보냈으면 '문자로 링크 보내기' 화면(피그마 E03)
    await expect(ep.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "false");
    // 고객이 링크를 열면 몇 초 안에 '고객 진행 상황'(E04)이 바뀐다 (ROOM-13)
    await cp.goto(`/join/${ROOM.join_token}`);
    await expect(ep.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "true", { timeout: 10_000 });
    await expect(ep.getByTestId("eng-progress")).toContainText("고객님이 링크를 열었어요");
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await connected();
    await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
    await expect(ep.getByTestId("eng-quality")).toHaveText("연결 좋음");

    // 1) 엔지니어 '종료' → '통화를 끝낼까요?'(피그마 E10). 창이 떠 있는 동안에도 통화는 이어진다 → '계속 통화하기'
    await ep.getByRole("button", { name: "종료", exact: true }).click();
    const engSheet = ep.getByTestId("eng-end-sheet");
    await expect(engSheet).toBeVisible();
    await expect(engSheet).toContainText("통화를 끝낼까요?");
    await expect(engSheet).toContainText("고객님 화면도 같이 끊겨요.");
    await expect(engSheet.getByRole("button", { name: "통화 끝내기" })).toBeVisible();
    await connected();
    await ep.waitForTimeout(ARM_WAIT_MS);
    await engSheet.getByRole("button", { name: "계속 통화하기" }).click();
    await expect(engSheet).toHaveCount(0);
    await connected();

    // 2) 고객 '통화 종료' → 확인 창(C18) → '계속하기'면 그대로
    await cp.getByRole("button", { name: "통화 종료" }).click();
    const custSheet = cp.getByTestId("cust-end-sheet");
    await expect(custSheet).toBeVisible();
    await cp.waitForTimeout(ARM_WAIT_MS);
    await custSheet.getByRole("button", { name: "계속하기" }).click();
    await expect(custSheet).toHaveCount(0);
    await connected();

    // 3) 고객이 끝내면 상담도 닫힌다. 고객 끝난 화면엔 다시 연결 버튼이 없고, 엔지니어는 '고객님이 통화를 끝냈어요'
    await cp.getByRole("button", { name: "통화 종료" }).click();
    await cp.waitForTimeout(ARM_WAIT_MS);
    await custSheet.getByRole("button", { name: "끝내기", exact: true }).click();
    const custEnded = cp.getByTestId("cust-ended");
    await expect(custEnded).toBeVisible();
    await expect(custEnded).toContainText("상담이 끝났어요");
    await expect(custEnded).toContainText("이 창은 닫으셔도 돼요.");
    await expect(custEnded.getByRole("button")).toHaveCount(0);
    const engEnded = ep.getByTestId("eng-customer-ended");
    await expect(engEnded).toContainText("고객님이 통화를 끝냈어요", { timeout: 10_000 });
    await expect(engEnded).toContainText("상담도 같이 끝났어요.");
    await expect.poll(async () => (await roomRecord()).status).toBe("ended");
    const rec = await roomRecord();
    expect(rec.ended).toEqual([{ duration_sec: expect.any(Number), connected: true }]);
    expect(rec.names).not.toContain("resolved_remotely");
    expect(rec.resolvedRemotely).toBeNull();

    // 4) 고객이 링크를 다시 열어도 통화로 돌아오지 않는다 (닫힌 상담)
    await cp.goto(`/join/${ROOM.join_token}`);
    await expect(cp.getByText("상담이 이미 끝났어요")).toBeVisible();
    await expect(engEnded).toBeVisible();

    // 5) '상담 목록으로'
    await engEnded.getByRole("button", { name: "상담 목록으로" }).click();
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});

test("엔지니어가 끝내면 확인 한 번에 상담이 닫히고 상담 목록으로 (찍은 사진 없음)", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const hub = new RealtimeHub();
  const engCtx = await open(hub, browser, baseURL!, true);
  const custCtx = await open(hub, browser, baseURL!, false);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs = collectErrors([["eng", ep], ["cust", cp]]);

  try {
    await connect(ep, cp);
    await ep.getByRole("button", { name: "종료", exact: true }).click();
    await ep.waitForTimeout(ARM_WAIT_MS);
    await ep.getByTestId("eng-end-sheet").getByRole("button", { name: "통화 끝내기" }).click();
    // 고객 화면도 끝나고, 엔지니어는 다른 화면 없이 상담 목록으로
    await expect(cp.getByTestId("cust-ended")).toBeVisible({ timeout: 10_000 });
    await expect(cp.getByTestId("cust-ended").getByRole("button")).toHaveCount(0);
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
    const rec = await roomRecord();
    expect(rec.status).toBe("ended");
    expect(rec.ended).toEqual([{ duration_sec: expect.any(Number), connected: true }]);
    expect(rec.names).not.toContain("resolved_remotely");
    expect(rec.resolvedRemotely).toBeNull();
    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});

test("새로고침 뒤 '다시 연결할까요?'에서 '통화 종료' → '끝내기': 종료 알림을 따로(REST) 보내 기다리던 고객 화면도 끝난다", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const hub = new RealtimeHub();
  const engCtx = await open(hub, browser, baseURL!, true);
  const custCtx = await open(hub, browser, baseURL!, false);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs = collectErrors([["eng", ep], ["cust", cp]]);

  try {
    await connect(ep, cp);
    await expect.poll(async () => (await roomRecord()).status).toBe("active");
    // 엔지니어 화면 새로고침 → 통화 연결 없이 '다시 연결할까요?'. 고객 화면은 그대로 기사님을 기다린다
    await ep.reload();
    await expect(ep.getByText("다시 연결할까요?")).toBeVisible({ timeout: 30_000 });
    await ep.waitForLoadState("networkidle");

    await ep.getByRole("button", { name: "통화 종료" }).click();
    const sheet = ep.getByTestId("eng-end-sheet");
    await expect(sheet).toContainText("상담을 끝낼까요?");
    await expect(sheet).toContainText("고객님께 보낸 링크도 더는 안 열려요.");
    await ep.waitForTimeout(ARM_WAIT_MS);
    await sheet.getByRole("button", { name: "끝내기", exact: true }).click();
    // 소켓이 없으니 REST로 보낸 종료 알림이 고객 화면을 끝낸다
    await expect(cp.getByTestId("cust-ended")).toBeVisible({ timeout: 10_000 });
    expect(hub.broadcasts.some((b) => b.event === "bye" && b.from === 0 && b.topic.endsWith(":e"))).toBe(true);
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
    const rec = await roomRecord();
    expect(rec.status).toBe("ended");
    expect(rec.ended).toEqual([{ duration_sec: expect.any(Number), connected: true }]);
    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});

test("연결 없이 '상담 닫기' → '닫기' (ended connected:false)", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const hub = new RealtimeHub();
  const engCtx = await open(hub, browser, baseURL!, true);
  const ep = await engCtx.newPage();
  const logs = collectErrors([["eng", ep]]);

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await expect(ep.getByTestId("eng-waiting")).toBeVisible();
    await ep.getByRole("button", { name: "상담 닫기" }).click();
    const sheet = ep.getByTestId("eng-close-sheet");
    await expect(sheet).toContainText("상담을 닫을까요?");
    await ep.waitForTimeout(ARM_WAIT_MS);
    await sheet.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
    const rec = await roomRecord();
    expect(rec.status).toBe("ended");
    expect(rec.ended).toEqual([{ duration_sec: expect.any(Number), connected: false }]);
    expect(logs).toEqual([]);
  } finally {
    await engCtx.close();
  }
});

test("연결되기 전에 고객이 '끝내기'를 누르면 상담은 닫히지 않고, 같은 링크로 다시 들어오면 이어진다", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const hub = new RealtimeHub();
  const engCtx = await open(hub, browser, baseURL!, true);
  const custCtx = await open(hub, browser, baseURL!, false);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs = collectErrors([["eng", ep], ["cust", cp]]);

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await expect(ep.getByTestId("eng-waiting")).toBeVisible();
    // 신호가 오가지 않게 붙잡아 '연결하는 중'에 머물게 한다 (둘 다 채널에는 들어와 있다)
    hub.drop.add("offer");
    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님과 연결하는 중…", { timeout: 30_000 });

    await cp.getByRole("button", { name: "통화 종료" }).click();
    await cp.waitForTimeout(ARM_WAIT_MS);
    await cp.getByTestId("cust-end-sheet").getByRole("button", { name: "끝내기", exact: true }).click();
    await expect(cp.getByTestId("cust-ended")).toBeVisible();
    // 기사님 쪽으로 종료 알림(bye)은 갔다
    await expect.poll(() => hub.broadcasts.some((b) => b.event === "bye" && b.topic.endsWith(":c"))).toBe(true);

    // 엔지니어는 계속 기다리고, 상담은 열려 있다
    await ep.waitForTimeout(2000);
    await expect(ep.getByTestId("eng-waiting")).toBeVisible();
    await expect(ep.getByTestId("eng-customer-ended")).toHaveCount(0);
    await expect(ep.getByTestId("eng-closing")).toHaveCount(0);
    const rec = await roomRecord();
    expect(rec.status).not.toBe("ended");
    expect(rec.ended).toEqual([]);

    // 같은 링크를 다시 열면 이어진다
    hub.drop.delete("offer");
    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
    await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});

test("고객 마이크를 못 쓰면 카메라만으로 연결 (camera_granted mic:false, 엔지니어 화면 '고객님 마이크가 꺼져 있어요')", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const hub = new RealtimeHub();
  const engCtx = await open(hub, browser, baseURL!, true);
  const custCtx = await open(hub, browser, baseURL!, false);
  // 전화 통화 중인 폰처럼: 마이크를 달라고 하면 실패, 카메라만은 된다
  await custCtx.addInitScript(() => {
    const md = navigator.mediaDevices;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (c?.audio) throw new DOMException("mic busy", "NotReadableError");
      return original(c);
    };
  });
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs = collectErrors([["eng", ep], ["cust", cp]]);

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
    await expect(ep.getByText(/고객님 마이크가 꺼져 있어요/)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await mockEvents()).find((e) => e.room_id === ROOM.id && e.name === "camera_granted")?.props)
      .toEqual({ mic: false });
    expect(logs).toEqual([]);
  } finally {
    await engCtx.close();
    await custCtx.close();
  }
});
