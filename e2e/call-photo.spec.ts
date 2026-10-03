import { expect, test, type BrowserContextOptions } from "@playwright/test";
import { CLIPS, FIXTURE, engineerCookie, fakeCamera, mockEvents, mockReset, mockRooms } from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 사진 찍기 (CALL-16): 엔지니어가 누르면 고객 폰이 자기 카메라로 찍어 전용 DataChannel 'photo'로 보낸다.
// 고객 화면에 '기사님이 사진을 찍었어요'. 통화를 끝내면 상담이 먼저 닫히고, 사진이 있으니 '찍은 사진 N장을 저장할까요?'
// 화면이 뜬다. 사진은 서버에 올리지 않는다. 헤드리스 크롬은 파일 공유 창이 없어 다운로드로 저장된다.
// 상담을 닫지 못하면(인터넷 끊김) 실패 화면에서 사진부터 저장할 수 있다 (ROOM-10).

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[4];
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ["camera", "microphone"],
};

// 확인 창이 뜬 직후(0.6초)의 탭은 일부러 무시하므로 조금 기다렸다 누른다
const ARM_WAIT_MS = 700;

test.beforeEach(async () => {
  await mockReset(ROOM.id);
});

test("사진 찍기: 고객 폰 원본을 받아 모아 두고, 상담을 닫은 뒤 저장할지 묻는다 (photo_taken 기록)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const hub = new RealtimeHub();
  const engCtx = await browser.newContext({ ...PHONE, acceptDownloads: true });
  await engCtx.addCookies([engineerCookie(baseURL!)]);
  const custCtx = await browser.newContext(PHONE);
  await hub.attach(engCtx);
  await hub.attach(custCtx);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs: string[] = [];
  for (const [who, p] of [["eng", ep], ["cust", cp]] as const) p.on("pageerror", (e) => logs.push(`[${who}] ${e.message}`));

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });

    // 1) 한 장: 고객 화면에 알림, 엔지니어 버튼에 1
    const shutter = ep.getByTestId("eng-photo");
    await expect(shutter).toBeEnabled({ timeout: 10_000 });
    await shutter.click();
    await expect(cp.getByText("기사님이 사진을 찍었어요")).toBeVisible({ timeout: 10_000 });
    await expect(ep.getByTestId("eng-photo-count")).toHaveText("1", { timeout: 15_000 });
    await expect(ep.getByText(/사진 1장 찍었어요/)).toBeVisible();
    // 2) 두 장
    await expect(shutter).toBeEnabled();
    await shutter.click();
    await expect(ep.getByTestId("eng-photo-count")).toHaveText("2", { timeout: 15_000 });
    await expect
      .poll(async () => (await mockEvents()).filter((e) => e.room_id === ROOM.id).map((e) => e.name))
      .toContain("photo_taken");

    // 3) 통화 끝내기 → 상담이 닫히고 사진 저장 화면 (고객이 끝낸 게 아니라 위쪽 띠는 없다)
    await ep.getByRole("button", { name: "종료", exact: true }).click();
    await ep.waitForTimeout(ARM_WAIT_MS);
    await ep.getByTestId("eng-end-sheet").getByRole("button", { name: "통화 끝내기" }).click();
    const screen = ep.getByTestId("eng-photo-save");
    await expect(screen.getByRole("heading", { level: 1 })).toHaveText(/찍은 사진 2장을\s*저장할까요\?/);
    await expect(screen).toContainText("저장 안 하면 이 화면을 나갈 때 지워져요.");
    await expect(screen.getByRole("status")).toHaveCount(0);
    await expect(cp.getByTestId("cust-ended")).toBeVisible({ timeout: 10_000 });
    expect((await mockRooms()).find((r) => r.id === ROOM.id)?.status).toBe("ended");
    const imgs = ep.getByTestId("eng-photos").getByRole("img");
    await expect(imgs).toHaveCount(2);
    // 받은 사진이 실제 JPEG로 열린다 (가짜 카메라 세로 480x640 이상)
    const size = await imgs.first().evaluate((el: HTMLImageElement) =>
      el.decode().then(() => [el.naturalWidth, el.naturalHeight]),
    );
    expect(Math.min(...size)).toBeGreaterThanOrEqual(480);

    // 4) '사진 2장 저장하기' → 두 장이 내려받아지고 바로 상담 목록으로 (한 번 더 묻지 않는다)
    const names: string[] = [];
    ep.on("download", (d) => names.push(d.suggestedFilename()));
    await screen.getByRole("button", { name: "사진 2장 저장하기" }).click();
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
    await expect.poll(() => names.length).toBe(2);
    expect(names[0]).toMatch(/^bwadrim_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_1\.jpg$/);
    expect(names[1]).toMatch(/_2\.jpg$/);

    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});

