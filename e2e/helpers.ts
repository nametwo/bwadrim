import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

// E2E 공용: 가짜 카메라(벤치 y4m) · 정답(GT) 계산 · /lab/track 조작 · 가짜 Supabase.

export const ROOT = path.resolve(__dirname, "..");
export const Y4M_DIR = path.join(ROOT, "scripts/tracking-bench/.cache/y4m");

export interface Fixture {
  supabasePort: number;
  anonKey: string;
  serviceKey: string;
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string } & Record<string, unknown>;
  rooms: { id: string; code: string; status: string; expired?: boolean }[];
}
export const FIXTURE: Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));
export const SUPABASE_PORT = Number(process.env.E2E_SUPABASE_PORT ?? FIXTURE.supabasePort);
export const SUPABASE_URL = `http://127.0.0.1:${SUPABASE_PORT}`;

/** 테스트에 쓰는 가짜 카메라 영상 (세로 480x640 = 폰 카메라) */
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

// ───────────────────────── 기하 ─────────────────────────

type M = number[];
export function mul(a: M, b: M): M {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
export function inv(m: M): M {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
export function ap(H: M, p: { x: number; y: number }) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}
export const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
export const pct = (a: number[], q: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN;

// ───────────────────────── /lab/track ─────────────────────────

export interface LabAnchor {
  id: string;
  refWidth: number;
  refHeight: number;
  annotations: ({ id: string; kind: "pin"; p: { x: number; y: number } } | { id: string; kind: "stroke"; points: { x: number; y: number }[] })[];
}
export interface LabLogRow {
  side: "eng" | "cust";
  t: number;
  idx: number | null;
  anchorId: string;
  state: string;
  H: number[] | null;
  reason: string | null;
  frameSize: { width: number; height: number };
  refSize: { width: number; height: number };
}

/** 루프백 실험실을 열고(navigate=false면 지금 페이지에서) 시작 → 두 화면이 연결될 때까지 */
export async function openLoopback(page: Page, query = "", opts: { navigate?: boolean } = {}) {
  if (opts.navigate !== false) await page.goto(`/lab/track?e2e=1&pane=390x844${query}`);
  await page.click("#lab-start");
  await page.waitForFunction(
    () => {
      const v = document.querySelector<HTMLVideoElement>("[data-testid=eng-video]");
      const lab = (window as unknown as { __lab?: { links: { eng: { isOpen(): boolean }; cust: { isOpen(): boolean } }; eng: unknown; cust: unknown } }).__lab;
      return !!v && v.videoWidth > 0 && v.readyState >= 2 && !!lab?.links.eng.isOpen() && !!lab.links.cust.isOpen() && !!lab.eng && !!lab.cust;
    },
    null,
    { timeout: 30_000 },
  );
  // WebRTC 해상도·비트레이트 안정화
  await page.waitForTimeout(1200);
}

/** 엔지니어 화면(원격 영상)에 지금 보이는 프레임 번호 */
export function engFrameIdx(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-testid=eng-video]");
    if (!v || v.readyState < 2) return null;
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 1;
    const x = c.getContext("2d")!;
    x.drawImage(v, 0, v.videoHeight - 3, v.videoWidth, 3, 0, 0, 160, 1);
    const d = x.getImageData(0, 0, 160, 1).data;
    const bit = (i: number) => {
      const k = Math.floor((i + 0.5) * 10) * 4;
      return (d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29) >> 8 > 128;
    };
    if (!bit(0) || bit(15)) return null;
    let n = 0;
    for (let b = 0; b < 14; b++) if (bit(b + 1)) n |= 1 << b;
    return n;
  });
}

/** 엔지니어 화면에 조건을 만족하는 프레임이 보일 때까지 기다린 뒤 그 프레임의 정답 핀 위치(페이지 CSS px) */
export async function waitEngFrame(page: Page, gt: ClipGT, pred: (f: FrameGT) => boolean, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const idx = await engFrameIdx(page);
    const f = idx == null ? null : gt.frameGT[idx % gt.frameGT.length];
    if (f && pred(f)) {
      const r = await page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>("[data-testid=eng-video]")!;
        const b = v.getBoundingClientRect();
        return { l: b.left, t: b.top, w: b.width, h: b.height, vw: v.videoWidth, vh: v.videoHeight };
      });
      const s = Math.min(r.w / r.vw, r.h / r.vh);
      const dw = r.vw * s;
      const dh = r.vh * s;
      return {
        idx: idx!,
        frame: f,
        x: r.l + (r.w - dw) / 2 + f.pin.x * dw,
        y: r.t + (r.h - dh) / 2 + f.pin.y * dh,
      };
    }
    await page.waitForTimeout(8);
  }
  throw new Error("원하는 프레임이 엔지니어 화면에 안 나옴");
}

