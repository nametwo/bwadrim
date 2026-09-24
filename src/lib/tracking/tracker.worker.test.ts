import { describe, expect, it } from "vitest";
import { TrackerWorkerHost, type WorkerResponse } from "./tracker.worker";
import type { GrayImage, Mat3, PlanarTrackerApi, Point, Rect, ReferenceInfo, TrackResult } from "./types";

class FakeTracker implements PlanarTrackerApi {
  ref: GrayImage | null = null;
  initialH: Mat3 | undefined;
  anchor: Point | undefined;
  processed: number[] = [];
  throwOnProcess = false;
  info: Partial<ReferenceInfo> = {};
  setReference(ref: GrayImage, roi: Rect, initialH?: Mat3, anchor?: Point): ReferenceInfo {
    this.ref = ref;
    this.initialH = initialH;
    this.anchor = anchor;
    return { roi: { ...roi, width: roi.width + 10 }, features: 42, trackable: true, ...this.info };
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
      hint: null,
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
    expect(r.msg.result?.hint).toBeNull();
    expect(r.msg.result && "reason" in r.msg.result).toBe(false);
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
      hint: null,
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

  it("v2: passes the anchor point to setReference and validates it", () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi, anchor: { x: 5.5, y: 7.25 } });
    expect(trackers[0].anchor).toEqual({ x: 5.5, y: 7.25 });
    host.handle({ type: "setReference", gen: 2, ref: gray(), roi, anchor: null });
    expect(trackers[0].anchor).toBeUndefined();
    host.handle({ type: "setReference", gen: 3, ref: gray(), roi, anchor: { x: Number.NaN, y: 1 } });
    expect(out.at(-1)?.msg).toMatchObject({ type: "reference", gen: 3, info: null, error: "invalid reference" });
  });

  it("v2: reference reason passes through, unknown reasons are dropped", () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    trackers[0].info = { trackable: false, reason: "pin_blank" };
    host.handle({ type: "setReference", gen: 2, ref: gray(), roi });
    expect(out.at(-1)?.msg).toMatchObject({ type: "reference", gen: 2, info: { trackable: false, reason: "pin_blank" } });
    trackers[0].info = { reason: "bogus" as unknown as ReferenceInfo["reason"] };
    host.handle({ type: "setReference", gen: 3, ref: gray(), roi });
    const m = out.at(-1)!.msg;
    expect(m.type === "reference" && m.info && "reason" in m.info).toBe(false);
  });

  it("v2: hint and reason pass through for lost/offscreen; hint is dropped while H is shown", () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    const hint: Mat3 = [1, 0, -400, 0, 1, 0, 0, 0, 1];
    const results: TrackResult[] = [
      { state: "lost", H: null, hint, reason: "offscreen", confidence: 0, inliers: 0, tracked: 9, redetected: false, timings: { total: 1 } },
      { state: "tracking", H: [1, 0, 0, 0, 1, 0, 0, 0, 1], hint, confidence: 1, inliers: 9, tracked: 9, redetected: false, timings: { total: 1 } },
      { state: "lost", H: null, hint: [1, 2], reason: "nope" as never, confidence: 0, inliers: 0, tracked: 0, redetected: false, timings: { total: 1 } } as unknown as TrackResult,
      { state: "searching", H: null, hint: null, reason: "untrackable", confidence: 0, inliers: 0, tracked: 0, redetected: false, timings: { total: 1 } },
    ];
    let i = 0;
    trackers[0].process = () => results[i++];
    for (let k = 0; k < results.length; k++) host.handle({ type: "frame", gen: 1, frame: gray(), ts: k });
    const got = out.slice(1).map((o) => (o.msg.type === "result" ? o.msg.result : undefined));
    expect(got[0]).toMatchObject({ state: "lost", H: null, hint, reason: "offscreen" });
    expect(got[0]?.hint).not.toBe(hint); // 복사본
    expect(got[1]).toMatchObject({ state: "tracking", hint: null });
    expect(got[2]).toMatchObject({ state: "lost", hint: null });
    expect(got[2] && "reason" in got[2]).toBe(false);
    expect(got[3]).toMatchObject({ state: "searching", hint: null, reason: "untrackable" });
  });

  // ───────────── VideoFrame (Worker에서 읽기) ─────────────

  function fakeVF(opts: { format?: string | null; w?: number; h?: number; y?: number; hang?: boolean } = {}) {
    const w = opts.w ?? 64;
    const h = opts.h ?? 48;
    const f = {
      format: opts.format === undefined ? "I420" : opts.format,
      displayWidth: w,
      displayHeight: h,
      visibleRect: { x: 0, y: 0, width: w, height: h },
      colorSpace: { fullRange: true },
      closed: false,
      reads: 0,
      allocationSize(o?: { format?: string }) {
        if (o?.format || f.format !== "I420") throw new DOMException("nope", "NotSupportedError");
        return (w * h * 3) / 2;
      },
      copyTo(dest: Uint8Array) {
        f.reads++;
        if (opts.hang) return new Promise<PlaneLayout[]>(() => {});
        dest.fill(opts.y ?? 50, 0, w * h);
        return Promise.resolve([
          { offset: 0, stride: w },
          { offset: w * h, stride: w / 2 },
          { offset: (w * h * 5) / 4, stride: w / 2 },
        ]);
      },
      close() {
        f.closed = true;
      },
    };
    return f;
  }

  it("videoFrame: reads the Y plane in the worker, closes the frame, tracks, reports acquire time", async () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    const vf = fakeVF({ y: 9 });
    await host.handle({ type: "videoFrame", gen: 1, frame: vf as never, width: 32, height: 24, ts: 77 });
    expect(vf.closed).toBe(true);
    const r = out.at(-1)!;
    expect(r.msg).toMatchObject({ type: "result", gen: 1, frame: { width: 32, height: 24 } });
    if (r.msg.type !== "result") return;
    expect(r.msg.frame.data.length).toBe(0); // 버퍼는 Worker에 남는다
    expect(r.transfer).toEqual([]);
    expect(r.msg.result?.H).toEqual([1, 0, 9, 0, 1, 0, 0, 0, 1]); // 가짜 추적기: H[2] = 첫 픽셀 값 (전체 범위 9)
    expect(r.msg.acquireMs).toBeGreaterThan(0);
    expect(r.msg.processMs).toBeGreaterThanOrEqual(r.msg.acquireMs!);
    expect(trackers[0].processed).toEqual([77]);
  });

  it("videoFrame: stale generation is closed without reading; unsupported format is reported, tracker untouched", async () => {
    const { host, out, trackers } = setup();
    host.handle({ type: "setReference", gen: 2, ref: gray(), roi });
    const stale = fakeVF();
    await host.handle({ type: "videoFrame", gen: 1, frame: stale as never, width: 32, height: 24, ts: 1 });
    expect(stale.closed).toBe(true);
    expect(stale.reads).toBe(0);
    expect(out.at(-1)!.msg).toMatchObject({ type: "result", gen: 1, result: null });
    const odd = fakeVF({ format: "NV21" });
    await host.handle({ type: "videoFrame", gen: 2, frame: odd as never, width: 32, height: 24, ts: 2 });
    expect(odd.closed).toBe(true);
    expect(out.at(-1)!.msg).toMatchObject({ type: "result", gen: 2, result: null, unsupported: true });
    expect((out.at(-1)!.msg as { acquireError?: string }).acquireError).toContain("NV21");
    // 추적기는 그대로 → 다음 프레임은 정상
    await host.handle({ type: "videoFrame", gen: 2, frame: fakeVF() as never, width: 32, height: 24, ts: 3 });
    expect(out.at(-1)!.msg).toMatchObject({ type: "result", gen: 2, result: { state: "tracking" } });
    expect(trackers.length).toBe(1);
  });

  it("videoFrame: a read that never finishes times out and does not block later frames", async () => {
    const trackers: FakeTracker[] = [];
    const out: WorkerResponse[] = [];
    const host = new TrackerWorkerHost(
      () => {
        const t = new FakeTracker();
        trackers.push(t);
        return t;
      },
      (msg) => out.push(msg),
      () => performance.now(),
      20,
    );
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    const hung = fakeVF({ hang: true });
    const p1 = host.handle({ type: "videoFrame", gen: 1, frame: hung as never, width: 32, height: 24, ts: 1 });
    const p2 = host.handle({ type: "videoFrame", gen: 1, frame: fakeVF() as never, width: 32, height: 24, ts: 2 });
    await p1;
    await p2;
    expect(hung.closed).toBe(true);
    expect(out[1]).toMatchObject({ type: "result", result: null, unsupported: false });
    expect((out[1] as { acquireError?: string }).acquireError).toContain("timeout");
    expect(out[2]).toMatchObject({ type: "result", result: { state: "tracking" } });
  });

  it("videoFrame: malformed messages are rejected and the frame closed", async () => {
    const { host, out } = setup();
    host.handle({ type: "setReference", gen: 1, ref: gray(), roi });
    const vf = fakeVF();
    await host.handle({ type: "videoFrame", gen: 1, frame: vf as never, width: 0, height: 24, ts: 1 });
    expect(vf.closed).toBe(true);
    expect(out.at(-1)!.msg).toMatchObject({ type: "result", result: null, error: "invalid frame" });
    await host.handle({ type: "videoFrame", gen: 1, frame: null as never, width: 32, height: 24, ts: 1 });
    expect(out.at(-1)!.msg).toMatchObject({ type: "result", result: null, error: "invalid frame" });
  });
});
