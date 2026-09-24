import { describe, expect, it } from "vitest";
import { TrackerWorkerHost, type WorkerResponse } from "./tracker.worker";
import type { GrayImage, Mat3, PlanarTrackerApi, Rect, ReferenceInfo, TrackResult } from "./types";

class FakeTracker implements PlanarTrackerApi {
  ref: GrayImage | null = null;
  initialH: Mat3 | undefined;
  processed: number[] = [];
  throwOnProcess = false;
  setReference(ref: GrayImage, roi: Rect, initialH?: Mat3): ReferenceInfo {
    this.ref = ref;
    this.initialH = initialH;
    return { roi: { ...roi, width: roi.width + 10 }, features: 42, trackable: true };
  }
  clearReference() {
    this.ref = null;
  }
  hasReference() {
    return this.ref !== null;
  }
  process(frame: GrayImage, ts: number): TrackResult {
    if (this.throwOnProcess) throw new Error("kaboom");
    this.processed.push(ts);
    return {
      state: "tracking",
      H: [1, 0, frame.data[0], 0, 1, 0, 0, 0, 1],
      confidence: 0.9,
      inliers: 30,
      tracked: 40,
      redetected: false,
      timings: { total: 2, lk: 1 },
    };
  }
}

function setup() {
  const trackers: FakeTracker[] = [];
  const out: { msg: WorkerResponse; transfer: Transferable[] }[] = [];
  let t = 0;
  const host = new TrackerWorkerHost(
    () => {
      const tr = new FakeTracker();
      trackers.push(tr);
      return tr;
    },
    (msg, transfer) => out.push({ msg, transfer }),
    () => (t += 5),
  );
  return { host, out, trackers };
}

const gray = (w = 32, h = 24, v = 7) => ({ width: w, height: h, data: new Uint8Array(w * h).fill(v) });
const roi = { x: 1, y: 2, width: 10, height: 10 };

describe("TrackerWorkerHost", () => {
  it("setReference → reference info; frame → result with buffer transferred back", () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi, initialH: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
    expect(out[0].msg).toEqual({
      type: "reference",
      gen: 1,
      info: { roi: { x: 1, y: 2, width: 20, height: 10 }, features: 42, trackable: true },
    });
    expect(trackers[0].initialH).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const f = gray(32, 24, 9);
    host.handle({ type: "frame", gen: 1, frame: f, ts: 123 });
    const r = out[1];
    expect(r.msg.type).toBe("result");
    if (r.msg.type !== "result") return;
    expect(r.msg.gen).toBe(1);
    expect(r.msg.result?.state).toBe("tracking");
    expect(r.msg.result?.H).toEqual([1, 0, 9, 0, 1, 0, 0, 0, 1]);
    expect(r.msg.result?.timings).toEqual({ total: 2, lk: 1 });
    expect(r.msg.processMs).toBe(5);
    expect(r.msg.frame.data).toBe(f.data);
    expect(r.transfer).toEqual([f.data.buffer]);
    expect(trackers[0].processed).toEqual([123]);
  });

  it("frames of another generation are returned unprocessed", () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 2, ref: gray(), roi });
    host.handle({ type: "frame", gen: 1, frame: gray(), ts: 1 });
    host.handle({ type: "clear", gen: 3 });
    host.handle({ type: "frame", gen: 2, frame: gray(), ts: 2 });
    const results = out.filter((o) => o.msg.type === "result");
    expect(results.length).toBe(2);
    for (const r of results) {
      if (r.msg.type === "result") expect(r.msg.result).toBeNull();
      expect(r.transfer.length).toBe(1);
    }
    expect(trackers[0].processed).toEqual([]);
  });

  it("tracker exceptions are reported and the tracker is replaced", () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    trackers[0].throwOnProcess = true;
    host.handle({ type: "frame", gen: 1, frame: gray(), ts: 1 });
    const r = out[1].msg;
    expect(r.type === "result" && r.error).toContain("kaboom");
    expect(r.type === "result" && r.result).toBeNull();
    expect(out[1].transfer.length).toBe(1); // 버퍼는 돌려준다
    // 같은 세대의 이후 프레임은 기준이 없으므로 처리하지 않음
    host.handle({ type: "frame", gen: 1, frame: gray(), ts: 2 });
    expect(out[2].msg.type === "result" && out[2].msg.result).toBeNull();
    // 새 기준 → 새 추적기
    host.handle({ type: "setReference", gen: 2, ref: gray(), roi });
    expect(trackers.length).toBe(2);
    host.handle({ type: "frame", gen: 2, frame: gray(), ts: 3 });
    expect(out[4].msg.type === "result" && out[4].msg.result?.state).toBe("tracking");
  });

  it("rejects malformed messages without throwing", () => {
    const { host, out } = setup();
    expect(() => host.handle(null)).not.toThrow();
    expect(() => host.handle("x")).not.toThrow();
    expect(() => host.handle({ type: "nope" })).not.toThrow();
    host.handle({ type: "setReference", gen: 1, ref: { width: 10, height: 10, data: new Uint8Array(5) }, roi });
    expect(out.at(-1)?.msg).toMatchObject({ type: "reference", gen: 1, info: null });
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi: { x: Number.NaN, y: 0, width: 1, height: 1 } });
    expect(out.at(-1)?.msg).toMatchObject({ type: "reference", info: null });
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi, initialH: [1, 2] });
    expect(out.at(-1)?.msg).toMatchObject({ type: "reference", info: null });
    const bad = new Uint8Array(3);
    host.handle({ type: "frame", gen: 1, frame: { width: 10, height: 10, data: bad }, ts: 0 });
    const last = out.at(-1)!;
    expect(last.msg).toMatchObject({ type: "result", result: null, error: "invalid frame" });
    expect(last.transfer).toEqual([bad.buffer]);
    host.handle({ type: "frame", gen: 1, frame: null, ts: 0 });
    expect(out.at(-1)?.msg).toEqual({ type: "error", message: "invalid frame" });
  });

  it("drops H when the state says it should not be shown", () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    trackers[0].process = () => ({
      state: "lost",
      H: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      confidence: Number.NaN,
      inliers: 0,
      tracked: 0,
      redetected: true,
      timings: { total: 1 },
    });
    host.handle({ type: "frame", gen: 1, frame: gray(), ts: 1 });
    const m = out[1].msg;
    expect(m.type === "result" && m.result).toMatchObject({ state: "lost", H: null, confidence: 0, redetected: true });
  });

  it("config message recreates the tracker lazily", () => {
    const { host, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    host.handle({ type: "config", config: { maxTrackedPoints: 10 } });
    host.handle({ type: "setReference", gen: 2, ref: gray(), roi });
    expect(trackers.length).toBe(2);
  });
});