export interface LabData {
  log: LabLogRow[];
  refs: { t: number; idx: number | null }[];
  events: { t: number; name: string; props: Record<string, unknown> }[];
  engAnchor: LabAnchor | null;
  custAnchor: LabAnchor | null;
}

export function labData(page: Page): Promise<LabData> {
  return page.evaluate(() => {
    const lab = (window as unknown as { __lab: Record<string, any> }).__lab; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      log: lab.recorder.log,
      refs: lab.recorder.refs,
      events: lab.recorder.events,
      engAnchor: lab.eng.getSnapshot().anchor,
      custAnchor: lab.cust.getSnapshot().anchor,
    };
  });
}

export interface PinError {
  t: number;
  idx: number;
  state: string;
  /** 작업 해상도 px. 표시 안 함이면 null */
  err: number | null;
  inFrame: boolean;
  /** 추정·정답 (norm) */
  est: { x: number; y: number } | null;
  gt: { x: number; y: number };
}

/**
 * 앵커의 첫 핀에 대한 프레임별 오차. 정답 = H_i · H_K⁻¹ · q (K = 기준 프레임, q = 핀 norm, 픽셀 중심 규약).
 * GT의 H는 기준(norm) → 프레임 i(norm).
 */
export function pinErrors(gt: ClipGT, data: LabData, side: "eng" | "cust", anchor: LabAnchor, refIdx: number): PinError[] {
  const N = gt.frameGT.length;
  const pin = anchor.annotations.find((a) => a.kind === "pin");
  if (!pin || pin.kind !== "pin") throw new Error("핀 없음");
  const refPx = { x: pin.p.x * anchor.refWidth, y: pin.p.y * anchor.refHeight };
  const q = { x: (refPx.x + 0.5) / anchor.refWidth, y: (refPx.y + 0.5) / anchor.refHeight };
  const HkInv = inv(gt.frameGT[refIdx % N].H);
  const out: PinError[] = [];
  for (const r of data.log) {
    if (r.side !== side || r.anchorId !== anchor.id || r.idx == null) continue;
    const g = gt.frameGT[r.idx % N];
    const e = ap(mul(g.H, HkInv), q);
    let est: { x: number; y: number } | null = null;
    let err: number | null = null;
    if (r.H) {
      const p = ap(r.H, refPx);
      est = { x: (p.x + 0.5) / r.frameSize.width, y: (p.y + 0.5) / r.frameSize.height };
      err = Math.hypot((est.x - e.x) * r.frameSize.width, (est.y - e.y) * r.frameSize.height);
    }
    out.push({ t: r.t, idx: r.idx, state: r.state, err, inFrame: g.inFrame, est, gt: e });
  }
  return out;
}

export function summarize(rows: PinError[]) {
  const shown = rows.filter((r) => r.err != null);
  const errs = shown.map((r) => r.err!);
  const wrong = shown.filter((r) => r.err! > 8 || !r.inFrame).length;
  return {
    updates: rows.length,
    shown: shown.length,
    median: +median(errs).toFixed(2),
    p95: +pct(errs, 0.95).toFixed(2),
    max: errs.length ? +Math.max(...errs).toFixed(2) : NaN,
    wrong,
  };
}

/** 영역 안 빨간(핀·선·화살표 #FF3B30) 픽셀 수. 캔버스 = 패널 안의 오버레이 (패널 id가 null이면 페이지의 첫 오버레이) */
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

/** 고객 화면(cover)에서 norm 점의 CSS 좌표 (고객 영상 요소 기준) */
export function custNormToCss(page: Page, p: { x: number; y: number }) {
  return page.evaluate((p) => {
    const v = document.querySelector<HTMLVideoElement>("[data-testid=cust-video]")!;
    const ew = v.clientWidth;
    const eh = v.clientHeight;
    const s = Math.max(ew / v.videoWidth, eh / v.videoHeight);
    const dw = v.videoWidth * s;
    const dh = v.videoHeight * s;
    return { x: (ew - dw) / 2 + p.x * dw, y: (eh - dh) / 2 + p.y * dh, ew, eh };
  }, p);
}

