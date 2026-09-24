// 시나리오 하나를 추적기에 돌려 프레임별 기록·지표를 만든다. 점검용 PNG 덤프도 여기서.
import path from "node:path";
import type { GrayImage, Mat3, Point, ReferenceInfo, TrackResult, TrackState } from "../../src/lib/tracking/types";
import { applyH, rectCorners, warpRect } from "../../src/lib/tracking/geometry";
import { compressFrame, readFrameCache, sequenceFingerprint, writeFrameCache } from "./framecache";
import { type FrameRecord, type ScenarioMetrics, classifyFrame, scenarioMetrics } from "./metrics";
import { Canvas, type RGB } from "./png";
import type { Scenario } from "./scenarios";
import { type Sequence, buildSequence } from "./sequence";
import type { TrackerFactory } from "./trackers";

export interface RunOptions {
  /** 프레임 캐시 읽기 (기본 true) */
  useCache?: boolean;
  /** 캐시가 없어 직접 렌더했으면 캐시에 쓰기 (기본 true) */
  writeCache?: boolean;
  /** 점검용 PNG 폴더 */
  framesDir?: string;
  /** N프레임마다 덤프 (+ 틀린 표시 프레임은 전부, 최대 60장) */
  dumpEvery?: number;
  /** 렌더 없이 빈(0) 프레임을 넘긴다 — 영상을 안 보는 기준선(oracle/null) 전용, 지표 로직만 빠르게 검증 */
  blankFrames?: boolean;
}

export interface ScenarioRun {
  scenario: Scenario;
  seq: Sequence;
  info: ReferenceInfo;
  refMs: number;
  records: FrameRecord[];
  metrics: ScenarioMetrics;
  /** 프레임을 캐시에서 읽었는지 */
  cached: boolean;
  /** 추적기가 보고한 단계별 시간(TrackResult.timings) 평균 ms — 처리한 프레임 기준 */
  stageMs: Record<string, number>;
}

const STATES: TrackState[] = ["searching", "tracking", "weak", "lost"];

function validH(H: unknown): H is Mat3 {
  return Array.isArray(H) && H.length === 9 && H.every((v) => typeof v === "number" && Number.isFinite(v));
}

export function runScenario(sc: Scenario, factory: TrackerFactory, opts: RunOptions = {}): ScenarioRun {
  const seq = buildSequence(sc);
  return runSequence(seq, factory, opts);
}

export function runSequence(seq: Sequence, factory: TrackerFactory, opts: RunOptions = {}): ScenarioRun {
  const sc = seq.scenario;
  const blank = !!opts.blankFrames;
  const fp = blank ? "" : sequenceFingerprint(seq);
  const cache = blank || opts.useCache === false ? null : readFrameCache(seq, fp);
  const rendered: Buffer[] = [];
  const blanks = new Map<string, GrayImage>();
  const getFrame = (k: number): GrayImage => {
    if (blank) {
      const { width, height } = seq.gt[k];
      const key = `${width}x${height}`;
      let b = blanks.get(key);
      if (!b) blanks.set(key, (b = { width, height, data: new Uint8Array(width * height) }));
      return b;
    }
    if (cache) return cache.frame(k);
    const img = seq.renderFrame(k);
    if (opts.writeCache !== false) rendered.push(compressFrame(img));
    return img;
  };

  const tracker = factory.create(seq);
  const r0 = performance.now();
  const info = tracker.setReference(seq.ref, seq.roi, seq.initialH);
  const refMs = performance.now() - r0;
  const trackable = info?.trackable !== false;

  const records: FrameRecord[] = [];
  const stageSum: Record<string, number> = {};
  let stageN = 0;
  const dumpEvery = opts.dumpEvery ?? 10;
  let dumped = 0;
  const dumpDir = opts.framesDir ? path.join(opts.framesDir, sc.id.replace(/[^a-zA-Z0-9_-]+/g, "_")) : null;
  if (dumpDir) dumpRef(seq, path.join(dumpDir, "ref.png"));

  for (let k = 0; k < seq.times.length; k++) {
    const gt = seq.gt[k];
    const img = getFrame(k);
    const tMs = Math.round(seq.times[k] * 1e6) / 1e3;
    let res: TrackResult;
    let ms = NaN;
    if (trackable) {
      tracker.beforeFrame?.(k, gt);
      const t0 = performance.now();
      res = tracker.process(img, tMs);
      ms = performance.now() - t0;
      const tm = res?.timings;
      if (tm && typeof tm === "object") {
        stageN++;
        for (const [k, v] of Object.entries(tm)) if (typeof v === "number" && Number.isFinite(v)) stageSum[k] = (stageSum[k] ?? 0) + v;
      }
    } else {
      // trackable=false면 런타임은 추적을 돌리지 않고 정지 화면 방식으로 폴백한다
      res = { state: "lost", H: null, confidence: 0, inliers: 0, tracked: 0, redetected: false, timings: { total: 0 } };
    }
    const state: TrackState = STATES.includes(res?.state) ? res.state : "lost";
    const displayed = state === "tracking" || state === "weak";
    // 표시 중인데 H가 이상하면(NaN 등) 추정 핀 없음 → 오차 무한대 → 틀린 표시
    const estPin = displayed && validH(res.H) ? applyH(res.H, seq.pinRef) : null;
    const c = classifyFrame(gt, displayed, estPin);
    const rec: FrameRecord = {
      k,
      tMs,
      inFrame: gt.inFrame,
      occluded: gt.occluded,
      visible: gt.visible,
      offscreenBy: gt.offscreenBy,
      roiVisible: gt.roiVisible,
      gtPin: gt.pin,
      state,
      displayed,
      estPin,
      err: c.err,
      correct: c.correct,
      wrong: c.wrong,
      redetected: !!res.redetected,
      ms,
      inliers: res.inliers ?? 0,
      tracked: res.tracked ?? 0,
      confidence: res.confidence ?? 0,
    };
    records.push(rec);
    if (dumpDir && (k % dumpEvery === 0 || (rec.wrong && dumped < 60))) {
      if (rec.wrong) dumped++;
      dumpFrame(seq, k, img, rec, displayed && validH(res.H) ? res.H : null, path.join(dumpDir, `f${String(k).padStart(4, "0")}${rec.wrong ? "_WRONG" : ""}.png`));
    }
  }
  if (!blank && !cache && opts.writeCache !== false && opts.useCache !== false) writeFrameCache(seq, rendered, fp);

  // 성능 통계는 실제로 process()를 부른 프레임만
  const metrics = scenarioMetrics(
    {
      id: sc.id,
      category: sc.category,
      side: sc.side,
      title: sc.title,
      trackable,
      refFeatures: info?.features ?? 0,
    },
    records,
  );
  if (!trackable) {
    metrics.msTrack = { n: 0, median: null, p95: null, mean: null, max: null };
    metrics.msRedetect = { n: 0, median: null, p95: null, mean: null, max: null };
    metrics.msAll = { n: 0, median: null, p95: null, mean: null, max: null };
  }
  const stageMs: Record<string, number> = {};
  for (const [k, v] of Object.entries(stageSum)) stageMs[k] = Math.round((v / Math.max(1, stageN)) * 1000) / 1000;
  return { scenario: sc, seq, info, refMs, records, metrics, cached: !!cache, stageMs };
}

