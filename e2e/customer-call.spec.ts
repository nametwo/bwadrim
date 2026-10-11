import { expect, test, type Page } from "@playwright/test";
import { CLIPS, FIXTURE, fakeCamera } from "./helpers";
import { setFlip, setPeerState } from "./screens/browser-hooks";
import { Rig, customerJoin, connected, engineerReady, open } from "./screens/rig";

// 고객 통화 화면 (JOIN-02·04·06·07·08·09·11):
//  - 카메라를 허용하면 연결 준비(TURN 조회)를 기다리지 않고 바로 내 카메라와 '기다리는 중'이 뜬다. '허용' 안내는 남지 않는다
//  - '통화 종료' 확인 창이 뜬 직후(0.6초)의 '계속하기'는 무시한다 (두 번 누른 두 번째 탭)
//  - '이 폰으로 연결'·'다시 연결'은 시작 화면을 다시 거치지 않고 통화 화면에서 다시 붙는다
//  - 카메라 전환이 끝까지 실패해 영상이 꺼지면 '카메라가 꺼졌어요'와 '카메라 다시 켜기'
// 진짜 Supabase 없이 — 다른 통화 테스트와 같은 가짜 서버·가짜 카메라·실제 WebRTC 루프백. 브라우저 조작 손잡이는 화면 카탈로그 것을 쓴다.
// 방은 상담을 끝내지 않는 방향 지시 테스트(call-guide)와 같이 쓴다. 각자 RealtimeHub가 따로라 통화는 섞이지 않고,
// 이 파일은 상담을 끝내거나 가짜 서버 기록을 지우지 않는다(동시에 도는 그쪽 기록을 건드리지 않게)

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[3];
const START = /카메라 켜고 시작하기|카메라 켜는 중/;

function collectErrors(pages: [string, Page][]) {
  const logs: string[] = [];
  for (const [who, p] of pages) p.on("pageerror", (e) => logs.push(`[${who} pageerror] ${e.message}`));
  return logs;
}

