import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CLIPS, custState, fakeCamera, openLoopback } from "./helpers";

// /lab/track의 나머지 모드: (a) 카메라 1대 (엔지니어식 즉시 고정 + HUD), (c) 영상 파일 (단일·루프백).

test.use({ launchOptions: fakeCamera(CLIPS.jitter), viewport: { width: 860, height: 960 }, deviceScaleFactor: 1 });

type Stats = { state: string | null; fps: number; processMs: number; inliers: number; tracked: number };

const singleStats = (page: Page) =>
  page.evaluate(() => {
    const lab = (window as unknown as { __lab: Record<string, any> }).__lab; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { ...lab.recorder.eng.stats, anchor: lab.eng.getSnapshot().anchor?.id ?? null } as Stats & { anchor: string | null };
  });

async function tapCenter(page: Page, testId: string) {
  const b = (await page.getByTestId(testId).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

test("카메라 1대: 탭 → 즉시 고정, HUD에 상태·fps·처리 ms·인라이어", async ({ page }) => {
  await page.goto("/lab/track?e2e=1&mode=single&pane=390x844");
  await expect(page.getByRole("radio", { name: "카메라 1대" })).toHaveAttribute("aria-checked", "true");
  // 버튼을 누르기 전에는 카메라를 켜지 않는다
  expect(await page.evaluate(() => document.querySelectorAll("video").length)).toBe(0);
  await page.click("#lab-start");
  await page.waitForFunction(() => (document.querySelector("[data-testid=single-stage] video") as HTMLVideoElement | null)?.videoWidth);
  await page.waitForTimeout(500);
  await tapCenter(page, "single-stage");
  await expect.poll(async () => (await singleStats(page)).state, { timeout: 10_000 }).toBe("tracking");
  await page.waitForTimeout(1500);
  const s = await singleStats(page);
  console.log(JSON.stringify(s));
  expect(s.anchor).not.toBeNull();
  expect(s.fps).toBeGreaterThan(5);
  expect(s.processMs).toBeGreaterThan(0);
  expect(s.inliers).toBeGreaterThan(10);
  const hud = page.getByTestId("hud-single");
  await expect(hud).toContainText("tracking");
  await expect(hud).toContainText("인라이어");
  await page.getByRole("button", { name: "지우기" }).click();
  await expect.poll(async () => (await singleStats(page)).anchor).toBeNull();
});

test("영상 파일: 폰으로 찍은 클립 대신 녹화한 WebM으로 단일·루프백", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  // 가짜 카메라를 2.5초 녹화 (폰에서 찍은 클립 흉내)
  await page.goto("/lab/track");
  const b64 = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 2_500_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(250);
    await new Promise((r) => setTimeout(r, 2500));
    rec.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    const buf = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  // 경로(한글 폴더명) 대신 메모리 버퍼로 넘긴다. 확인용으로 파일도 남긴다
  const file = { name: "clip.webm", mimeType: "video/webm", buffer: Buffer.from(b64, "base64") };
  fs.writeFileSync(testInfo.outputPath("clip.webm"), file.buffer);
  expect(file.buffer.length).toBeGreaterThan(20_000);

  // (1) 카메라 1대 + 파일
  await page.goto("/lab/track?e2e=1&mode=single&pane=390x844");
  await page.getByRole("radio", { name: "영상 파일" }).click();
  await expect(page.getByRole("radio", { name: "영상 파일" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#lab-start")).toBeDisabled();
  await page.setInputFiles("input[type=file]", file);
  await expect(page.locator("#lab-start")).toBeEnabled();
  await page.click("#lab-start");
  await page.waitForFunction(() => (document.querySelector("[data-testid=single-stage] video") as HTMLVideoElement | null)?.videoWidth);
  await page.waitForTimeout(400);
  await tapCenter(page, "single-stage");
  await expect.poll(async () => (await singleStats(page)).state, { timeout: 10_000 }).toBe("tracking");
  await page.getByRole("button", { name: "멈춤" }).click();

  // (2) 루프백 + 파일 (captureStream → WebRTC)
  await page.getByRole("radio", { name: "루프백" }).click();
  await page.setInputFiles("input[type=file]", file);
  await openLoopback(page, "", { navigate: false });
  await tapCenter(page, "eng-video");
  await expect.poll(async () => (await custState(page)).state, { timeout: 15_000 }).toBe("tracking");
  await expect(page.getByTestId("eng-chip")).toHaveText("고객 화면에 표시 중", { timeout: 5_000 });
});