/** 고객 상태 전이 기록 시작 (window.__trans) */
export async function recordCustomerTransitions(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __lab: Record<string, any>; __trans: { t: number; k: string }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    w.__trans = [];
    let prev = "";
    const tick = () => {
      const s = w.__lab.cust?.getSnapshot();
      if (s) {
        const card = !!document.querySelector("[data-testid=cust-card]");
        const arrow = !!document.querySelector("[data-testid=cust-arrow-text]");
        const k = `${s.update?.state ?? "-"}|card=${card}|arrow=${arrow}`;
        if (k !== prev) {
          w.__trans.push({ t: performance.now(), k });
          prev = k;
        }
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// ───────────────────────── 가짜 Supabase ─────────────────────────

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

export async function mockReset(): Promise<void> {
  await fetch(`${SUPABASE_URL}/__reset`, { method: "POST" });
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

// ───────────────────────── 세션 스냅샷 (실험실) ─────────────────────────

export const custState = (page: Page) =>
  page.evaluate(() => {
    const lab = (window as unknown as { __lab: Record<string, any> }).__lab; // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = lab.cust.getSnapshot();
    return { anchor: s.anchor?.id ?? null, n: s.anchor?.annotations.length ?? 0, state: s.update?.state ?? null, card: s.showCard, arrow: s.arrow };
  });

export const engState = (page: Page) =>
  page.evaluate(() => {
    const lab = (window as unknown as { __lab: Record<string, any> }).__lab; // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = lab.eng.getSnapshot();
    return {
      anchor: s.anchor?.id ?? null,
      kinds: (s.anchor?.annotations ?? []).map((a: { kind: string }) => a.kind),
      state: s.update?.state ?? null,
      customerState: s.customerState,
      trackable: s.trackable,
      frozen: s.frozen,
    };
  });

/**
 * 고객 스냅샷이 조건을 만족하는 순간 고객 미리보기 <video>를 멈춘다 (페이지 안에서 바로 — 짧은 순간도 놓치지 않게).
 * 새 프레임이 없으면 추적 상태가 그대로라 잠깐 뜨는 장면(화살표·카드)을 고정해 검사·촬영할 수 있다.
 *  - arrow: 화면 밖 화살표가 뜬 순간
 *  - lost: 못 찾았고 화살표도 없는 순간 (= 0.8초 뒤 카드가 뜨는 조건)
 *  - pin-center: 핀이 고객 화면 가운데쯤 보이는 순간
 */
export function pauseCustomerWhen(page: Page, what: "arrow" | "lost" | "pin-center", timeoutMs = 20_000) {
  return page.evaluate(
    ({ what, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        const lab = (window as unknown as { __lab: Record<string, any> }).__lab; // eslint-disable-line @typescript-eslint/no-explicit-any
        const v = document.querySelector<HTMLVideoElement>("[data-testid=cust-video]")!;
        const hit = () => {
          const s = lab.cust.getSnapshot();
          const u = s.update;
          if (what === "arrow") return s.arrow;
          if (what === "lost") return !!u && (u.state === "lost" || u.state === "searching") && !s.arrow;
          if (u?.state !== "tracking" || !u.H || !s.anchor) return false;
          const pin = s.anchor.annotations[0];
          const X = pin.p.x * u.refSize.width;
          const Y = pin.p.y * u.refSize.height;
          const w = u.H[6] * X + u.H[7] * Y + u.H[8];
          const fx = (u.H[0] * X + u.H[1] * Y + u.H[2]) / w / u.frameSize.width;
          const fy = (u.H[3] * X + u.H[4] * Y + u.H[5]) / w / u.frameSize.height;
          return fx > 0.4 && fx < 0.6 && fy > 0.4 && fy < 0.65;
        };
        const timer = setTimeout(() => {
          off();
          reject(new Error(`고객 상태 "${what}"가 ${timeoutMs}ms 안에 안 나옴`));
        }, timeoutMs);
        const off = lab.cust.subscribe(() => {
          if (!hit()) return;
          v.pause();
          off();
          clearTimeout(timer);
          resolve();
        });
      }),
    { what, timeoutMs },
  );
}

export async function resumeCustomer(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLVideoElement>("[data-testid=cust-video]")!.play());
}
