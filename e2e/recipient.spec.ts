import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { kakaoShareArgs } from "../src/lib/kakao-webhook";
import {
  CLIPS,
  FIXTURE,
  SUPABASE_URL,
  engineerCookie,
  fakeCamera,
  mockEvents,
  mockRecipients,
  mockReset,
  mockRoom,
  postKakaoWebhook,
  seedRecipients,
} from "./helpers";
import { RealtimeHub, describeHub } from "./realtime-mock";

// 받는 분 이름표 (ROOM-16, ROOM-15 웹훅, 피그마 E04·ROOM-11·E02):
//  - 카톡 1:1 방으로 간 게 웹훅으로 오면 대기 화면에 '누구에게 보냈나요?' → 저장하면 '받는 분 역삼점'
//  - 같은 분(같은 해시)께 다른 상담을 보내면 묻지 않고 바로 이름이 붙는다
//  - 상담 목록·끝난 상담 화면에도 이름. '고치기'로 바꾸면 그분께 보낸 상담 모두 바뀐다
//  - 서명이 없거나 다른 상담 것·어드민 키가 틀린 웹훅은 아무것도 안 바꾼다. 나와의 채팅·그룹방은 이름을 묻지 않는다
//  - 해시는 보내는 사람·받는 사람 한 쌍마다 하나라 이름표는 엔지니어마다 따로다(다른 엔지니어 이름표는 쓰지 않는다)
// 진짜 카카오 없이: e2e 서버는 카카오 JS 키가 비어 '카톡 보내기' 버튼이 없다(playwright.config.ts).
// 그래서 '링크 복사'로 보낸 상태를 만들고, 카카오가 보냈을 웹훅을 테스트가 가짜 어드민 키로 직접 보낸다.
// 서명(sig)은 서버와 같은 함수(kakaoShareArgs)·같은 키로 만든다 — 진짜로는 서버가 상담 화면에 실어 준 값이다.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
// 이름표는 방이 아니라 엔지니어 것이라 이 파일의 테스트끼리 같은 목록을 쓴다 → 차례로
test.describe.configure({ mode: "serial" });

const [R1, R2, R3] = FIXTURE.rooms.slice(5, 8);
const OTHER_ENGINEER = "e2e00000-0000-4000-8000-000000000002";
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  // '링크 복사'로 보낸 상태를 만든다
  permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
};
// 확인 창이 뜬 직후(0.6초)의 탭은 일부러 무시하므로 조금 기다렸다 누른다
const ARM_WAIT_MS = 700;
// 대기 화면은 3초마다 고객 진행 상황(받는 분 포함)을 읽는다 — 한 번 넘게 기다릴 때
const POLL_MS = 3000;

function sig(roomId: string) {
  return kakaoShareArgs(roomId, FIXTURE.kakaoAdminKey)!.sig;
}

/** 카카오인 척: 이 상담의 카드가 chatType 방(hash)에 갔다고 알린다. sig: 기본은 서버가 만든 것과 같은 서명 */
function sendHook(baseURL: string, roomId: string, chatType: string, hash: string, opts: { sig?: string | null; adminKey?: string | null } = {}) {
  const s = opts.sig === undefined ? sig(roomId) : opts.sig;
  return postKakaoWebhook(
    baseURL,
    { CHAT_TYPE: chatType, HASH_CHAT_ID: hash, room: roomId, ...(s ? { sig: s } : {}) },
    opts.adminKey === undefined ? {} : { adminKey: opts.adminKey },
  );
}

async function engineer(browser: Browser, baseURL: string) {
  const hub = new RealtimeHub();
  const ctx = await browser.newContext(PHONE);
  await ctx.addCookies([engineerCookie(baseURL)]);
  await hub.attach(ctx);
  return { hub, ctx };
}

function collectErrors(pages: [string, Page][]) {
  const logs: string[] = [];
  for (const [who, p] of pages) p.on("pageerror", (e) => logs.push(`[${who} pageerror] ${e.message}`));
  return logs;
}

