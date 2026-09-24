// 지표 정의 단위 테스트 (README "품질 목표"의 문장 그대로인지)
import { describe, expect, it } from "vitest";
import {
  type FrameRecord,
  aggregate,
  arrowErrorDeg,
  classifyFrame,
  findReentries,
  hintMetrics,
  scenarioMetrics,
  stats,
} from "./metrics";

function rec(p: Partial<FrameRecord> & { k: number }): FrameRecord {
  return {
    tMs: p.k * 33.33,
    inFrame: true,
    occluded: false,
    visible: true,
    offscreenBy: 0,
    roiVisible: 1,
    gtPin: { x: 100, y: 100 },
    state: "lost",
    displayed: false,
    estPin: null,
    err: null,
    correct: false,
    wrong: false,
    redetected: false,
    ms: 1,
    inliers: 0,
    tracked: 0,
    confidence: 0,
    reason: null,
    hint: false,
    hintPin: null,
    hintErrDeg: null,
    ...p,
  };
}

/** 추적 상태·오차로 기록 만들기 (분류는 실제 함수로) */
function frame(k: number, shown: boolean, err: number | null, gt: Partial<FrameRecord> = {}): FrameRecord {
  const base = rec({ k, ...gt });
  const est = err === null ? null : { x: base.gtPin!.x + err, y: base.gtPin!.y };
  const c = classifyFrame({ inFrame: base.inFrame, offscreenBy: base.offscreenBy, pin: base.gtPin }, shown, est);
  return { ...base, state: shown ? "tracking" : "lost", displayed: shown, estPin: est, ...c };
}

describe("classifyFrame", () => {
  const gt = { inFrame: true, offscreenBy: 0, pin: { x: 50, y: 50 } };
  it("not displayed → neither wrong nor correct", () => {
    expect(classifyFrame(gt, false, null)).toEqual({ err: null, wrong: false, correct: false });
  });
  it("error ≤ 8px is correct, > 8px is wrong", () => {
    expect(classifyFrame(gt, true, { x: 58, y: 50 }).correct).toBe(true);
    expect(classifyFrame(gt, true, { x: 58.01, y: 50 }).wrong).toBe(true);
  });
  it("displayed while pin is off-screen (beyond 8px tolerance) is wrong even if H is right", () => {
    const off = { inFrame: false, offscreenBy: 20, pin: { x: -20, y: 50 } };
    expect(classifyFrame(off, true, { x: -20, y: 50 }).wrong).toBe(true);
    const edge = { inFrame: false, offscreenBy: 3, pin: { x: -3.5, y: 50 } };
    expect(classifyFrame(edge, true, { x: -2, y: 50 }).wrong).toBe(false);
  });
  it("displayed with an unusable H (point behind camera) is wrong with infinite error", () => {
    const c = classifyFrame(gt, true, null);
    expect(c.err).toBe(Infinity);
    expect(c.wrong).toBe(true);
  });
});

describe("stats", () => {
  it("median / p95 / NaN ignored / Infinity ranked last", () => {
    const s = stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, NaN]);
    expect(s.n).toBe(10);
    expect(s.median).toBeCloseTo(5.5, 10);
    expect(s.p95).toBeCloseTo(9.55, 10);
    const t = stats([1, 1, 1, Infinity]);
    expect(t.max).toBe(Infinity);
    expect(t.p95).toBe(Infinity);
    expect(stats([]).median).toBeNull();
  });
});

