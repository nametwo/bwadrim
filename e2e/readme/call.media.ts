import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLIPS, fakeCamera, mockReset } from "../helpers";
import { ROOM, center, connected, customerJoin, engineerReady, finger, open, padCenter, useRig } from "../screens/rig";

// README 움짤 (npm run readme:media): 엔지니어 폰·고객 폰 두 화면을 CDP screencast로 같이 녹화해
// test-results/readme/<장면>/{eng,cust}/<시각>.jpg 로 남긴다. 합치기는 scripts/readme-media/make-gif.py
// 서버·가짜 카메라·가짜 Supabase는 화면 카탈로그와 같다.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });

const OUT = path.join("test-results", "readme");

/** 페이지 화면을 프레임마다 jpg로 떨군다. 돌려준 함수를 부르면 멈춘다 */
async function record(page: Page, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    const t = Math.round((f.metadata.timestamp ?? Date.now() / 1000) * 1000);
    fs.writeFileSync(path.join(dir, `${t}.jpg`), Buffer.from(f.data, "base64"));
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  };
}

/** next dev 왼쪽 아래 'N' 표시를 가린다 (README용 화면이라) */
async function hideDevIndicator(...pages: Page[]) {
  for (const page of pages) {
    await page.context().addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style");
        s.textContent = "nextjs-portal{display:none!important}";
        document.head.appendChild(s);
      });
    });
  }
}

async function recordBoth(scene: string, ep: Page, cp: Page) {
  const dir = path.join(OUT, scene);
  fs.rmSync(dir, { recursive: true, force: true });
  const stops = [await record(ep, path.join(dir, "eng")), await record(cp, path.join(dir, "cust"))];
  return async () => {
    for (const s of stops) await s();
  };
}

/** 누르고 있는 동안만 고객 화면에 화살표 (CALL-15) */
async function hold(ep: Page, x: number, y: number, ms: number) {
  const f = await finger(ep);
  await f.down(x, y);
  await ep.waitForTimeout(ms);
  await f.up();
}

test.beforeEach(async () => {
  await mockReset();
});

test("고객이 링크를 열고 연결되기까지", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const cp = await rig.customer();
    await hideDevIndicator(ep, cp);
    await engineerReady(ep);
    await open(cp, "about:blank");
    const stop = await recordBoth("join", ep, cp);
    await ep.waitForTimeout(1200);
    await open(cp, `/join/${ROOM.join_token}`);
    await cp.waitForTimeout(2200);
    await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
    await connected(ep, cp);
    await ep.waitForTimeout(3000);
    await stop();
  });
});

test("통화 중 도구: 포인터·방향 지시·멈추고 그리기", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const cp = await rig.customer();
    await hideDevIndicator(ep, cp);
    await engineerReady(ep);
    await customerJoin(cp);
    await connected(ep, cp);
    // 연결 직후 안내가 사라질 때까지
    await cp.waitForTimeout(3000);
    await ep.getByRole("button", { name: /알겠어요|닫기/ }).click({ timeout: 1000 }).catch(() => {});

    const stop = await recordBoth("tools", ep, cp);
    const v = await center(ep, "eng-video");
    await ep.waitForTimeout(800);

    // 톡 = 레이저 포인터 (CALL-08)
    await ep.touchscreen.tap(v.x - v.w * 0.15, v.y - v.h * 0.12);
    await expect(cp.getByTestId("pointer-marker")).toBeVisible({ timeout: 5_000 });
    await ep.waitForTimeout(1600);
    await ep.touchscreen.tap(v.x + v.w * 0.18, v.y + v.h * 0.05);
    await ep.waitForTimeout(2200);

    // 방향 링을 누르고 있는 동안만 (CALL-15)
    const p = await padCenter(ep);
    await hold(ep, p.x + 70, p.y, 2000);
    await ep.waitForTimeout(500);
    await hold(ep, p.x, p.y - 70, 2000);
    await ep.waitForTimeout(800);

    // 멈추고 그리기 (CALL-09)
    await ep.getByRole("button", { name: "멈추고 그리기" }).click();
    await expect(cp.getByTestId("cust-status")).toHaveText("화면을 멈추고 설명하고 있어요", { timeout: 10_000 });
    await ep.waitForTimeout(700);
    const s = await center(ep, "eng-stage");
    const f = await finger(ep);
    const n = 28;
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / (n - 1)) * Math.PI * 2.1;
      return { x: s.x + Math.cos(a) * s.w * 0.22, y: s.y - s.h * 0.05 + Math.sin(a) * s.h * 0.1 };
    });
    await f.down(pts[0].x, pts[0].y);
    for (const q of pts.slice(1)) {
      await f.move(q.x, q.y);
      await ep.waitForTimeout(35);
    }
    await f.up();
    await ep.waitForTimeout(2500);
    await stop();
  });
});