// 이 페이지에 시작 화면 버튼이 한 번이라도 다시 그려지면 표시해 둔다
async function watchStartScreen(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __sawStart?: boolean };
    w.__sawStart = false;
    new MutationObserver(() => {
      const buttons = [...document.querySelectorAll("button")];
      if (buttons.some((b) => /카메라 켜고 시작하기|카메라 켜는 중/.test(b.textContent ?? ""))) w.__sawStart = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}
const sawStartScreen = (page: Page) => page.evaluate(() => (window as unknown as { __sawStart?: boolean }).__sawStart);

test("카메라를 허용하면 연결 준비를 기다리지 않고 내 카메라가 바로 뜬다 · '계속하기'는 뜬 직후 0.6초 무시", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const rig = new Rig(browser, baseURL!);
  try {
    const cp = await rig.customer();
    const logs = collectErrors([["cust", cp]]);
    // 느린 망: TURN 조회 응답을 3초 붙잡는다
    let turnAnswered = false;
    await cp.route(/\/api\/turn\?/, async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      turnAnswered = true;
      await route.fallback();
    });

    await open(cp, `/join/${ROOM.join_token}`);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    // 1) 1.5초 안에 내 카메라와 '기다리는 중'. 어두운 '허용' 안내와 시작 화면은 없다 — TURN은 아직 안 왔다
    const video = cp.getByTestId("cust-video");
    await expect(video).toBeVisible({ timeout: 1500 });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.srcObject !== null), { timeout: 1000 }).toBe(true);
    await expect(cp.getByText(/을 눌러 주세요/)).toHaveCount(0);
    await expect(cp.getByRole("button", { name: START })).toHaveCount(0);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…");
    expect(turnAnswered).toBe(false);
    await expect.poll(() => turnAnswered, { timeout: 10_000 }).toBe(true);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…");

    // 2) '통화 종료'를 두 번 누른 것처럼: 창이 뜬 직후(0.6초 안)의 '계속하기'는 무시하고 창이 남는다.
    //    Playwright 클릭은 움직임이 멈출 때까지 기다려 0.6초를 넘길 수 있어서, 페이지 안에서 바로 이어 누른다
    const sheet = cp.getByTestId("cust-end-sheet");
    const quick = await cp.evaluate(async () => {
      const button = (root: ParentNode, text: string) =>
        [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
      const t0 = performance.now();
      button(document, "통화 종료")!.click();
      let s: Element | null = null;
      for (let i = 0; i < 50 && !(s = document.querySelector('[data-testid="cust-end-sheet"]')); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      button(s!, "계속하기")!.click();
      return performance.now() - t0;
    });
    expect(quick).toBeLessThan(600);
    await expect(sheet).toBeVisible();
    await cp.waitForTimeout(300);
    await expect(sheet).toBeVisible();
    // 조금 지나서 누르면 닫힌다
    await cp.waitForTimeout(400);
    await sheet.getByRole("button", { name: "계속하기" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…");

    expect(logs).toEqual([]);
  } finally {
    await rig.close();
  }
});

test("다른 폰이 이어받은 뒤 '이 폰으로 연결'은 시작 화면 없이 통화 화면에서 다시 붙는다 (JOIN-11)", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const rig = new Rig(browser, baseURL!);
  try {
    const first = await rig.customer();
    const second = await rig.customer();
    const logs = collectErrors([["first", first], ["second", second]]);

    await customerJoin(first, ROOM.join_token);
    await expect(first.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…", { timeout: 15_000 });
    await customerJoin(second, ROOM.join_token);
    const replaced = first.getByTestId("cust-replaced");
    await expect(replaced).toBeVisible({ timeout: 20_000 });
    await expect(replaced).toContainText("이 폰으로 계속하시려면 ‘이 폰으로 연결’을 눌러 주세요.");

    // 누가 더 늦게 들어왔는지는 서버 시각(Date 헤더, 초 단위)으로 가린다 — 1초 안에 다시 들어오면 순서가 뒤집힐 수 있어 조금 기다린다
    await first.waitForTimeout(1500);
    await watchStartScreen(first);
    await replaced.getByRole("button", { name: "이 폰으로 연결" }).click();
    await expect(first.getByTestId("cust-video")).toBeVisible();
    await expect(first.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…");
    await expect.poll(() => first.getByTestId("cust-video").evaluate((v: HTMLVideoElement) => v.srcObject !== null)).toBe(true);
    // 이번엔 먼저 쓰던 폰이 다시 가져갔다
    await expect(second.getByTestId("cust-replaced")).toBeVisible({ timeout: 20_000 });
    expect(await sawStartScreen(first)).toBe(false);
    await expect(first.getByRole("button", { name: START })).toHaveCount(0);

    expect(logs).toEqual([]);
  } finally {
    await rig.close();
  }
});

test("연결이 끊긴 뒤 '다시 연결'은 시작 화면 없이 기사님과 다시 이어진다 (JOIN-09)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const rig = new Rig(browser, baseURL!);
  try {
    const ep = await rig.engineer();
    const cp = await rig.customer();
    const logs = collectErrors([["eng", ep], ["cust", cp]]);

    await engineerReady(ep, ROOM.id);
    await customerJoin(cp, ROOM.join_token);
    await connected(ep, cp);

    // 브라우저가 연결을 '완전 실패'로 판정한 척
    await setPeerState(cp, "failed");
    const failed = cp.getByTestId("cust-failed");
    await expect(failed).toBeVisible({ timeout: 10_000 });
    await expect(failed).toContainText("‘다시 연결’을 눌러 주세요.");

    await watchStartScreen(cp);
    await failed.getByRole("button", { name: "다시 연결" }).click();
    await expect(cp.getByTestId("cust-video")).toBeVisible();
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
    expect(await sawStartScreen(cp)).toBe(false);

    expect(logs).toEqual([]);
  } finally {
    await rig.close();
  }
});

test("카메라 전환이 끝까지 실패하면 '카메라가 꺼졌어요' → '카메라 다시 켜기'로 되살린다 (JOIN-07)", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const rig = new Rig(browser, baseURL!);
  try {
    const cp = await rig.customer();
    const logs = collectErrors([["cust", cp]]);
    await customerJoin(cp, ROOM.join_token);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…", { timeout: 15_000 });

    // 새 카메라·원래 카메라·아무 카메라 모두 못 연다 + 처음 '카메라 다시 켜기'도 실패
    await setFlip(cp, { fails: 5 });
    await cp.getByRole("button", { name: "카메라 바꾸기" }).click();
    const lost = cp.getByTestId("cust-camera-lost");
    await expect(lost).toBeVisible({ timeout: 10_000 });
    await expect(lost).toContainText("카메라가 꺼졌어요");
    await expect(lost).toContainText("‘카메라 다시 켜기’를 눌러 주세요.");
    const live = () =>
      cp.getByTestId("cust-video").evaluate((v: HTMLVideoElement) =>
        ((v.srcObject as MediaStream | null)?.getVideoTracks() ?? []).some((t) => t.readyState === "live"),
      );
    expect(await live()).toBe(false);

    await lost.getByRole("button", { name: "카메라 다시 켜기" }).click();
    await expect(lost).toContainText("카메라를 켜지 못했어요.");
    await lost.getByRole("button", { name: "카메라 다시 켜기" }).click();
    await expect(lost).toHaveCount(0);
    await expect.poll(live).toBe(true);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…");

    expect(logs).toEqual([]);
  } finally {
    await rig.close();
  }
});
