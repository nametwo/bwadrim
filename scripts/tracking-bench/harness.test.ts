// 하네스 검증: 시나리오 GT가 말이 되는지 + 기준선 추적기(oracle=완벽, null=0, shifted=전부 틀림)로 지표 파이프라인 확인.
// 첫 실행은 Playwright로 텍스처를 렌더한다 (.cache/textures, 이후 재사용).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cachedRef, readRefCache, REF_DIR, sequenceFingerprint } from "./framecache";
import { runSequence } from "./harness";
import { allScenarios, selectScenarios } from "./catalog";
import { SCENARIOS, suiteOf } from "./scenarios";
import { buildSequence } from "./sequence";
import { HOLDOUT_TARGET_IDS, ensureTextures } from "./textures";
import { getTracker } from "./trackers";
import { rgbaToGray } from "../../src/lib/tracking/cv/color";
import { decodeMarker, exportY4m, markerBits } from "./y4m";

beforeAll(async () => {
  await ensureTextures();
}, 120_000);

describe("scenario ground truth sanity", () => {
  it("has 25+ scenarios with unique ids covering every README category", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const c of ["jitter", "motion", "repetitive", "lowtex", "reentry", "acquire"]) {
      expect(SCENARIOS.some((s) => s.category === c)).toBe(true);
    }
    expect(SCENARIOS.filter((s) => s.category === "acquire").length).toBeGreaterThanOrEqual(6);
    expect(SCENARIOS.some((s) => s.duration >= 60)).toBe(true);
  });

  it(
    "every scenario: pin inside reference, sane ROI, pin in front of camera, expected visibility",
    () => {
      for (const sc of SCENARIOS) {
        const seq = buildSequence(sc); // 핀이 기준 프레임 밖이면 여기서 throw
        const nominal = 0.5 * Math.min(seq.ref.width, seq.ref.height);
        expect(seq.roi.width * seq.roi.height, sc.id).toBeGreaterThan(0.55 * nominal * nominal);
        expect(seq.gt.length, sc.id).toBeGreaterThan(20);
        expect(seq.gt.every((g) => g.pin !== null), `${sc.id}: pin behind camera`).toBe(true);
        const vis = seq.gt.filter((g) => g.visible).length / seq.gt.length;
        if (["jitter", "motion", "repetitive", "lowtex", "drift", "acquire"].includes(sc.category)) {
          expect(vis, `${sc.id} visibility`).toBe(1);
        }
        if (sc.category === "acquire") {
          expect(seq.gt[0].roiVisible, sc.id).toBeGreaterThan(0.8);
          expect(seq.initialH).toBeUndefined();
        }
        if (sc.side === "engineer") {
          expect(seq.initialH).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
          // 첫 프레임은 기준에서 1/30초 뒤 — 핀이 거의 그대로
          const g = seq.gt[0];
          expect(Math.hypot(g.pin!.x - seq.pinRef.x, g.pin!.y - seq.pinRef.y), sc.id).toBeLessThan(8);
        }
        // 처리 시각은 기준 이후, 단조 증가
        expect(seq.times[0]).toBeGreaterThan(seq.refTime);
        for (let i = 1; i < seq.times.length; i++) expect(seq.times[i]).toBeGreaterThan(seq.times[i - 1]);
      }
    },
    120_000,
  );

  it("customer side processes at 20fps with anchor latency; engineer at 30fps right after the tap", () => {
    const c = buildSequence(SCENARIOS.find((s) => s.id === "acquire/pos")!);
    expect(c.times[0] - c.refTime).toBeGreaterThanOrEqual(0.29);
    const dts = c.times.slice(1).map((t, i) => t - c.times[i]);
    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
    expect(mean).toBeCloseTo(1 / 20, 2);
    const e = buildSequence(SCENARIOS.find((s) => s.id === "jitter/still/boiler")!);
    expect(e.times[0] - e.refTime).toBeCloseTo(1 / 30, 6);
  });

  it("rendered frames match GT dims and look like images (not blank/saturated)", () => {
    for (const id of ["jitter/mild/pos", "motion/hd720/boiler", "stress/orientation/boiler", "acquire/router-land"]) {
      const seq = buildSequence(SCENARIOS.find((s) => s.id === id)!);
      for (const k of [0, seq.times.length - 1]) {
        const img = seq.renderFrame(k);
        expect([img.width, img.height]).toEqual([seq.gt[k].width, seq.gt[k].height]);
        let m = 0;
        let m2 = 0;
        for (const v of img.data) {
          m += v;
          m2 += v * v;
        }
        m /= img.data.length;
        const sd = Math.sqrt(m2 / img.data.length - m * m);
        expect(m, id).toBeGreaterThan(40);
        expect(m, id).toBeLessThan(220);
        expect(sd, id).toBeGreaterThan(15);
      }
    }
  }, 60_000);

  it("orientation scenario switches frame size mid-sequence", () => {
    const seq = buildSequence(SCENARIOS.find((s) => s.id === "stress/orientation/boiler")!);
    const dims = new Set(seq.gt.map((g) => `${g.width}x${g.height}`));
    expect(dims).toEqual(new Set(["240x320", "320x240"]));
  });

  it("reference image cache returns the same bytes as a fresh render", () => {
    // 짧게 줄인 사본 → 캐시 파일 이름(길이 포함)이 본 벤치 캐시와 겹치지 않는다
    const sc = { ...SCENARIOS.find((s) => s.id === "acquire/pos")!, duration: 1.1 };
    const a = buildSequence(sc);
    const fp = sequenceFingerprint(a);
    try {
      const fresh = cachedRef(a, fp); // 없으면 렌더 + 쓰기, 있으면 읽기
      const b = buildSequence(sc);
      expect(b.hasRef()).toBe(false);
      const hit = readRefCache(b, fp);
      expect(hit).not.toBeNull();
      const got = cachedRef(b, fp);
      expect(b.hasRef()).toBe(true);
      expect(Buffer.from(got.data).equals(Buffer.from(fresh.data))).toBe(true);
      // 캐시와 무관하게 렌더한 것과도 같다 (렌더는 결정적)
      const c = buildSequence(sc);
      expect(Buffer.from(c.ref.data).equals(Buffer.from(fresh.data))).toBe(true);
    } finally {
      for (const f of fs.readdirSync(REF_DIR)) if (f.startsWith("acquire_pos.d1100.")) fs.rmSync(path.join(REF_DIR, f), { force: true });
    }
  });
});