/** 상담 화면을 열어 연결 준비 → '링크 복사'로 보낸 상태(E04 고객 기다리는 중)까지 */
async function waitingAfterSend(page: Page, roomId: string) {
  await page.goto(`/room/${roomId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /연결 준비/ }).click();
  await expect(page.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "false", { timeout: 30_000 });
  await page.getByTestId("share-copy").click();
  await expect(page.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "true");
}

/** 대기 화면 '상담 닫기' → '닫기' → 상담 목록 */
async function closeRoom(page: Page) {
  await page.getByRole("button", { name: "상담 닫기" }).click();
  const sheet = page.getByTestId("eng-close-sheet");
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(ARM_WAIT_MS);
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
}

/**
 * 받는 분 이름을 적고 저장한다.
 * enter: 폰 키보드의 '완료'(Enter). tap: '저장'을 누른다 — 입력 중에 눌러도 커서가 입력칸에 남아
 * 아래 버튼 자리(BottomCta, BUG-21 처리)가 다시 붙어 '저장'을 덮지 않아야 한다
 */
async function saveName(page: Page, name: string, how: "enter" | "tap") {
  const input = page.getByTestId("recipient-input");
  await input.fill(name);
  await expect(page.getByTestId("recipient-save")).toBeEnabled();
  if (how === "enter") await input.press("Enter");
  else await page.getByTestId("recipient-save").click();
}

/** 상담 목록에서 그 상담 줄 */
const dashRow = (page: Page, roomId: string) => page.locator(`a[href="/room/${roomId}"]`);

test.beforeEach(async () => {
  for (const r of [R1, R2, R3]) await mockReset(r.id);
  await seedRecipients([]);
});

test("처음 보내는 분은 이름을 묻고, 같은 분께 다시 보내면 바로 이름표 · 목록·끝난 상담 화면 · 고치면 모두 바뀜", async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const { hub, ctx } = await engineer(browser, baseURL!);
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const logs = collectErrors([["a", a], ["b", b]]);

  try {
    // 1) 첫 상담: 보낸 뒤 웹훅(형과의 1:1 방)이 오면 '누구에게 보냈나요?'
    await waitingAfterSend(a, R1.id);
    await expect(a.getByTestId("recipient")).toHaveCount(0);
    expect(await sendHook(baseURL!, R1.id, "DirectChat", "h-hyung")).toBe(200);
    const cardA = a.getByTestId("recipient");
    await expect(cardA).toHaveAttribute("data-state", "ask", { timeout: 10_000 });
    await expect(cardA).toContainText("누구에게 보냈나요?");
    await expect(cardA).toContainText("처음 보내는 분이에요. 이름을 적어 두면 다음부터 저절로 나와요.");
    await expect(a.getByTestId("recipient-save")).toBeDisabled();
    expect(await mockRoom(R1.id)).toMatchObject({ kakao_hash: "h-hyung", recipient_id: null });
    await expect
      .poll(async () => (await mockEvents()).filter((e) => e.room_id === R1.id && e.name === "kakao_sent").map((e) => e.props))
      .toEqual([{ chat_type: "DirectChat", hash_chat_id: "h-hyung", resource_id: "e2e-resource" }]);

    await saveName(a, "역삼점", "tap");
    await expect(cardA).toHaveAttribute("data-state", "known");
    await expect(a.getByTestId("recipient-label")).toHaveText("역삼점");
    const [created] = await mockRecipients();
    expect(await mockRecipients()).toEqual([
      expect.objectContaining({ engineer_id: FIXTURE.user.id, label: "역삼점", kakao_hash: "h-hyung" }),
    ]);
    expect((await mockRoom(R1.id))?.recipient_id).toBe(created.id);
    // 다음 확인(3초)에도 그대로
    await a.waitForTimeout(POLL_MS + 500);
    await expect(cardA).toHaveAttribute("data-state", "known");

    // 2) 두 번째 상담을 같은 분께: 묻지 않고 처음부터 '받는 분 역삼점'. 마지막으로 보낸 날이 새로 된다
    await waitingAfterSend(b, R2.id);
    expect(await sendHook(baseURL!, R2.id, "DirectChat", "h-hyung")).toBe(200);
    const cardB = b.getByTestId("recipient");
    await expect(cardB).toBeVisible({ timeout: 10_000 });
    expect(await cardB.getAttribute("data-state")).toBe("known");
    await expect(b.getByTestId("recipient-label")).toHaveText("역삼점");
    expect(await mockRoom(R2.id)).toMatchObject({ kakao_hash: "h-hyung", recipient_id: created.id });
    await expect.poll(async () => (await mockRecipients())[0].last_sent_at > created.last_sent_at).toBe(true);
    expect(await mockRecipients()).toHaveLength(1);

    // 3) 첫 상담을 닫으면 상담 목록: 끝난 상담 첫 줄이 이름, 진행 중인 두 번째 상담 둘째 줄 앞에도 이름
    await closeRoom(a);
    await expect(a.getByTestId("room-label")).toHaveText(["역삼점"]);
    await expect(dashRow(a, R1.id)).toContainText("역삼점");
    await expect(dashRow(a, R2.id)).toContainText("역삼점 · ");

    // 4) 끝난 상담 화면에도 이름표. '고치기' → 바꾼 이름
    await a.goto(`/room/${R1.id}`);
    await expect(a.getByTestId("room-closed")).toBeVisible();
    await expect(cardA).toHaveAttribute("data-state", "known");
    await expect(a.getByTestId("recipient-label")).toHaveText("역삼점");
    await a.waitForLoadState("networkidle");
    await a.getByTestId("recipient-edit").click();
    await expect(cardA).toHaveAttribute("data-state", "edit");
    await expect(cardA).toContainText("받는 분 이름 고치기");
    await expect(cardA).toContainText("이분께 보낸 상담의 이름이 모두 바뀌어요.");
    await expect(a.getByTestId("recipient-input")).toHaveValue("역삼점");
    // '취소'면 그대로
    await cardA.getByRole("button", { name: "취소" }).click();
    await expect(cardA).toHaveAttribute("data-state", "known");
    await expect(a.getByTestId("recipient-label")).toHaveText("역삼점");
    await a.getByTestId("recipient-edit").click();
    await saveName(a, "역삼점 김 사장님", "tap");
    await expect(cardA).toHaveAttribute("data-state", "known");
    await expect(a.getByTestId("recipient-label")).toHaveText("역삼점 김 사장님");
    expect(await mockRecipients()).toEqual([expect.objectContaining({ id: created.id, label: "역삼점 김 사장님" })]);

    // 5) 아직 기다리는 두 번째 상담 화면도 다음 확인 때 따라 바뀐다
    await expect(b.getByTestId("recipient-label")).toHaveText("역삼점 김 사장님", { timeout: 10_000 });

    // 6) 상담 목록도 두 상담 모두 새 이름
    await a.goto("/dashboard");
    await expect(a.getByTestId("room-label")).toHaveText(["역삼점 김 사장님"]);
    await expect(dashRow(a, R2.id)).toContainText("역삼점 김 사장님 · ");

    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await ctx.close();
  }
});

test("이름 없이 닫은 상담은 끝난 화면에서 붙이고, 같은 분께 보낸 이름 없던 다른 상담에도 같이 붙는다", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { hub, ctx } = await engineer(browser, baseURL!);
  const page = await ctx.newPage();
  const logs = collectErrors([["eng", page]]);

  try {
    // 같은 분께 두 상담을 보냈는데 아직 이름이 없다 (두 번째 상담은 화면을 열지도 않았다)
    await waitingAfterSend(page, R1.id);
    expect(await sendHook(baseURL!, R1.id, "DirectChat", "h-boss")).toBe(200);
    expect(await sendHook(baseURL!, R2.id, "DirectChat", "h-boss")).toBe(200);
    await expect(page.getByTestId("recipient")).toHaveAttribute("data-state", "ask", { timeout: 10_000 });
    await expect.poll(async () => (await mockRoom(R2.id))?.kakao_hash).toBe("h-boss");

    // 이름을 안 적고 닫으면 목록은 시각으로
    await closeRoom(page);
    await expect(page.getByTestId("room-label")).toHaveCount(0);

    // 끝난 상담 화면에서 묻는다. 앞뒤·겹친 공백은 줄여서 저장
    await page.goto(`/room/${R1.id}`);
    await expect(page.getByTestId("room-closed")).toBeVisible();
    const card = page.getByTestId("recipient");
    await expect(card).toHaveAttribute("data-state", "ask");
    await page.waitForLoadState("networkidle");
    await saveName(page, "  김   사장님 ", "tap");
    await expect(card).toHaveAttribute("data-state", "known");
    await expect(page.getByTestId("recipient-label")).toHaveText("김 사장님");

    const all = await mockRecipients();
    expect(all).toEqual([expect.objectContaining({ label: "김 사장님", kakao_hash: "h-boss", engineer_id: FIXTURE.user.id })]);
    expect((await mockRoom(R1.id))?.recipient_id).toBe(all[0].id);
    expect((await mockRoom(R2.id))?.recipient_id).toBe(all[0].id);
    // 보관 기간을 재는 '마지막으로 보낸 날'은 이름을 붙인 지금이 아니라 그분께 보낸 상담을 만든 때다 (OPS-06)
    const lastRoom = Math.max(...[await mockRoom(R1.id), await mockRoom(R2.id)].map((r) => Date.parse(r!.created_at)));
    expect(Date.parse(all[0].last_sent_at)).toBe(lastRoom);

    await page.goto("/dashboard");
    await expect(page.getByTestId("room-label")).toHaveText(["김 사장님"]);
    await expect(dashRow(page, R2.id)).toContainText("김 사장님 · ");
    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await ctx.close();
  }
});

test("서명·어드민 키가 틀린 웹훅은 아무것도 안 바꾸고, 나와의 채팅·그룹방·끝난 상담은 이름을 묻지 않으며, 다른 엔지니어 이름표는 쓰지 않는다", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  // 내 이름표(형)와, 같은 카카오 계정을 같이 쓰는 다른 엔지니어의 이름표. 해시가 같아도 엔지니어마다 따로다
  await seedRecipients([
    { label: "역삼점", kakao_hash: "h-hyung" },
    { engineer_id: OTHER_ENGINEER, label: "아빠 가게", kakao_hash: "h-shared" },
  ]);
  const before = await mockRecipients();
  const { hub, ctx } = await engineer(browser, baseURL!);
  const page = await ctx.newPage();
  const logs = collectErrors([["eng", page]]);
  const sent = async () =>
    (await mockEvents()).filter((e) => e.room_id === R3.id && e.name === "kakao_sent").map((e) => e.props.chat_type);

  try {
    await waitingAfterSend(page, R3.id);

    // 카카오가 보낸 게 아니면 401, 서명이 없거나 다른 상담 것이면 200만 (카카오가 웹훅을 끄지 않게)
    expect(await sendHook(baseURL!, R3.id, "DirectChat", "h-hyung", { adminKey: null })).toBe(401);
    expect(await sendHook(baseURL!, R3.id, "DirectChat", "h-hyung", { adminKey: "wrong-key" })).toBe(401);
    expect(await sendHook(baseURL!, R3.id, "DirectChat", "h-hyung", { sig: null })).toBe(200);
    expect(await sendHook(baseURL!, R3.id, "DirectChat", "h-hyung", { sig: sig(R1.id) })).toBe(200);
    expect(await sendHook(baseURL!, R3.id, "DirectChat", "h-hyung", { sig: sig(R3.id).replace(/^./, (c) => (c === "A" ? "B" : "A")) })).toBe(200);

    // 나와의 채팅·그룹방: 기록(kakao_sent)은 남지만 받는 분은 한 사람이 아니라 잇지 않는다
    expect(await sendHook(baseURL!, R3.id, "MemoChat", "h-memo")).toBe(200);
    expect(await sendHook(baseURL!, R3.id, "MultiChat", "h-group")).toBe(200);
    await expect.poll(async () => (await sent()).sort()).toEqual(["MemoChat", "MultiChat"]);
    // 끝난 상담에 늦게 온 1:1 방 알림도 잇지 않는다
    await fetch(`${SUPABASE_URL}/__patch-room`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: R2.id, status: "ended", ended_at: new Date().toISOString() }),
    });
    expect(await sendHook(baseURL!, R2.id, "DirectChat", "h-hyung")).toBe(200);
    await expect
      .poll(async () => (await mockEvents()).some((e) => e.room_id === R2.id && e.name === "kakao_sent"))
      .toBe(true);

    await page.waitForTimeout(POLL_MS + 1000);
    await expect(page.getByTestId("recipient")).toHaveCount(0);
    expect(await mockRoom(R3.id)).toMatchObject({ kakao_hash: null, recipient_id: null });
    expect(await mockRoom(R2.id)).toMatchObject({ kakao_hash: null, recipient_id: null });
    expect(await mockRecipients()).toEqual(before);

    // 다른 엔지니어가 '아빠 가게'로 붙인 해시라도 내 이름표가 아니면 처음 보내는 분으로 묻는다
    expect(await sendHook(baseURL!, R3.id, "DirectChat", "h-shared")).toBe(200);
    const card = page.getByTestId("recipient");
    await expect(card).toHaveAttribute("data-state", "ask", { timeout: 10_000 });
    await expect(card).not.toContainText("아빠 가게");
    await saveName(page, "형", "enter");
    await expect(page.getByTestId("recipient-label")).toHaveText("형");
    const after = await mockRecipients();
    expect(after).toHaveLength(3);
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ engineer_id: OTHER_ENGINEER, label: "아빠 가게", kakao_hash: "h-shared" }),
        expect.objectContaining({ engineer_id: FIXTURE.user.id, label: "형", kakao_hash: "h-shared" }),
        expect.objectContaining({ engineer_id: FIXTURE.user.id, label: "역삼점", kakao_hash: "h-hyung" }),
      ]),
    );
    const mine = after.find((r) => r.engineer_id === FIXTURE.user.id && r.kakao_hash === "h-shared")!;
    expect((await mockRoom(R3.id))?.recipient_id).toBe(mine.id);
    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await ctx.close();
  }
});

test("여러 명을 한 번에 고르면 받는 분을 정하지 않고 묻지 않는다 · 새로고침해도 받는 분 카드가 남는다", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { hub, ctx } = await engineer(browser, baseURL!);
  const page = await ctx.newPage();
  const logs = collectErrors([["eng", page]]);

  try {
    // 1) 처음 보내는 분 → 묻는 칸. 새로고침해 이 화면에서 누른 기록이 없어도 '보낸 뒤' 화면과 카드가 그대로
    await waitingAfterSend(page, R1.id);
    expect(await sendHook(baseURL!, R1.id, "DirectChat", "h-only")).toBe(200);
    await expect(page.getByTestId("recipient")).toHaveAttribute("data-state", "ask", { timeout: 10_000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /연결 준비/ }).click();
    await expect(page.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "true", { timeout: 30_000 });
    await expect(page.getByTestId("recipient")).toHaveAttribute("data-state", "ask", { timeout: 10_000 });
    await expect(page.getByTestId("eng-progress")).toContainText("카톡을 보냈어요");

    // 2) 같은 상담으로 형과 여동생을 한 번에 골라 보냄(웹훅이 거의 동시에 둘) → 받는 분을 비우고 카드를 내린다
    await seedRecipients([{ label: "형", kakao_hash: "h-hyung" }]);
    const results = await Promise.all([
      sendHook(baseURL!, R2.id, "DirectChat", "h-hyung"),
      sendHook(baseURL!, R2.id, "DirectChat", "h-sister"),
    ]);
    expect(results).toEqual([200, 200]);
    await expect
      .poll(async () => (await mockEvents()).filter((e) => e.room_id === R2.id && e.name === "kakao_sent").length)
      .toBe(2);
    // 기록 뒤에 잇기가 돈다(응답 뒤 after) — 끝날 때까지 기다렸다가 본다. 처음에도 비어 있으니 바로 보면 확인이 안 된다
    await new Promise((r) => setTimeout(r, 2000));
    expect(await mockRoom(R2.id)).toMatchObject({ kakao_hash: null, recipient_id: null });

    await page.goto(`/room/${R2.id}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /연결 준비/ }).click();
    await expect(page.getByTestId("eng-waiting")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(POLL_MS + 1000);
    await expect(page.getByTestId("recipient")).toHaveCount(0);
    // 이름표는 그대로(여동생 해시에 엉뚱한 이름이 생기지 않는다)
    expect(await mockRecipients()).toEqual([expect.objectContaining({ label: "형", kakao_hash: "h-hyung" })]);
    expect(logs).toEqual([]);
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(hub), logs.join("\n"));
    await ctx.close();
  }
});
