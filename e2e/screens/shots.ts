import path from "node:path";
import { test, type Page } from "@playwright/test";
import { ROOT } from "../helpers";

// 화면 카탈로그: 찍은 화면을 기록한다. 이미지는 screens/img/에, 설명은 테스트 첨부('screen')로 남기고
// 리포터(reporter.ts)가 모아서 screens/index.html 한 장으로 만든다.

export const OUT_DIR = path.join(ROOT, "screens");

/** 카탈로그 목차 (이 순서로 보인다) */
export const SECTIONS = [
  ["home", "첫 화면·로그인"],
  ["dashboard", "대시보드·통계"],
  ["room", "세션 화면 — 고객 부르기"],
  ["join", "고객 진입"],
  ["call", "통화 연결"],
  ["tools", "통화 도구"],
  ["camera", "고객 카메라 원격 조작"],
  ["pin", "AR 핀 상태"],
  ["end", "종료·실패·이어받기"],
  ["pc", "엔지니어 PC"],
  ["lab", "실험실"],
] as const;

export type Section = (typeof SECTIONS)[number][0];

export interface ShotMeta {
  section: Section;
  /** 요구사항 ID (docs/requirements.md) */
  ids: string[];
  title: string;
  note?: string;
}

export interface Frame {
  label: string;
  page: Page;
  /** 기본 true: 스크롤 아래까지 전부. false = 지금 보이는 창만 (누르는 중처럼 창 크기를 바꾸면 안 될 때) */
  fullPage?: boolean;
}

export interface ShotImage {
  label: string;
  file: string;
  /** CSS 픽셀 폭 — 카탈로그에서 이 비율로 줄여 보인다 */
  width: number;
}

export interface ShotRecord extends ShotMeta {
  images?: ShotImage[];
  /** 못 찍었으면 이유 */
  missing?: string;
}

let seq = 0;

// 개발 모드 표시(왼쪽 아래 N 배지·오류 창)는 앱 화면이 아니므로 가린다
const HIDE_DEV_UI = "nextjs-portal { display: none !important; }";

async function record(r: ShotRecord) {
  await test.info().attach("screen", { body: JSON.stringify(r), contentType: "application/json" });
}

/**
 * 한 화면을 찍는다. 스크롤해야 보이는 긴 화면은 창을 페이지 높이만큼 늘려서 찍는다 —
 * Playwright의 fullPage는 아래에 붙은 버튼(BottomCta)을 원래 창 높이 자리(페이지 가운데)에 찍기 때문
 */
async function snap(f: Frame, file: string) {
  const { page } = f;
  const opts = { path: path.join(OUT_DIR, file), type: "jpeg", quality: 85, caret: "hide", style: HIDE_DEV_UI } as const;
  const vp = page.viewportSize();
  if (f.fullPage === false || !vp) return page.screenshot(opts);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  if (h <= vp.height) return page.screenshot(opts);
  await page.setViewportSize({ width: vp.width, height: h });
  try {
    await page.waitForTimeout(150);
    return await page.screenshot(opts);
  } finally {
    await page.setViewportSize(vp);
  }
}

async function capture(meta: ShotMeta, frames: Frame[]) {
  // testId 앞부분은 파일마다 같아서 뒷부분(테스트별)을 쓴다
  const prefix = `${test.info().testId.split("-").pop()!.slice(0, 10)}-${String(++seq).padStart(3, "0")}`;
  const images = await Promise.all(
    frames.map(async (f, i): Promise<ShotImage> => {
      const file = `img/${prefix}-${i}.jpg`;
      await snap(f, file);
      return { label: f.label, file, width: f.page.viewportSize()?.width ?? 390 };
    }),
  );
  await record({ ...meta, images });
}

/**
 * 한 상태를 찍는다: reach()로 그 상태까지 간 다음 돌려준 화면들을 동시에 찍는다.
 * after()는 찍은 뒤(실패해도) 부른다 — 누르고 있는 동안만 보이는 상태에서 손가락·키를 뗄 때.
 * 가는 도중 실패하면 테스트를 멈추지 않고 '못 찍은 상태'로 남긴다 (카탈로그 맨 아래에 이유와 함께).
 */
export async function shot(
  meta: ShotMeta,
  reach: () => Promise<Frame[]>,
  after?: () => Promise<unknown>,
): Promise<boolean> {
  return test.step(`[${meta.ids.join(",")}] ${meta.title}`, async () => {
    try {
      const frames = await reach();
      await capture(meta, frames);
      return true;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, "");
      await record({ ...meta, missing: msg.split("\n").slice(0, 3).join(" ").slice(0, 300) });
      return false;
    } finally {
      await after?.().catch(() => {});
    }
  });
}

/** 이 환경에서는 만들 수 없는 상태 — 이유만 남긴다 */
export async function unreachable(meta: ShotMeta, reason: string) {
  await record({ ...meta, missing: reason });
}
