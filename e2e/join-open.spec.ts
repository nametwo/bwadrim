import { expect, test, type BrowserContextOptions } from "@playwright/test";
import { FIXTURE, SUPABASE_URL, engineerCookie, mockEvents, mockReset } from "./helpers";

// 고객 링크를 누가 열었나 (DATA-01 link_opened, ROOM-13 진행 상황, JOIN-12·13, BUG-22·23):
//  - 문자·카톡이 링크 미리보기를 만들려고 가져가는 요청(봇 User-Agent)은 link_opened를 남기지 않는다. 미리보기 정보는 그대로 <head>에
//  - 사람 브라우저(앱 안 브라우저 포함)는 남긴다
//  - 이 상담을 만든 엔지니어가 로그인한 채로 열면 고객으로 기록하지 않고 '고객님께 보낸 링크예요'. 고객 화면(카메라 버튼)은 안 나온다.
//    '고객 화면 열어 보기'를 눌러도 기록하지 않는다. 끝났거나 만료된 상담이면 그 상담 화면(ROOM-11)으로
//  - 다른 엔지니어 계정이 열면 고객과 같다
// 진짜 Supabase 없이 가짜 서버(e2e/mock-supabase.mjs)로. 카메라·통화는 켜지 않는다.

test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[8];
const JOIN = `/join/${ROOM.join_token}`;

const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

// 미리보기 봇이 보내는 User-Agent (src/lib/preview-bot.ts 주석의 출처)
const BOTS: Record<string, string> = {
  카카오톡: "kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984",
  아이메시지:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  페이스북: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  라인: "facebookexternalhit/1.1;line-poker/1.0",
  왓츠앱: "WhatsApp/2.23.20.0 A",
  텔레그램: "TelegramBot (like TwitterBot)",
};

// 사람이 쓰는 브라우저 (앱 안 브라우저도 사람이다)
const PEOPLE: Record<string, string> = {
  안드로이드: "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  카톡앱안:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0",
  페이스북앱안:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0]",
};

async function linkOpened() {
  return (await mockEvents()).filter((e) => e.room_id === ROOM.id && e.name === "link_opened");
}

async function patchRoom(patch: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/__patch-room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ROOM.id, ...patch }),
  });
  expect(r.ok).toBe(true);
}

test.beforeEach(async () => {
  await mockReset(ROOM.id);
});

test("미리보기 봇은 link_opened를 남기지 않고, 미리보기 정보는 그대로 받는다", async ({ request }) => {
  for (const [who, ua] of Object.entries(BOTS)) {
    const res = await request.get(JOIN, { headers: { "user-agent": ua } });
    expect(res.status(), who).toBe(200);
    const head = (await res.text()).split("</head>")[0];
    expect(head, `${who}: 미리보기 제목이 <head>에`).toContain('<meta property="og:title" content="봐드림 원격 A/S"/>');
    expect(head, `${who}: 미리보기 설명이 <head>에`).toContain('<meta property="og:description"');
  }
  expect(await linkOpened()).toHaveLength(0);

  // 같은 링크를 사람이 열면 남는다 (앱 안 브라우저면 inapp에 앱 이름)
  for (const ua of Object.values(PEOPLE)) {
    expect((await request.get(JOIN, { headers: { "user-agent": ua } })).status()).toBe(200);
  }
  const opened = await linkOpened();
  expect(opened.map((e) => [e.actor, e.props.inapp])).toEqual([
    ["customer", null],
    ["customer", "kakaotalk"],
    ["customer", "facebook"],
  ]);
});