// ───────────────────────── 점검용 덤프 ─────────────────────────

const S = 2; // 확대 배율
const up = (p: Point): Point => ({ x: (p.x + 0.5) * S - 0.5, y: (p.y + 0.5) * S - 0.5 });
const STATE_COLOR: Record<TrackState, RGB> = {
  tracking: [255, 59, 48],
  weak: [255, 170, 0],
  lost: [120, 120, 120],
  searching: [90, 140, 255],
};

export function dumpRef(seq: Sequence, file: string): void {
  const c = Canvas.fromGray(seq.ref, S);
  c.poly(rectCorners(seq.roi).map(up), [255, 220, 0], 1);
  c.circle(up(seq.pinRef), 7, [0, 230, 0], 2);
  c.text(4, 4, `REF ${seq.scenario.id} ${seq.side === "customer" ? "CUSTOMER" : "ENGINEER"}`, [255, 255, 255], 1, [0, 0, 0]);
  c.writePng(file);
}

export function dumpFrame(seq: Sequence, k: number, img: GrayImage, rec: FrameRecord, H: Mat3 | null, file: string): void {
  const c = Canvas.fromGray(img, S);
  const gt = seq.gt[k];
  const gq = warpRect(gt.H, seq.roi);
  if (gq) c.poly(gq.map(up), [255, 220, 0], 1);
  if (H) {
    const eq = warpRect(H, seq.roi);
    if (eq) c.poly(eq.map(up), STATE_COLOR[rec.state], 1);
  }
  if (gt.pin) c.cross(up(gt.pin), 6, gt.occluded ? [0, 160, 255] : [0, 230, 0], 2);
  if (rec.estPin && rec.displayed) c.circle(up(rec.estPin), 7, STATE_COLOR[rec.state], 2);
  const err = rec.err === null ? "-" : Number.isFinite(rec.err) ? rec.err.toFixed(1) : "INF";
  c.text(4, 4, `#${k} T=${(rec.tMs / 1000).toFixed(2)} ${rec.state.toUpperCase()} ERR=${err}`, [255, 255, 255], 1, [0, 0, 0]);
  c.text(
    4,
    14,
    `INL=${rec.inliers} ${Number.isFinite(rec.ms) ? rec.ms.toFixed(1) : "-"}MS${rec.redetected ? " REDET" : ""}${gt.occluded ? " OCCL" : ""}${gt.inFrame ? "" : " OFFSCREEN"}`,
    [255, 255, 255],
    1,
    [0, 0, 0],
  );
  if (rec.wrong) {
    c.text(4, c.height - 12, "WRONG", [255, 0, 255], 1, [0, 0, 0]);
    c.poly(
      [
        { x: 0, y: 0 },
        { x: c.width - 1, y: 0 },
        { x: c.width - 1, y: c.height - 1 },
        { x: 0, y: c.height - 1 },
      ],
      [255, 0, 255],
      3,
    );
  }
  c.writePng(file);
}

export { buildSequence };
