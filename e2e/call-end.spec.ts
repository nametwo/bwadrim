import { expect, test, type BrowserContextOptions, type Page } from "@playwright/test";
import { CLIPS, FIXTURE, engineerCookie, fakeCamera, mockEvents, mockReset, mockRooms } from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 통화 끝내기 흐름 (ROOM-10·13, JOIN-08·04, 피그마 E03·E04·E10·E11·C18·C19):
//  - 고객이 링크를 열면 엔지니어 대기 화면의 '고객 진행 상황'이 바뀐다
//  - 엔지니어 '종료' → '통화를 끝낼까요?'. '계속 통화하기'면 이어지고, '통화 끝내기'면 결과 기록 → 고른 뒤 '기록하고 끝내기'
//  - 고객 '통화 종료' → 확인 창. '계속하기'면 이어지고, 끝낸 뒤 '잘못 눌렀어요 · 다시 연결'로 탭 한 번에 되돌아온다
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

test("끝내기: 엔지니어 해결 여부 창·계속하기 · 고객 확인 창 · 잘못 끝내면 탭 한 번에 다시 연결 · 답하면 저장", async ({
  browser,
  baseURL,
}) => {
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

    // 3) 고객이 끝내면 엔지니어는 결과 기록 화면. 고객이 '다시 연결'을 누르면 탭 한 번에 통화로 돌아온다
    await cp.getByRole("button", { name: "통화 종료" }).click();
    await cp.waitForTimeout(ARM_WAIT_MS);
    await custSheet.getByRole("button", { name: "끝내기", exact: true }).click();
    await expect(cp.getByTestId("cust-ended")).toBeVisible();
    await expect(ep.getByTestId("eng-record")).toContainText("고객님이 통화를 끝냈어요", { timeout: 10_000 });
    await cp.getByRole("button", { name: /다시 연결/ }).click();
    await connected();
    await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중", { timeout: 30_000 });

    // 4) 엔지니어 '통화 끝내기' → 결과 기록(E11): 고르기 전에는 '기록하고 끝내기'가 잠겨 있고, 고른 답은 바꿀 수 있다
    await ep.getByRole("button", { name: "종료", exact: true }).click();
    await ep.waitForTimeout(ARM_WAIT_MS);
    await ep.getByTestId("eng-end-sheet").getByRole("button", { name: "통화 끝내기" }).click();
    await expect(cp.getByTestId("cust-ended")).toBeVisible({ timeout: 10_000 });
    const record = ep.getByTestId("eng-record");
    await expect(record).toBeVisible();
    await expect(record).toContainText("통화 시간");
    const submit = record.getByRole("button", { name: "기록하고 끝내기" });
    await expect(submit).toBeDisabled();
    await record.getByRole("radio", { name: /방문이 필요/ }).click();
    await record.getByRole("radio", { name: /원격으로 해결/ }).click();
    await expect(record.getByRole("radio", { name: /원격으로 해결/ })).toHaveAttribute("aria-checked", "true");
    await submit.click();
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
    await expect(cp.getByRole("button", { name: /다시 연결/ })).toHaveCount(0);
    const room = (await mockRooms()).find((r) => r.id === ROOM.id);
    expect(room?.status).toBe("ended");
    expect(room?.resolved_remotely).toBe(true);
    const names = (await mockEvents()).filter((e) => e.room_id === ROOM.id).map((e) => e.name);
    expect(names).toContain("ended");
    expect(names).toContain("resolved_remotely");

    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});

test("고객 마이크를 못 쓰면 카메라만으로 연결 (camera_granted mic:false, 엔지니어 화면 '고객 마이크 없음')", async ({
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
    await expect(ep.getByText(/고객 마이크 없음/)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await mockEvents()).find((e) => e.room_id === ROOM.id && e.name === "camera_granted")?.props)
      .toEqual({ mic: false });
    expect(logs).toEqual([]);
  } finally {
    await engCtx.close();
    await custCtx.close();
  }
});
