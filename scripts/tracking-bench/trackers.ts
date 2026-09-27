// 벤치에 넣을 추적기들: planar(실제, 동적 import) + 하네스 검증용 기준선 oracle / null / shifted
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  GrayImage,
  Mat3,
  PlanarTrackerApi,
  Rect,
  ReferenceInfo,
  TrackResult,
  TrackerConfig,
} from "../../src/lib/tracking/types";
import { applyH, mul3 } from "../../src/lib/tracking/geometry";
import type { FrameGT, Sequence } from "./sequence";

export const TRACKER_PATH = path.resolve(__dirname, "../../src/lib/tracking/tracker.ts");

/** 벤치 안에서 쓰는 추적기: 계약(PlanarTrackerApi) + (기준선만) 정답 주입 훅 */
export interface BenchTracker extends PlanarTrackerApi {
  /** 벤치 전용 — process 직전에 그 프레임의 정답을 받는다 (oracle 계열만, 시간 측정 밖) */
  beforeFrame?(k: number, gt: FrameGT): void;
}

export interface TrackerFactory {
  name: string;
  /** 한 줄 설명 */
  describe: string;
  create(seq: Sequence): BenchTracker;
}

export type TrackerName = "planar" | "oracle" | "null" | "shifted";

const noTimings = { total: 0 };

/**
 * 정답 H를 그대로 돌려주는 추적기 → 지표가 완벽해야 한다 (하네스 검증).
 * 핀이 화면 밖(카메라 앞)이면 lost + reason=offscreen + hint=정답 H → 화면 밖 안내 방향 오차 0.
 */
class OracleTracker implements BenchTracker {
  private gt: FrameGT | null = null;
  private roi: Rect | null = null;
  constructor(
    private readonly pinRef: { x: number; y: number },
    private readonly shiftPx = 0,
  ) {}
  setReference(_ref: GrayImage, roi: Rect): ReferenceInfo {
    this.roi = roi;
    return { roi, features: 999, trackable: true };
  }
  clearReference(): void {
    this.roi = null;
  }
  hasReference(): boolean {
    return this.roi !== null;
  }
  beforeFrame(_k: number, gt: FrameGT): void {
    this.gt = gt;
  }
  process(): TrackResult {
    const gt = this.gt;
    if (!gt || !gt.pin) {
      return { state: "lost", H: null, hint: null, reason: "unverified", confidence: 0, inliers: 0, tracked: 0, redetected: false, timings: noTimings };
    }
    // 핀이 정확히 맞도록 (롤링 셔터·렌즈 왜곡·입체 시차 보정분만큼) 평행이동을 더한 정답 H
    const p = applyH(gt.H, this.pinRef);
    const H: Mat3 | null = p ? mul3([1, 0, gt.pin.x - p.x + this.shiftPx, 0, 1, gt.pin.y - p.y, 0, 0, 1], gt.H) : null;
    if (!gt.inFrame) {
      return { state: "lost", H: null, hint: H, reason: "offscreen", confidence: 0, inliers: 0, tracked: 0, redetected: false, timings: noTimings };
    }
    return { state: "tracking", H, hint: null, confidence: 1, inliers: 999, tracked: 999, redetected: false, timings: noTimings };
  }
}

/** 항상 못 찾는 추적기 → 추적률 0%, 틀린 표시 0% */
class NullTracker implements BenchTracker {
  private has = false;
  constructor(private readonly customer: boolean) {}
  setReference(_ref: GrayImage, roi: Rect): ReferenceInfo {
    this.has = true;
    return { roi, features: 0, trackable: true };
  }
  clearReference(): void {
    this.has = false;
  }
  hasReference(): boolean {
    return this.has;
  }
  process(): TrackResult {
    return {
      state: this.customer ? "searching" : "lost",
      H: null,
      hint: null,
      reason: "unverified",
      confidence: 0,
      inliers: 0,
      tracked: 0,
      redetected: false,
      timings: noTimings,
    };
  }
}

export function trackerExists(): boolean {
  return fs.existsSync(TRACKER_PATH);
}

type TrackerCtor = new (config?: Partial<TrackerConfig>) => PlanarTrackerApi;

/** src/lib/tracking/tracker.ts의 PlanarTracker (없으면 null — 다른 작업자가 아직 쓰는 중일 수 있다) */
export async function loadPlanarTracker(): Promise<TrackerCtor | null> {
  if (!trackerExists()) return null;
  const mod = (await import(pathToFileURL(TRACKER_PATH).href)) as { PlanarTracker?: TrackerCtor; default?: { PlanarTracker?: TrackerCtor } };
  const ctor = mod.PlanarTracker ?? mod.default?.PlanarTracker;
  if (typeof ctor !== "function") throw new Error(`${TRACKER_PATH} does not export class PlanarTracker`);
  return ctor;
}

export async function getTracker(name: TrackerName, config: Partial<TrackerConfig> = {}): Promise<TrackerFactory> {
  switch (name) {
    case "oracle":
      return { name, describe: "정답 H (지표 상한 확인)", create: (seq) => new OracleTracker(seq.pinRef) };
    case "shifted":
      return { name, describe: "정답 H + 10px 어긋남 (틀린 표시 집계 확인)", create: (seq) => new OracleTracker(seq.pinRef, 10) };
    case "null":
      return { name, describe: "항상 못 찾음 (지표 하한 확인)", create: (seq) => new NullTracker(seq.side === "customer") };
    case "planar": {
      const Ctor = await loadPlanarTracker();
      if (!Ctor) throw new Error(`추적기가 아직 없습니다: ${path.relative(process.cwd(), TRACKER_PATH)}`);
      return {
        name,
        describe: "src/lib/tracking/tracker.ts PlanarTracker",
        create: () => new Ctor({ ...config }) as BenchTracker,
      };
    }
  }
}
