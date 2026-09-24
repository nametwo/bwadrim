import { describe, expect, it } from "vitest";
import type { GrayImage, Mat3 } from "../types";
import { IDENTITY, applyH, invert3, mul3 } from "../geometry";
import { DEFAULT_DEAD_RECKON, DeadReckoner, fitSimilarity } from "./deadreckon";
import { Pyramid } from "./image";
import { Rng } from "./rng";
import { camHomography, gaussianBlur, makeFlat, makeTexture, renderView } from "./testing/synth";

// 화면 밖 안내(hint)용 추측 항법: 프레임 간 호모그래피를 이어 붙인 자세가 정답과 맞는지,
// 맞춤이 나쁘면(무관한 프레임·무늬 없음·흐림) 추측하지 않고 멈추는지, 예산(시간·이동량)이 지나면 멈추는지.

const W = 320;
const H = 240;
const STRICT = typeof process !== "undefined" && process.env.TRACKING_PERF_STRICT === "1";
const SLACK = STRICT ? 1 : 1.6;

const world = makeTexture(1600, 700, 41);

/** 월드 → 프레임. shift(프레임 px)만큼 오른쪽으로 훑는다 (내용은 왼쪽으로 흐름) + 약한 회전·배율 */
function view(shift: number, t: number): Mat3 {
  return camHomography({
    cx: 450,
    cy: 350,
    tx: -290 - shift,
    ty: -230 + 6 * Math.sin(t * 0.3),
    rot: 0.03 * Math.sin(t * 0.2),
    scale: 0.6 * (1 + 0.04 * Math.sin(t * 0.15)),
  });
}

function pyramidOf(img: GrayImage): Pyramid {
  const p = new Pyramid();
  p.build(img, 4);
  return p;
}

interface Seq {
  pyrs: Pyramid[];
  views: Mat3[];
  times: number[];
}

function makeSeq(n: number, shift: (t: number) => number, dtMs = 1000 / 30, seed = 1): Seq {
  const rng = new Rng(seed);
  const pyrs: Pyramid[] = [];
  const views: Mat3[] = [];
  const times: number[] = [];
  for (let t = 0; t < n; t++) {
    const V = view(shift(t), t);
    views.push(V);
    pyrs.push(pyramidOf(renderView(world, V, W, H, { noise: 2, rng, supersample: 1 })));
    times.push(t * dtMs);
  }
  return { pyrs, views, times };
}

/** 프레임 0 기준 → 프레임 t 정답 */
const gtH = (s: Seq, t: number): Mat3 => mul3(s.views[t], invert3(s.views[0])!);

/** 프레임 중심에서 본 방향 차이 (도) */
function angleDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  let d = Math.abs(Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI;
}

describe("fitSimilarity", () => {
  it("recovers an exact similarity and rejects degenerate input", () => {
    const S: Mat3 = [0.9 * Math.cos(0.3), -0.9 * Math.sin(0.3), 12, 0.9 * Math.sin(0.3), 0.9 * Math.cos(0.3), -7, 0, 0, 1];
    const n = 6;
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sx[i] = 10 + 37 * i;
      sy[i] = 200 - 23 * ((i * 7) % 5);
      const p = applyH(S, { x: sx[i], y: sy[i] })!;
      dx[i] = p.x;
      dy[i] = p.y;
    }
    const G = fitSimilarity(sx, sy, dx, dy, n, null)!;
    for (let k = 0; k < 9; k++) expect(G[k]).toBeCloseTo(S[k], 9);
    // mask로 한 점만 → 퇴화
    const mask = new Uint8Array(n);
    mask[2] = 1;
    expect(fitSimilarity(sx, sy, dx, dy, n, mask)).toBeNull();
  });
});

