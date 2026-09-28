import { expect, test, type BrowserContextOptions } from "@playwright/test";
import { CLIPS, FIXTURE, engineerCookie, fakeCamera, mockEvents, mockReset } from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 사진 찍기 (CALL-16): 엔지니어가 누르면 고객 폰이 자기 카메라로 찍어 전용 DataChannel 'photo'로 보낸다.
// 고객 화면에 '기사님이 사진을 찍었어요'. 통화를 끝내면 결과 기록 화면에서 '사진 N장 저장할까요?',
// 저장하지 않고 끝내려 하면 한 번 더 묻는다. 헤드리스 크롬은 파일 공유 창이 없어 다운로드로 저장된다.

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

test("사진 찍기: 고객 폰 원본을 받아 모아 두고, 끝낼 때 저장할지 묻는다 (photo_taken 기록)", async ({ browser, baseURL }) => {
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

    // 3) 통화 끝내기 → 결과 기록에 사진 2장과 저장 질문
    await ep.getByRole("button", { name: "종료", exact: true }).click();
    await ep.waitForTimeout(ARM_WAIT_MS);
    await ep.getByTestId("eng-end-sheet").getByRole("button", { name: "통화 끝내기" }).click();
    const card = ep.getByTestId("eng-photos");
    await expect(card).toContainText("통화 중 찍은 사진 2장");
    const imgs = card.getByRole("img");
    await expect(imgs).toHaveCount(2);
    // 받은 사진이 실제 JPEG로 열린다 (가짜 카메라 세로 480x640 이상)
    const size = await imgs.first().evaluate((el: HTMLImageElement) =>
      el.decode().then(() => [el.naturalWidth, el.naturalHeight]),
    );
    expect(Math.min(...size)).toBeGreaterThanOrEqual(480);

    // 4) 저장하지 않고 '기록하고 끝내기' → 한 번 더 묻는다 → '사진 저장하고 끝내기'로 두 장이 내려받아진다
    await ep.getByRole("radio", { name: /원격으로 해결/ }).click();
    await ep.getByRole("button", { name: "기록하고 끝내기" }).click();
    const sheet = ep.getByTestId("eng-photo-sheet");
    await expect(sheet).toContainText("찍은 사진 2장을 저장할까요?");
    await ep.waitForTimeout(ARM_WAIT_MS);
    const names: string[] = [];
    ep.on("download", (d) => names.push(d.suggestedFilename()));
    await sheet.getByRole("button", { name: "사진 저장하고 끝내기" }).click();
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