describe("scenarioMetrics", () => {
  it("tracked% counts visible frames only; occluded pin shown in place is not wrong", () => {
    const recs = [
      frame(0, true, 1),
      frame(1, true, 2),
      frame(2, false, null),
      frame(3, true, 1.5, { occluded: true, visible: false }),
      frame(4, false, null, { occluded: true, visible: false }),
      frame(5, true, 12),
    ];
    const m = scenarioMetrics({ id: "x", category: "jitter", side: "engineer", title: "", trackable: true, refFeatures: 10 }, recs);
    expect(m.visibleFrames).toBe(4);
    expect(m.tracked).toBeCloseTo(2 / 4, 10);
    expect(m.wrongFrames).toBe(1);
    expect(m.wrong).toBeCloseTo(1 / 6, 10);
    expect(m.err.median).toBeCloseTo(1.75, 10);
  });

  it("customer acquisition = first correctly displayed frame", () => {
    const recs = [frame(0, false, null), frame(1, true, 20), frame(2, false, null), frame(3, true, 2), frame(4, true, 1)];
    const m = scenarioMetrics({ id: "a", category: "acquire", side: "customer", title: "", trackable: true, refFeatures: 10 }, recs);
    expect(m.acquireFrames).toBe(3);
    expect(m.checks.find((c) => c.name.includes("탐색"))?.pass).toBe(true);
    const late = [0, 1, 2, 3, 4, 5].map((k) => frame(k, k === 5, k === 5 ? 1 : null));
    const m2 = scenarioMetrics({ id: "b", category: "acquire", side: "customer", title: "", trackable: true, refFeatures: 10 }, late);
    expect(m2.acquireFrames).toBe(5);
    expect(m2.checks.find((c) => c.name.includes("탐색"))?.pass).toBe(false);
  });

  it("engineer side has no acquisition metric", () => {
    const m = scenarioMetrics({ id: "c", category: "jitter", side: "engineer", title: "", trackable: true, refFeatures: 1 }, [frame(0, true, 1)]);
    expect(m.acquireFrames).toBeUndefined();
  });
});

describe("findReentries", () => {
  const off = { inFrame: false, visible: false, offscreenBy: 50 };
  it("detects re-entry after ≥0.3s absence and measures latency to first correct frame", () => {
    const recs: FrameRecord[] = [];
    let k = 0;
    for (let i = 0; i < 10; i++) recs.push(frame(k++, true, 1));
    for (let i = 0; i < 15; i++) recs.push(frame(k++, false, null, off)); // 0.5초
    recs.push(frame(k++, false, null, { roiVisible: 0.3 })); // 핀은 보이지만 ROI 대부분 밖 → 아직 아님
    for (let i = 0; i < 3; i++) recs.push(frame(k++, false, null));
    for (let i = 0; i < 5; i++) recs.push(frame(k++, true, 2));
    const r = findReentries(recs);
    expect(r).toHaveLength(1);
    expect(r[0].k).toBe(26);
    expect(r[0].latency).toBe(3);
  });
  it("short dropouts are not re-entries; never re-acquired → latency null", () => {
    const recs: FrameRecord[] = [];
    let k = 0;
    for (let i = 0; i < 5; i++) recs.push(frame(k++, true, 1));
    for (let i = 0; i < 4; i++) recs.push(frame(k++, false, null, off)); // 0.13초
    for (let i = 0; i < 5; i++) recs.push(frame(k++, true, 1));
    for (let i = 0; i < 20; i++) recs.push(frame(k++, false, null, off));
    for (let i = 0; i < 5; i++) recs.push(frame(k++, false, null));
    for (let i = 0; i < 5; i++) recs.push(frame(k++, false, null, off));
    const r = findReentries(recs);
    expect(r).toHaveLength(1);
    expect(r[0].latency).toBeNull();
  });
  it("initial absence (never seen yet) is not a re-entry", () => {
    const recs = [frame(0, false, null, off), ...Array.from({ length: 20 }, (_, i) => frame(i + 1, false, null, off)), frame(21, true, 1)];
    expect(findReentries(recs)).toHaveLength(0);
  });
});

describe("aggregate", () => {
  it("pools frames per category and applies README targets", () => {
    const good = Array.from({ length: 100 }, (_, k) => frame(k, true, 1));
    const bad = Array.from({ length: 100 }, (_, k) => frame(k, k % 2 === 0, k % 2 === 0 ? 1 : null));
    const meta = (id: string) => ({ id, category: "jitter" as const, side: "engineer" as const, title: "", trackable: true, refFeatures: 1 });
    const a = aggregate([
      { metrics: scenarioMetrics(meta("g"), good), records: good },
      { metrics: scenarioMetrics(meta("b"), bad), records: bad },
    ]);
    const j = a.categories.find((c) => c.category === "jitter")!;
    expect(j.frames).toBe(200);
    expect(j.tracked).toBeCloseTo(0.75, 10);
    expect(j.pass).toBe(false); // 95% 미달
    const b = aggregate([{ metrics: scenarioMetrics(meta("g"), good), records: good }]);
    expect(b.categories[0].pass).toBe(true);
    expect(b.perf.msTrack.median).toBe(1);
  });
});