describe("baseline trackers validate the metrics", () => {
  it(
    "oracle is perfect everywhere, null never shows, shifted is always wrong when shown",
    async () => {
      const oracle = await getTracker("oracle");
      const nul = await getTracker("null");
      const shifted = await getTracker("shifted");
      let reentries = 0;
      for (const sc of SCENARIOS) {
        const seq = buildSequence(sc);
        const o = runSequence(seq, oracle, { blankFrames: true }).metrics;
        expect(o.tracked, sc.id).toBe(1);
        expect(o.wrong, sc.id).toBe(0);
        expect(o.err.max ?? 0, sc.id).toBeLessThan(1e-6);
        if (sc.side === "customer") expect(o.acquireFrames, sc.id).toBe(0);
        for (const r of o.reentries) expect(r.latency, sc.id).toBe(0);
        if (sc.category === "reentry") {
          expect(o.reentries.length, sc.id).toBeGreaterThanOrEqual(1);
          reentries += o.reentries.length;
          expect(o.hint.offscreenFrames, sc.id).toBeGreaterThan(0);
        }
        // 화면 밖이면 oracle은 정답 hint → 제공률 100%, 방향 오차 0, 오안내 0
        if (o.hint.offscreenFrames) {
          expect(o.hint.available, sc.id).toBe(1);
          expect(o.hint.angle.max ?? 0, sc.id).toBeLessThan(1e-6);
        }
        expect(o.hint.falseOffscreenFrames, sc.id).toBe(0);
        expect(o.checks.every((c) => c.pass !== false), sc.id).toBe(true);

        const n = runSequence(seq, nul, { blankFrames: true }).metrics;
        expect(n.tracked, sc.id).toBe(0);
        expect(n.wrong, sc.id).toBe(0);
        expect(n.hint.hintFrames, sc.id).toBe(0);

        const s = runSequence(seq, shifted, { blankFrames: true });
        const shown = s.records.filter((r) => r.displayed).length;
        expect(s.metrics.wrongFrames, sc.id).toBe(shown);
        expect(s.metrics.err.median, sc.id).toBeCloseTo(10, 6);
      }
      expect(reentries).toBeGreaterThanOrEqual(6);
    },
    120_000,
  );
});