test("상담을 끝내지 못해도(인터넷 끊김) 사진은 먼저 저장할 수 있고, '다시 끝내기'는 종료 알림부터 다시 보낸다", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const hub = new RealtimeHub();
  const engCtx = await browser.newContext({ ...PHONE, acceptDownloads: true });
  await engCtx.addCookies([engineerCookie(baseURL!)]);
  const custCtx = await browser.newContext(PHONE);
  await hub.attach(engCtx);
  await hub.attach(custCtx);
  const ep = await engCtx.newPage();
  const cp = await custCtx.newPage();
  const logs: string[] = [];
  for (const [who, p] of [["eng", ep], ["cust", cp]] as const) p.on("pageerror", (e) => logs.push(`[${who}] ${e.message}`));

  try {
    await ep.goto(`/room/${ROOM.id}`);
    await ep.getByRole("button", { name: /연결 준비/ }).click();
    await cp.goto(`/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
    const shutter = ep.getByTestId("eng-photo");
    await expect(shutter).toBeEnabled({ timeout: 10_000 });
    await shutter.click();
    await expect(ep.getByTestId("eng-photo-count")).toHaveText("1", { timeout: 15_000 });
    await expect(shutter).toBeEnabled();

    // 엔지니어 폰 인터넷이 끊긴 척: 상담 닫기(서버 액션) 요청이 실패한다
    const offline = (route: import("@playwright/test").Route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue();
    await ep.route(`**/room/${ROOM.id}`, offline);
    await ep.getByRole("button", { name: "종료", exact: true }).click();
    await ep.waitForTimeout(ARM_WAIT_MS);
    await ep.getByTestId("eng-end-sheet").getByRole("button", { name: "통화 끝내기" }).click();
    const failed = ep.getByTestId("eng-closing");
    await expect(failed).toContainText("상담을 끝내지 못했어요", { timeout: 15_000 });
    await expect(failed).toContainText("인터넷 연결을 확인하고 '다시 끝내기'를 눌러 주세요.");
    await expect(cp.getByTestId("cust-ended")).toBeVisible({ timeout: 10_000 });
    expect((await mockRooms()).find((r) => r.id === ROOM.id)?.status).not.toBe("ended");

    // 사진은 상담이 안 닫혀도 먼저 저장된다
    const names: string[] = [];
    ep.on("download", (d) => names.push(d.suggestedFilename()));
    await failed.getByRole("button", { name: "사진 1장 먼저 저장하기" }).click();
    await expect.poll(() => names.length).toBe(1);
    await expect(failed.getByRole("button", { name: "사진 1장을 저장했어요" })).toBeDisabled();

    // 다시 끝내기: 종료 알림(REST)을 다시 보내고 상담을 닫는다. 사진은 이미 저장했으니 사진 저장 화면 없이 상담 목록으로
    await ep.unroute(`**/room/${ROOM.id}`, offline);
    const restByes = () => hub.broadcasts.filter((b) => b.event === "bye" && b.from === 0).length;
    expect(restByes()).toBe(0);
    await failed.getByRole("button", { name: "다시 끝내기" }).click();
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
    expect(restByes()).toBe(1);
    expect((await mockRooms()).find((r) => r.id === ROOM.id)?.status).toBe("ended");
    expect(names).toHaveLength(1);

    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await engCtx.close();
    await custCtx.close();
  }
});
