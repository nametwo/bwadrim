import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

// E2E 공용: 가짜 카메라(벤치 y4m) · AR 핀 오버레이 빨간 픽셀 세기 · 가짜 Supabase.

export const ROOT = path.resolve(__dirname, "..");
export const Y4M_DIR = path.join(ROOT, "scripts/tracking-bench/.cache/y4m");

export interface Fixture {
  supabasePort: number;
  anonKey: string;
  serviceKey: string;
  /** 가짜 카카오 대표 어드민 키 — e2e 서버의 KAKAO_ADMIN_KEY (playwright.config.ts) */
  kakaoAdminKey: string;
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string } & Record<string, unknown>;
  rooms: { id: string; code: string; join_token: string; status: string; expired?: boolean }[];
}
export const FIXTURE: Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));
export const SUPABASE_PORT = Number(process.env.E2E_SUPABASE_PORT ?? FIXTURE.supabasePort);
export const SUPABASE_URL = `http://127.0.0.1:${SUPABASE_PORT}`;

export const CLIPS = {
  jitter: "jitter_mild_pos_480x640",
  reentry: "reentry_pos_480x640",
} as const;

export function y4mPath(name: string): string {
  return path.join(Y4M_DIR, `${name}.y4m`);
}

export interface FrameGT {
  i: number;
  t: number;
  pin: { x: number; y: number };
  inFrame: boolean;
  occluded: boolean;
  H: number[];
}
export interface ClipGT {
  width: number;
  height: number;
  frames: number;
  frameGT: FrameGT[];
}

export function loadGt(name: string): ClipGT {
  return JSON.parse(fs.readFileSync(path.join(Y4M_DIR, `${name}.json`), "utf8"));
}

/** Chromium 가짜 카메라 인자 */
export function fakeCamera(name: string) {
  return {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${y4mPath(name)}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  };
}

export function redPixels(page: Page, paneTestId: string | null, css?: { x: number; y: number; r: number }) {
  return page.evaluate(
    ({ paneTestId, css }) => {
      const sel = paneTestId ? `[data-testid=${paneTestId}] canvas.anchor-overlay` : "canvas.anchor-overlay";
      const c = document.querySelector<HTMLCanvasElement>(sel);
      if (!c) return -1;
      const ctx = c.getContext("2d")!;
      const dpr = c.width / c.getBoundingClientRect().width;
      let x0 = 0;
      let y0 = 0;
      let w = c.width;
      let h = c.height;
      if (css) {
        x0 = Math.max(0, Math.floor((css.x - css.r) * dpr));
        y0 = Math.max(0, Math.floor((css.y - css.r) * dpr));
        w = Math.min(c.width - x0, Math.ceil(2 * css.r * dpr));
        h = Math.min(c.height - y0, Math.ceil(2 * css.r * dpr));
      }
      if (w <= 0 || h <= 0) return 0;
      const d = ctx.getImageData(x0, y0, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 150 && d[i] > 200 && d[i + 1] < 110 && d[i + 2] < 110) n++;
      return n;
    },
    { paneTestId, css },
  );
}

export interface MockEvent {
  room_id: string;
  actor: string;
  name: string;
  props: Record<string, unknown>;
  at: number;
}

export async function mockEvents(): Promise<MockEvent[]> {
  const r = await fetch(`${SUPABASE_URL}/__events`);
  return (await r.json()) as MockEvent[];
}

/** roomId를 주면 그 방만 되돌린다 (다른 테스트 파일과 동시에 돌 때 서로의 방·기록을 지우지 않게) */
export async function mockReset(roomId?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/__reset${roomId ? `?room=${roomId}` : ""}`, { method: "POST" });
}

export async function mockRooms(): Promise<{ id: string; status: string; resolved_remotely: boolean | null }[]> {
  const r = await fetch(`${SUPABASE_URL}/__rooms`);
  return (await r.json()) as { id: string; status: string; resolved_remotely: boolean | null }[];
}

/** 엔지니어 로그인 세션 쿠키 (@supabase/ssr 형식: base64- + base64url(JSON)) */
export function engineerCookie(baseURL: string) {
  const session = {
    access_token: FIXTURE.accessToken,
    refresh_token: FIXTURE.refreshToken,
    token_type: "bearer",
    expires_in: 3600 * 24 * 365,
    expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
    user: FIXTURE.user,
  };
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  // 저장 키: sb-<호스트 첫 조각>-auth-token (127.0.0.1 → sb-127-auth-token)
  const name = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
  expect(value.length).toBeLessThan(3180); // 쪼개기(chunk) 한도 안
  return { name, value, url: baseURL, sameSite: "Lax" as const };
}

// ---------- 받는 분 이름표 (ROOM-15·16): 카카오 공유 웹훅 흉내 ----------

export interface MockRoom {
  id: string;
  status: string;
  created_at: string;
  kakao_hash: string | null;
  recipient_id: string | null;
}

export interface MockRecipient {
  id: string;
  engineer_id: string;
  label: string;
  kakao_hash: string | null;
  last_sent_at: string;
  created_at: string;
}

export async function mockRoom(id: string): Promise<MockRoom | undefined> {
  const r = await fetch(`${SUPABASE_URL}/__rooms`);
  return ((await r.json()) as MockRoom[]).find((x) => x.id === id);
}

export async function mockRecipients(): Promise<MockRecipient[]> {
  const r = await fetch(`${SUPABASE_URL}/__recipients`);
  return (await r.json()) as MockRecipient[];
}

/** 받는 분 이름표 목록 바꾸기. 빠진 칸(id·engineer_id·시각)은 가짜 서버가 채운다 */
export async function seedRecipients(rows: Partial<MockRecipient>[]): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/__seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipients: rows }),
  });
  if (!r.ok) throw new Error(`seed recipients ${r.status}`);
}

/**
 * 카카오인 척 카톡 공유 웹훅을 보낸다 (POST, 본문 JSON). 돌려주는 값은 응답 상태.
 * adminKey: 기본은 e2e 서버의 가짜 대표 어드민 키, null이면 Authorization 없이
 */
export async function postKakaoWebhook(
  baseURL: string,
  body: Record<string, unknown>,
  { adminKey = FIXTURE.kakaoAdminKey }: { adminKey?: string | null } = {},
): Promise<number> {
  const r = await fetch(new URL("/api/kakao/share-webhook", baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kakao-resource-id": "e2e-resource",
      ...(adminKey ? { authorization: `KakaoAK ${adminKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return r.status;
}