describe("realism & holdout suites", () => {
  it("suites: base unchanged, realism variants point at base scenarios, ≥12 holdout scenarios excluded by default", () => {
    const all = allScenarios();
    const real = all.filter((s) => suiteOf(s) === "realism");
    const hold = all.filter((s) => suiteOf(s) === "holdout");
    expect(all.filter((s) => suiteOf(s) === "base")).toHaveLength(SCENARIOS.length);
    expect(real.length).toBeGreaterThanOrEqual(12);
    for (const r of real) {
      expect(SCENARIOS.some((b) => b.id === r.variantOf), r.id).toBe(true);
      expect(r.realism, r.id).toBeDefined();
    }
    expect(real.some((s) => s.realism?.codec && s.side === "engineer")).toBe(true);
    expect(hold.length).toBeGreaterThanOrEqual(12);
    expect(new Set(hold.map((s) => s.seed)).size).toBe(hold.length);
    for (const h of hold) {
      expect(h.holdout, h.id).toBe(true);
      expect(h.realism?.lens && h.realism.relief && h.realism.isp, h.id).toBeTruthy();
    }
    expect(hold.some((s) => (HOLDOUT_TARGET_IDS as string[]).includes(s.target))).toBe(true);
    // 기본 실행(base+realism)·필터에 홀드아웃이 섞이지 않는다
    expect(selectScenarios(undefined).some((s) => s.holdout)).toBe(false);
    expect(selectScenarios("acquire").some((s) => s.holdout)).toBe(false);
    expect(selectScenarios(undefined, ["holdout"])).toHaveLength(hold.length);
  });

  it(
    "GT sanity + oracle/null baselines on every realism/holdout scenario (blank frames)",
    async () => {
      await ensureTextures(HOLDOUT_TARGET_IDS);
      const oracle = await getTracker("oracle");
      const nul = await getTracker("null");
      for (const sc of allScenarios().filter((s) => suiteOf(s) !== "base")) {
        const seq = buildSequence(sc);
        expect(seq.gt.every((g) => g.pin !== null), `${sc.id}: pin behind camera`).toBe(true);
        const nominal = 0.5 * Math.min(seq.roi.width + 1, seq.roi.height + 1);
        expect(seq.roi.width * seq.roi.height, sc.id).toBeGreaterThan(0.5 * nominal * nominal);
        if (["jitter", "motion", "repetitive", "lowtex", "drift", "acquire"].includes(sc.category)) {
          expect(seq.gt.filter((g) => g.visible).length / seq.gt.length, `${sc.id} visibility`).toBe(1);
        }
        if (sc.side === "engineer") {
          const g = seq.gt[0];
          expect(Math.hypot(g.pin!.x - seq.pinRef.x, g.pin!.y - seq.pinRef.y), sc.id).toBeLessThan(8);
        }
        const o = runSequence(seq, oracle, { blankFrames: true }).metrics;
        expect(o.tracked, sc.id).toBe(1);
        expect(o.wrong, sc.id).toBe(0);
        expect(o.suite, sc.id).toBe(suiteOf(sc));
        if (o.hint.offscreenFrames) expect(o.hint.angle.max ?? 0, sc.id).toBeLessThan(1e-6);
        if (sc.category === "reentry") expect(o.reentries.length, sc.id).toBeGreaterThanOrEqual(1);
        const n = runSequence(seq, nul, { blankFrames: true }).metrics;
        expect(n.wrong, sc.id).toBe(0);
      }
    },
    180_000,
  );
});

