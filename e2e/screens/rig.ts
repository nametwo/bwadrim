import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { FIXTURE, SUPABASE_URL, engineerCookie } from "../helpers";
import { RealtimeHub } from "../realtime-mock";
import { installHooks } from "./browser-hooks";
import type { Frame } from "./shots";

// 화면 카탈로그 공용: 엔지니어·고객 브라우저 준비, 통화 연결, 손가락 조작.

export const ROOM = FIXTURE.rooms[0];
export const EXPIRED = FIXTURE.rooms[1];

export const UA = {
  android:
    "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  kakao:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0",
  naver:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.6.3)",
};

export const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ["camera", "microphone"],
};
/** 엔지니어 폰: 안드로이드 크롬으로 보여야 '문자로 링크 보내기'가 뜬다 (ROOM-06, 문자 앱이 있는 기기만) */
export const PHONE_ENG: BrowserContextOptions = {
  ...PHONE,
  userAgent: UA.android,
  permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
};
export const PC: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
};


// 카카오 SDK 흉내 (ROOM-14, 카탈로그는 가짜 카카오 키로 띄운다): 진짜 SDK 대신 이것을 내려 준다.
// 카톡 친구 선택 창은 띄우지 않고 보낸 카드를 window.__kakaoSent에 남긴다
const KAKAO_SDK = "https://t1.kakaocdn.net/**";
const KAKAO_STUB = `window.Kakao = {
  _init: false,
  isInitialized() { return this._init; },
  init() { this._init = true; },
  Share: { sendDefault(settings) { window.__kakaoSent = settings; } },
};`;

// ---------- 가짜 서버 조작 ----------

export async function mock(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`mock ${path} ${r.status}`);
}

// ---------- 브라우저 준비 ----------

/** 이 환경엔 TURN 키가 없어 노란 경고(NET-03)가 늘 뜬다 — 카탈로그는 정상 화면으로 찍고, 경고는 따로 한 장 */
export async function hideTurnWarning(ctx: BrowserContext) {
  await ctx.route(/\/api\/turn\?/, async (route) => {
    const res = await route.fetch();
    if (res.status() !== 200) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: { ...(await res.json()), turnError: null } });
  });
}

/** POST(서버 액션)를 붙잡아 '…중' 화면을 찍게 한다. 돌려준 함수를 부르면 보낸다 */
export async function holdPosts(page: Page, pathname: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue();
    },
  );
  return release;
}

export class Rig {
  readonly hub = new RealtimeHub();
  private readonly contexts: BrowserContext[] = [];
  constructor(
    private readonly browser: Browser,
    private readonly baseURL: string,
  ) {}

  /** kakao: 'fail'이면 카카오 SDK를 못 받은 척 (ROOM-14) */
  async engineer(opts: { pc?: boolean; turnWarning?: boolean; kakao?: "fail" } = {}) {
    const ctx = await this.browser.newContext(opts.pc ? PC : PHONE_ENG);
    await ctx.addCookies([engineerCookie(this.baseURL)]);
    await installHooks(ctx, { share: !opts.pc });
    await ctx.route(KAKAO_SDK, (r) => (opts.kakao === "fail" ? r.abort() : r.fulfill({ contentType: "text/javascript", body: KAKAO_STUB })));
    if (!opts.turnWarning) await hideTurnWarning(ctx);
    await this.hub.attach(ctx);
    this.contexts.push(ctx);
    return ctx.newPage();
  }

  /** 고객 폰. 기본은 안드로이드 크롬 (화면이 폰 종류에 따라 조금 다르다: 권한 창 위치, 권한 켜는 방법) */
  async customer(opts: { userAgent?: string } = {}) {
    const ctx = await this.browser.newContext({ ...PHONE, userAgent: opts.userAgent ?? UA.android });
    await installHooks(ctx, { torch: true });
    await hideTurnWarning(ctx);
    await this.hub.attach(ctx);
    this.contexts.push(ctx);
    return ctx.newPage();
  }