describe("DeadReckoner (offscreen hint dead reckoning)", () => {
  // 0.5초 제자리 → 1초 동안 520px 오른쪽으로 훑기(등속 아님) → 1초 머묾
  const pan = (t: number) => (t < 15 ? 0 : t < 45 ? 520 * (0.5 - 0.5 * Math.cos((Math.PI * (t - 15)) / 30)) : 520);
  const seq = makeSeq(75, pan);

  it("chains frame-to-frame homographies: a point far outside the frame stays within a few px of the truth", () => {
    const dr = new DeadReckoner();
    dr.start(IDENTITY, seq.times[0]);
    // 프레임 0 기준 앵커 (화면 중앙) — 훑은 뒤에는 화면 왼쪽 밖 ~360px
    const anchor = { x: 160, y: 120 };
    let maxErr = 0;
    let maxAng = 0;
    for (let t = 1; t < seq.pyrs.length; t++) {
      expect(dr.step(seq.pyrs[t - 1], seq.pyrs[t], seq.times[t])).toBe(true);
      const est = applyH(dr.pose!, anchor)!;
      const gt = applyH(gtH(seq, t), anchor)!;
      maxErr = Math.max(maxErr, Math.hypot(est.x - gt.x, est.y - gt.y));
      if (gt.x < 0) maxAng = Math.max(maxAng, angleDeg(est, gt));
    }
    const final = applyH(gtH(seq, seq.pyrs.length - 1), anchor)!;
    expect(final.x).toBeLessThan(-300);
    expect(dr.active).toBe(true);
    expect(dr.stepCount).toBe(seq.pyrs.length - 1);
    expect(maxErr).toBeLessThan(6);
    expect(maxAng).toBeLessThan(2);
    expect(dr.travelPx).toBeGreaterThan(500);
  });

  it("is deterministic", () => {
    const run = () => {
      const dr = new DeadReckoner();
      dr.start(IDENTITY, 0);
      for (let t = 16; t < 40; t++) dr.step(seq.pyrs[t - 1], seq.pyrs[t], seq.times[t]);
      return dr.pose;
    };
    expect(run()).toEqual(run());
  });

  it("stops instead of guessing when the next frame does not match (violent shake / unrelated view)", () => {
    const other = pyramidOf(renderView(makeTexture(900, 700, 99), view(0, 0), W, H, { noise: 2, supersample: 1 }));
    const dr = new DeadReckoner();
    dr.start(IDENTITY, 0);
    expect(dr.step(seq.pyrs[19], seq.pyrs[20], seq.times[20])).toBe(true);
    expect(dr.step(seq.pyrs[20], other, seq.times[21])).toBe(false);
    expect(dr.active).toBe(false);
    expect(dr.pose).toBeNull();
    expect(["points", "fit", "rms", "spread", "shape", "predicted"]).toContain(dr.lastStop);
    // 멈춘 뒤에는 다시 start하기 전까지 아무것도 내지 않는다
    expect(dr.step(seq.pyrs[21], seq.pyrs[22], seq.times[22])).toBe(false);
    expect(dr.pose).toBeNull();
  });

  it("stops on a texture-less view (blank wall) and on heavy motion blur", () => {
    const flat = pyramidOf(makeFlat(W, H, 5, 1));
    const a = new DeadReckoner();
    a.start(IDENTITY, 0);
    expect(a.step(flat, flat, 33)).toBe(false);
    expect(a.lastStop).toBe("points");

    // 한 프레임에 60px 움직이며 σ=6 흐림 — 맞춤이 성립하지 않는다
    const sharp = pyramidOf(renderView(world, view(0, 0), W, H, { noise: 2, supersample: 1 }));
    const blurred = pyramidOf(gaussianBlur(renderView(world, view(60, 1), W, H, { noise: 2, supersample: 1 }), 6));
    const b = new DeadReckoner();
    b.start(IDENTITY, 0);
    expect(b.step(sharp, blurred, 33)).toBe(false);
    expect(b.pose).toBeNull();
  });

  it("expires after the time budget and after the accumulated-motion budget", () => {
    const a = new DeadReckoner({ maxAgeMs: 1000 });
    a.start(IDENTITY, 0);
    expect(a.step(seq.pyrs[0], seq.pyrs[1], 900)).toBe(true);
    expect(a.step(seq.pyrs[1], seq.pyrs[2], 1100)).toBe(false);
    expect(a.lastStop).toBe("age");
    expect(DEFAULT_DEAD_RECKON.maxAgeMs).toBeGreaterThanOrEqual(4000);
    expect(DEFAULT_DEAD_RECKON.maxAgeMs).toBeLessThanOrEqual(6000);

    const b = new DeadReckoner({ maxTravelDiag: 0.5 }); // 화면 대각선(400px)의 절반 = 200px
    b.start(IDENTITY, 0);
    let t = 16;
    while (b.step(seq.pyrs[t - 1], seq.pyrs[t], seq.times[t])) t++;
    expect(b.lastStop).toBe("travel");
    const moved = Math.abs(pan(t - 1) - pan(15));
    expect(moved).toBeGreaterThan(120);
    expect(moved).toBeLessThan(260);
  });

  it("stops when the frame size changes (rotation)", () => {
    const portrait = pyramidOf(makeTexture(H, W, 3));
    const dr = new DeadReckoner();
    dr.start(IDENTITY, 0);
    expect(dr.step(seq.pyrs[0], portrait, 33)).toBe(false);
    expect(dr.lastStop).toBe("size");
  });

  it("uses the velocity hint and uneven frame spacing (20fps customer: 33/67ms) for fast pans", () => {
    // 프레임당 ~45px (67ms 간격) — 예측 없이 LK만으로는 벅찬 속도
    const fastPan = (t: number) => 34 * t;
    const times = Array.from({ length: 16 }, (_, t) => Math.round(t * 50 + (t % 2 ? 17 : 0)));
    const rng = new Rng(4);
    const pyrs = times.map((_, t) => pyramidOf(renderView(world, view(fastPan(times[t] / 50), t), W, H, { noise: 2, rng, supersample: 1 })));
    const vel = mul3(view(fastPan(times[1] / 50), 1), invert3(view(0, 0))!);
    const dr = new DeadReckoner();
    dr.start(vel, times[1], vel, times[1] - times[0]);
    const anchor = { x: 160, y: 120 };
    for (let t = 2; t < pyrs.length; t++) {
      expect(dr.step(pyrs[t - 1], pyrs[t], times[t])).toBe(true);
      const gt = applyH(mul3(view(fastPan(times[t] / 50), t), invert3(view(0, 0))!), anchor)!;
      const est = applyH(dr.pose!, anchor)!;
      expect(Math.hypot(est.x - gt.x, est.y - gt.y)).toBeLessThan(6);
    }
  });

  it(`step cost: median ≤ ${(3 * SLACK).toFixed(1)}ms on 320×240`, () => {
    const ms: number[] = [];
    for (let rep = 0; rep < 4; rep++) {
      const dr = new DeadReckoner();
      dr.start(IDENTITY, 0);
      for (let t = 1; t < seq.pyrs.length; t++) {
        const t0 = performance.now();
        dr.step(seq.pyrs[t - 1], seq.pyrs[t], seq.times[t]);
        if (rep > 0) ms.push(performance.now() - t0);
      }
    }
    ms.sort((a, b) => a - b);
    const med = ms[ms.length >> 1];
    const p95 = ms[Math.floor(ms.length * 0.95)];
    console.log(`[deadreckon] step median ${med.toFixed(2)}ms p95 ${p95.toFixed(2)}ms (n=${ms.length})`);
    expect(med).toBeLessThan(3 * SLACK);
  });
});