describe("hint (화면 밖 안내)", () => {
  const c = { x: 100, y: 100 };
  it("arrow error is the angle between directions from the frame centre", () => {
    expect(arrowErrorDeg(c, { x: 300, y: 100 }, { x: 500, y: 100 })).toBeCloseTo(0, 10); // 같은 방향, 거리만 다름
    expect(arrowErrorDeg(c, { x: 300, y: 100 }, { x: 100, y: 400 })).toBeCloseTo(90, 10);
    expect(arrowErrorDeg(c, { x: -50, y: 100 }, { x: 300, y: 100 })).toBeCloseTo(180, 10);
    expect(arrowErrorDeg(c, { x: 200, y: 200 }, { x: 200, y: 0 })).toBeCloseTo(90, 10); // −45° vs +45°
    expect(arrowErrorDeg(c, { x: 0, y: 99 }, { x: 0, y: 101 })).toBeLessThan(2); // ±180° 경계
    expect(arrowErrorDeg(c, null, { x: 300, y: 100 })).toBe(180); // hint가 카메라 뒤
  });
  it("availability counts off-screen (in front of camera) frames; false 'offscreen' while the pin is in frame is counted separately", () => {
    const off = { inFrame: false, visible: false, offscreenBy: 40, gtPin: { x: -40, y: 100 } };
    const recs = [
      rec({ k: 0, ...off, reason: "offscreen", hint: true, hintPin: { x: -10, y: 100 }, hintErrDeg: 3 }),
      rec({ k: 1, ...off, reason: "offscreen", hint: true, hintPin: { x: 200, y: 100 }, hintErrDeg: 170 }),
      rec({ k: 2, ...off, reason: "unverified" }),
      rec({ k: 3, ...off, reason: "offscreen" }), // reason만 있고 hint 없음 → 제공 아님
      rec({ k: 4, inFrame: false, visible: false, offscreenBy: Infinity, gtPin: null }), // 카메라 뒤 → 분모 밖
      rec({ k: 5, reason: "offscreen", hint: true }), // 화면 안인데 offscreen → 오안내
      rec({ k: 6 }),
    ];
    const h = hintMetrics(recs);
    expect(h.offscreenFrames).toBe(4);
    expect(h.hintFrames).toBe(2);
    expect(h.available).toBeCloseTo(0.5, 10);
    expect(h.angle.median).toBeCloseTo(86.5, 10);
    expect(h.wrongArrow).toBeCloseTo(0.5, 10);
    expect(h.falseOffscreenFrames).toBe(1);
    expect(h.inFrameFrames).toBe(2);
    const m = scenarioMetrics({ id: "h", category: "reentry", side: "engineer", title: "", trackable: true, refFeatures: 1 }, recs);
    expect(m.hint.hintFrames).toBe(2);
    expect(m.suite).toBe("base");
  });
  it("aggregate keeps suites apart", () => {
    const good = Array.from({ length: 10 }, (_, k) => frame(k, true, 1));
    const meta = (id: string, suite: "base" | "realism") => ({ id, category: "jitter" as const, suite, side: "engineer" as const, title: "", trackable: true, refFeatures: 1 });
    const a = aggregate([
      { metrics: scenarioMetrics(meta("a", "base"), good), records: good },
      { metrics: scenarioMetrics(meta("b", "realism"), good), records: good },
    ]);
    expect(a.categories.map((c) => `${c.suite}:${c.category}:${c.frames}`)).toEqual(["base:jitter:10", "realism:jitter:10"]);
  });
});
