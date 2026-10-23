import { expect, test } from "@playwright/test";
import { CLIPS, FIXTURE, SUPABASE_URL, fakeCamera, mockReset } from "./helpers";
import { setPeerState } from "./screens/browser-hooks";
import { connected, customerJoin, engineerReady, useRig } from "./screens/rig";

// 디스코드 알림 (OPS-09). 서버는 가짜 웹훅(가짜 Supabase의 /__discord/{channel}, playwright.config.ts)으로 보내고 여기서 모인 글을 본다.
//  - 일반: 상담 단계마다 한 줄 — 링크 엶(기기), 카메라 켬, 연결됨, 끝남(걸린 시간·쓴 도구). 기사님 이름이 붙는다
//  - 응급: 연결 실패(고객 폰이 failed로 판정), 카메라는 켰는데 연결 없이 끝남
//  - e2e 서버는 TURN 키가 없어 '🚨 TURN 발급 실패'도 올 수 있다(10분에 한 번) — 상담 id가 없는 글이라 여기선 거른다
// 방 12번(a012)은 이 파일 전용

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[11];
const TAG = `상담 ${ROOM.id.slice(0, 8)}`;
const ARM_WAIT_MS = 700;

type Msg = { channel: string; content: string; at: number };

async function discord(channel: "general" | "urgent"): Promise<string[]> {
  const all = (await (await fetch(`${SUPABASE_URL}/__discord`)).json()) as Msg[];
  return all.filter((m) => m.channel === channel && m.content.includes(TAG)).map((m) => m.content);
}

test.beforeEach(async () => {
  await mockReset(ROOM.id);
  await fetch(`${SUPABASE_URL}/__discord`, { method: "DELETE" });
});

test("상담 한 번: 일반 채널에 링크·카메라·연결·끝남이 차례로, 응급에는 아무것도 없다", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const cp = await rig.customer();
    await engineerReady(ep, ROOM.id);
    await customerJoin(cp, ROOM.join_token);
    await connected(ep, cp);

    // 사진 한 장 → 끝날 때 '쓴 도구'에 들어간다
    await expect(ep.getByTestId("eng-photo")).toBeEnabled({ timeout: 15_000 });
    await ep.getByTestId("eng-photo").click();
    await expect(ep.getByTestId("eng-photo-count")).toHaveText("1", { timeout: 15_000 });

    // 고객이 끝낸다 → 연결됐던 상담이라 엔지니어 화면이 상담을 닫는다(ended)
    await cp.getByRole("button", { name: "통화 종료" }).click();
    const sheet = cp.getByTestId("cust-end-sheet");
    await expect(sheet).toBeVisible();
    await cp.waitForTimeout(ARM_WAIT_MS);
    await sheet.getByRole("button", { name: "끝내기", exact: true }).click();
    // 사진이 있어서 '고객님이 통화를 끝냈어요' 안내 대신 사진 저장 화면(위에 같은 띠)이 뜬다 (CALL-16)
    await expect(ep.getByTestId("eng-photo-save").or(ep.getByTestId("eng-customer-ended"))).toBeVisible({ timeout: 15_000 });

    await expect.poll(async () => (await discord("general")).some((m) => m.includes("상담을 끝냈어요")), { timeout: 15_000 }).toBe(true);
    const general = await discord("general");
    const find = (part: string) => general.find((m) => m.includes(part));
    expect(find("고객이 링크를 열었어요")).toContain("(안드로이드 크롬)");
    expect(find("고객이 카메라를 켰어요")).toBeTruthy();
    expect(find("연결됐어요")).toContain("직접 연결");
    expect(find("상담을 끝냈어요")).toMatch(/걸림 · 쓴 도구: 사진/);
    // 기사님 이름(계정 표시 이름)이 붙는다. 차례도 맞다
    for (const m of general) expect(m).toContain(`${TAG} · 김도현`);
    const order = ["링크를 열었어요", "카메라를 켰어요", "연결됐어요", "상담을 끝냈어요"].map((p) => general.findIndex((m) => m.includes(p)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(await discord("urgent")).toEqual([]);
  });
});

test("고객 폰이 연결을 실패로 판정하면 일반·응급 둘 다에 '연결 실패'", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const cp = await rig.customer();
    await engineerReady(ep, ROOM.id);
    await customerJoin(cp, ROOM.join_token);
    await connected(ep, cp);

    await setPeerState(cp, "failed");
    await expect(cp.getByTestId("cust-failed")).toBeVisible({ timeout: 10_000 });

    await expect.poll(async () => (await discord("urgent")).length, { timeout: 15_000 }).toBe(1);
    const [urgent] = await discord("urgent");
    expect(urgent).toContain("🚨 연결 실패");
    expect(urgent).toContain("통화 중에 끊김");
    expect((await discord("general")).some((m) => m.includes("연결에 실패했어요 (통화 중에 끊김)"))).toBe(true);
  });
});

test("카메라는 켰는데 연결 없이 상담을 닫으면 응급", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const cp = await rig.customer();
    // 고객이 청하는 offer를 떨어뜨려 연결되지 않게 한다
    rig.hub.drop.add("offer");
    await customerJoin(cp, ROOM.join_token);
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…", { timeout: 15_000 });
    await engineerReady(ep, ROOM.id);
    await ep.getByRole("button", { name: "상담 닫기" }).click();
    const sheet = ep.getByTestId("eng-close-sheet");
    await expect(sheet).toContainText("상담을 닫을까요?");
    await ep.waitForTimeout(ARM_WAIT_MS);
    await sheet.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(ep).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

    await expect.poll(async () => (await discord("urgent")).length, { timeout: 15_000 }).toBe(1);
    expect((await discord("urgent"))[0]).toContain("🚨 연결 없이 끝남");
    expect((await discord("general")).some((m) => m.includes("상담을 끝냈어요 · 연결 없이"))).toBe(true);
  });
});