  /** 로그인 안 한 브라우저 */
  async visitor(pc = false) {
    const ctx = await this.browser.newContext(pc ? PC : PHONE);
    this.contexts.push(ctx);
    return ctx.newPage();
  }

  async close() {
    for (const c of this.contexts) await c.close().catch(() => {});
  }
}

export async function useRig(browser: Browser, baseURL: string | undefined, fn: (rig: Rig) => Promise<void>) {
  const rig = new Rig(browser, baseURL!);
  try {
    await fn(rig);
  } finally {
    await rig.close();
  }
}

// ---------- 통화 조작 ----------

/** 열고 JS가 붙을 때까지 기다린다 — 그 전에 누르면 버튼이 반응하지 않아 다음 상태로 안 넘어간다 */
export async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

export async function engineerReady(ep: Page, roomId = ROOM.id) {
  await open(ep, `/room/${roomId}`);
  // '마이크 켜고 연결 준비', 연결된 적 있는 상담이면 '마이크 켜고 다시 연결'
  await ep.getByRole("button", { name: /마이크 켜고/ }).click({ timeout: 30_000 });
  // 링크 보내기·고객 기다리는 화면, 또는 고객이 이미 와 있으면 바로 영상 자리
  await expect(ep.getByTestId("eng-waiting").or(ep.getByTestId("eng-stage"))).toBeVisible({ timeout: 30_000 });
}

export async function customerJoin(cp: Page, token = ROOM.join_token) {
  await open(cp, `/join/${token}`);
  await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click({ timeout: 30_000 });
}

export async function connected(ep: Page, cp: Page) {
  const video = ep.getByTestId("eng-video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
  await ep.waitForTimeout(500); // 영상 첫 프레임이 그려질 시간
}

export async function connect(rig: Rig, opts: { pc?: boolean } = {}) {
  const ep = await rig.engineer(opts);
  const cp = await rig.customer();
  await engineerReady(ep);
  await customerJoin(cp);
  await connected(ep, cp);
  return { ep, cp };
}

export type Touch = { down(x: number, y: number): Promise<void>; move(x: number, y: number): Promise<void>; up(): Promise<void> };

export async function finger(page: Page): Promise<Touch> {
  // 누른 채 유지·이동: CDP로 손가락을 직접 내리고 올린다 (touchscreen.tap은 바로 뗀다)
  const cdp = await page.context().newCDPSession(page);
  return {
    down: async (x, y) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    },
    move: async (x, y) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    },
    up: async () => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    },
  };
}

export async function center(page: Page, testId: string) {
  const el = page.getByTestId(testId);
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
}

/** 방향 링(CALL-15)의 가운데. 상하좌우 팔은 가운데에서 70px */
export async function padCenter(ep: Page) {
  const pad = ep.getByRole("group", { name: /방향 링/ });
  await expect(pad).toBeVisible({ timeout: 10_000 });
  await pad.scrollIntoViewIfNeeded();
  const b = (await pad.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** 링 아래 가까이·멀리 알약: 오른쪽 반 = 가까이, 왼쪽 반 = 멀리 */
export async function zoomPill(ep: Page) {
  const pill = ep.getByRole("group", { name: /가까이·멀리/ });
  await expect(pill).toBeVisible({ timeout: 10_000 });
  const b = (await pill.boundingBox())!;
  return { closer: { x: b.x + b.width * 0.75, y: b.y + b.height / 2 }, farther: { x: b.x + b.width * 0.25, y: b.y + b.height / 2 } };
}

export async function longPress(ep: Page, x: number, y: number) {
  const f = await finger(ep);
  await f.down(x, y);
  await ep.waitForTimeout(800);
  await f.up();
}

export const eng = (page: Page): Frame => ({ label: "엔지니어 폰", page });
export const engPc = (page: Page): Frame => ({ label: "엔지니어 PC", page });
export const cust = (page: Page, label = "고객 폰"): Frame => ({ label, page });