describe("y4m export (fake camera)", () => {
  it("writes a valid 4:2:0 y4m with decodable frame markers and a GT sidecar", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "y4m-"));
    try {
      const sc = SCENARIOS.find((s) => s.id === "jitter/mild/pos")!;
      const r = exportY4m(sc, { stream: [640, 480], seconds: 0.4, outDir: dir });
      const buf = fs.readFileSync(r.file);
      const nl = buf.indexOf(0x0a);
      const header = buf.subarray(0, nl).toString();
      expect(header).toBe("YUV4MPEG2 W640 H480 F30:1 Ip A1:1 C420jpeg");
      const frameBytes = 640 * 480 * 1.5;
      expect(buf.length).toBe(nl + 1 + r.frames * (6 + frameBytes));
      for (let i = 0; i < r.frames; i++) {
        const off = nl + 1 + i * (6 + frameBytes);
        expect(buf.subarray(off, off + 6).toString()).toBe("FRAME\n");
        const y = buf.subarray(off + 6, off + 6 + 640 * 480);
        expect(decodeMarker(y, 640, 480)).toBe(i);
      }
      const side = JSON.parse(fs.readFileSync(r.sidecar, "utf8"));
      expect(side.frames).toBe(r.frames);
      expect(side.frameGT).toHaveLength(r.frames);
      for (const f of side.frameGT) {
        expect(f.inFrame).toBe(true);
        expect(f.pin.x).toBeGreaterThan(0);
        expect(f.pin.x).toBeLessThan(1);
        expect(f.H).toHaveLength(9);
      }
      expect(markerBits(5)).toHaveLength(16);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("plays in Chromium as a fake camera; decoded frame markers index the GT sidecar", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "y4m-"));
    const { chromium } = await import("@playwright/test");
    const sc = SCENARIOS.find((s) => s.id === "jitter/mild/pos")!;
    const r = exportY4m(sc, { stream: [480, 640], seconds: 1, outDir: dir });
    const browser = await chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${r.file}`],
    });
    try {
      const page = await browser.newPage();
      // getUserMedia는 보안 컨텍스트에서만 → 가짜 https 주소로
      await page.route("https://bench.test/", (rt) =>
        rt.fulfill({ body: "<video id=v autoplay muted playsinline></video><canvas id=c></canvas>", contentType: "text/html" }),
      );
      await page.goto("https://bench.test/");
      const frames = (await page.evaluate(`(async () => {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        const v = document.getElementById('v'); v.srcObject = s; await v.play();
        await new Promise(r => setTimeout(r, 250));
        const c = document.getElementById('c'); c.width = v.videoWidth; c.height = v.videoHeight;
        const ctx = c.getContext('2d');
        const out = [];
        for (let i = 0; i < 4; i++) {
          ctx.drawImage(v, 0, 0);
          out.push({ w: c.width, h: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) });
          await new Promise(r => setTimeout(r, 70));
        }
        return out;
      })()`)) as { w: number; h: number; data: number[] }[];
      const idx = frames.map((f) => {
        expect([f.w, f.h]).toEqual([480, 640]);
        return decodeMarker(rgbaToGray(new Uint8Array(f.data), f.w, f.h).data, f.w, f.h);
      });
      expect(idx.every((i) => i !== null && i >= 0 && i < r.frames)).toBe(true);
      expect(new Set(idx).size).toBeGreaterThan(1); // 실제로 재생 중
    } finally {
      await browser.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