test("엔지니어가 자기 링크를 열면 고객으로 기록하지 않고 상담 화면으로 안내", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ ...PHONE, userAgent: PEOPLE.안드로이드 });
  await ctx.addCookies([engineerCookie(baseURL!)]);
  const p = await ctx.newPage();
  try {
    await p.goto(JOIN);
    const notice = p.getByTestId("join-owner");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("고객님께 보낸 링크예요");
    // 고객 자리로 들어가는 버튼이 없다 — 진짜 고객을 밀어내지 않는다 (CALL-13)
    await expect(p.getByRole("button", { name: /카메라 켜고 시작하기/ })).toHaveCount(0);
    expect(await linkOpened()).toHaveLength(0);

    await p.getByTestId("join-owner-room").click();
    await expect(p).toHaveURL(new RegExp(`/room/${ROOM.id}$`));
    await expect(p.getByRole("button", { name: /연결 준비/ })).toBeVisible();

    // 자기 폰으로 고객 화면을 시험해 볼 때: 고객 화면이 열리지만 기록하지 않는다
    await p.goto(JOIN);
    await p.getByTestId("join-owner-preview").click();
    await expect(p).toHaveURL(new RegExp(`${JOIN}\\?as=customer$`));
    await expect(p.getByRole("button", { name: /카메라 켜고 시작하기/ })).toBeVisible();
    expect(await linkOpened()).toHaveLength(0);
  } finally {
    await ctx.close();
  }

  // 같은 링크를 로그인 안 한 폰(고객)이 열면 예전처럼 시작 화면과 기록
  const cust = await browser.newContext({ ...PHONE, userAgent: PEOPLE.안드로이드 });
  const cp = await cust.newPage();
  try {
    await cp.goto(JOIN);
    await expect(cp.getByRole("button", { name: /카메라 켜고 시작하기/ })).toBeVisible();
    await expect(cp.getByTestId("join-owner")).toHaveCount(0);
    // ?as=customer가 붙어 있어도 고객은 고객이다 (엔지니어가 열어 본 주소를 그대로 보낸 경우)
    await cp.goto(`${JOIN}?as=customer`);
    await expect(cp.getByRole("button", { name: /카메라 켜고 시작하기/ })).toBeVisible();
    expect((await linkOpened()).map((e) => e.actor)).toEqual(["customer", "customer"]);
  } finally {
    await cust.close();
  }
});

test("끝났거나 만료된 상담 링크를 엔지니어가 열면 그 상담 화면으로", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ ...PHONE, userAgent: PEOPLE.안드로이드 });
  await ctx.addCookies([engineerCookie(baseURL!)]);
  const p = await ctx.newPage();
  const cust = await browser.newContext({ ...PHONE, userAgent: PEOPLE.안드로이드 });
  const cp = await cust.newPage();
  try {
    await patchRoom({ status: "ended", ended_at: new Date().toISOString() });
    await p.goto(JOIN);
    await expect(p).toHaveURL(new RegExp(`/room/${ROOM.id}$`));
    await expect(p.getByTestId("room-closed")).toBeVisible();
    // 고객은 그대로 '상담이 이미 끝났어요'
    await cp.goto(JOIN);
    await expect(cp.getByText("상담이 이미 끝났어요")).toBeVisible();

    await patchRoom({ status: "waiting", ended_at: null, expires_at: new Date(Date.now() - 60_000).toISOString() });
    await p.goto(JOIN);
    await expect(p).toHaveURL(new RegExp(`/room/${ROOM.id}$`));
    await expect(p.getByTestId("room-closed")).toHaveAttribute("data-state", "expired");
    await cp.goto(JOIN);
    await expect(cp.getByText("링크가 만료됐어요")).toBeVisible();
    expect(await linkOpened()).toHaveLength(0);
  } finally {
    await ctx.close();
    await cust.close();
  }
});

test("다른 엔지니어 계정이 열면 고객과 같다", async ({ browser, baseURL }) => {
  await patchRoom({ engineer_id: "e2e00000-0000-4000-8000-0000000000ff" });
  const ctx = await browser.newContext({ ...PHONE, userAgent: PEOPLE.안드로이드 });
  await ctx.addCookies([engineerCookie(baseURL!)]);
  const p = await ctx.newPage();
  try {
    await p.goto(JOIN);
    await expect(p.getByRole("button", { name: /카메라 켜고 시작하기/ })).toBeVisible();
    await expect(p.getByTestId("join-owner")).toHaveCount(0);
    expect((await linkOpened()).map((e) => e.actor)).toEqual(["customer"]);
  } finally {
    await ctx.close();
  }
});
