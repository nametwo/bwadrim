import { describe, expect, it } from "vitest";
import type { GrayImage, Mat3, Rect } from "./types";
import { IDENTITY } from "./geometry";
import { PlanarTracker } from "./tracker";
import { Rng } from "./cv/rng";
import { camHomography, makeTexture, renderView } from "./cv/testing/synth";

// 성능 확인 (데스크톱 Node 320×240). 저가 안드로이드는 3~4배 느리다고 보고 잡은 목표:
//   추적 프레임 중앙값 ≤ 3ms · p95 ≤ 5ms, 재검출(ORB 탐색) 프레임 중앙값 ≤ 8ms · p95 ≤ 12ms, setReference ≤ 25ms.
// 다른 테스트 파일과 병렬로 돌면 흔들리므로 기본은 목표의 1.6배까지 허용하고 실제 값을 로그로 남긴다.
// TRACKING_PERF_STRICT=1 이면 목표 그대로 검사.

const STRICT = typeof process !== "undefined" && process.env.TRACKING_PERF_STRICT === "1";
const SLACK = STRICT ? 1 : 1.6;
const W = 320;
const H = 240;

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function p95(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function stageMedians(rows: Record<string, number>[]): string {
  const keys = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  return [...keys]
    .map((k) => `${k} ${median(rows.map((r) => r[k] ?? 0)).toFixed(2)}`)
    .join(", ");
}

describe("PlanarTracker performance (320×240)", () => {
  const world = makeTexture(900, 700, 17);
  // 손에 든 폰: 느린 이동 + 떨림 + 약한 회전·확대
  const rng = new Rng(3);
  const view = (t: number): Mat3 =>
    camHomography({
      cx: 450,
      cy: 350,
      tx: -290 + 25 * Math.sin(t * 0.05) + rng.gauss() * 0.8,
      ty: -230 + 15 * Math.sin(t * 0.07) + rng.gauss() * 0.8,
      rot: 0.2 * Math.sin(t * 0.03),
      scale: 0.6 * (1 + 0.15 * Math.sin(t * 0.04)),
      px: 0.0003 * Math.sin(t * 0.05),
    });
  const N = 220;
  const frames: GrayImage[] = [];
  const noise = new Rng(5);
  for (let t = 0; t < N; t++) frames.push(renderView(world, view(t), W, H, { noise: 2, rng: noise }));
  const roi: Rect = { x: 100, y: 60, width: 120, height: 120 };

  it("tracking frames: median ≤ 3ms, p95 ≤ 5ms", { timeout: 60000 }, () => {
    const tr = new PlanarTracker({ reanchorInterval: 0 });
    tr.setReference(frames[0], roi, IDENTITY);
    const ms: number[] = [];
    const stages: Record<string, number>[] = [];
    for (let t = 1; t < N; t++) {
      const r = tr.process(frames[t], t * 50);
      expect(r.state).toBe("tracking");
      if (t > 40 && !r.redetected) {
        ms.push(r.timings.total);
        stages.push(r.timings);
      }
    }
    const med = median(ms);
    console.log(
      `[perf] tracking frame 320x240: median ${med.toFixed(2)}ms, p95 ${p95(ms).toFixed(2)}ms (n=${ms.length}) — ${stageMedians(stages)}`,
    );
    expect(med).toBeLessThan(3 * SLACK);
    expect(p95(ms)).toBeLessThan(5 * SLACK);
  });

  it("redetect (ORB search) frames: median ≤ 8ms, p95 ≤ 12ms; setReference ≤ 25ms", { timeout: 60000 }, () => {
    const tr = new PlanarTracker();
    const ms: number[] = [];
    const refMs: number[] = [];
    const stages: Record<string, number>[] = [];
    let found = 0;
    for (let k = 0; k < 60; k++) {
      // 매번 새 기준(고객 쪽 searching) → 다음 process는 반드시 ORB 재검출 프레임
      const t0 = performance.now();
      tr.setReference(frames[k], roi);
      if (k >= 15) refMs.push(performance.now() - t0);
      const r = tr.process(frames[k + 8], k * 50);
      expect(r.redetected).toBe(true);
      if (r.state === "tracking") found++;
      if (k >= 15) {
        ms.push(r.timings.total);
        stages.push(r.timings);
      }
    }
    const med = median(ms);
    console.log(
      `[perf] redetect frame 320x240: median ${med.toFixed(2)}ms, p95 ${p95(ms).toFixed(2)}ms (n=${ms.length}, found ${found}/60) — ${stageMedians(stages)}`,
    );
    console.log(`[perf] setReference 320x240: median ${median(refMs).toFixed(2)}ms, max ${Math.max(...refMs).toFixed(2)}ms`);
    expect(found).toBeGreaterThanOrEqual(57);
    expect(med).toBeLessThan(8 * SLACK);
    expect(p95(ms)).toBeLessThan(12 * SLACK);
    expect(median(refMs)).toBeLessThan(25 * SLACK);
  });
});
