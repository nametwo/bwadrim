import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnchorTracker, type FrameSourceLike, type WorkerLike } from "./client";
import { TrackerWorkerHost, type WorkerRequest } from "./tracker.worker";
import type { FrameSourceOptions } from "./frame-source";
import type { GrayImage, Mat3, PlanarTrackerApi, Rect, ReferenceInfo, TrackResult, TrackUpdate } from "./types";

class FakeTracker implements PlanarTrackerApi {
  static throwNext = false;
  initialH: Mat3 | undefined;
  hasRef = false;
  setReference(_ref: GrayImage, roi: Rect, initialH?: Mat3): ReferenceInfo {
    this.initialH = initialH;
    this.hasRef = true;
    return { roi, features: 50, trackable: true };
  }
  clearReference() {
    this.hasRef = false;
  }
  hasReference() {
    return this.hasRef;
  }
  process(frame: GrayImage): TrackResult {
    if (FakeTracker.throwNext) {
      FakeTracker.throwNext = false;
      throw new Error("tracker bug");
    }
    return {
      state: "tracking",
      H: [2, 0, 0, 0, 2, 0, 0, 0, 1],
      confidence: 0.8,
      inliers: 20,
      tracked: 25,
      redetected: false,
      timings: { total: frame.width / 10 },
    };
  }
}

/** 가짜 Worker: 메시지를 큐에 쌓고 flush() 때 진짜 TrackerWorkerHost로 처리해 응답을 비동기처럼 전달 */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  inbox: { msg: WorkerRequest; transfer?: Transferable[] }[] = [];
  outbox: unknown[] = [];
  terminated = false;
  trackers: FakeTracker[] = [];
  host = new TrackerWorkerHost(
    () => {
      const t = new FakeTracker();
      this.trackers.push(t);
      return t;
    },
    (msg) => this.outbox.push(msg),
    () => 0,
  );
  postMessage(msg: WorkerRequest, transfer?: Transferable[]) {
    if (this.terminated) throw new Error("terminated");
    this.inbox.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  flush() {
    while (this.inbox.length) this.host.handle(this.inbox.shift()!.msg);
    while (this.outbox.length) this.onmessage?.({ data: this.outbox.shift() } as MessageEvent);
  }
  crash() {
    this.onerror?.(Object.assign(new Event("error"), { message: "boom" }));
  }
}

class FakeSource implements FrameSourceLike {
  running = false;
  released: { buf: ArrayBuffer | ArrayBufferView | null | undefined; ms?: number }[] = [];
  destroyed = false;
  constructor(public opts: FrameSourceOptions) {}
  start() {
    this.running = true;
  }
  stop() {
    this.running = false;
  }
  release(buf?: ArrayBuffer | ArrayBufferView | null, ms?: number) {
    this.released.push({ buf, ms });
  }
  grab(): GrayImage | null {
    return { width: 4, height: 3, data: new Uint8Array(12) };
  }
  destroy() {
    this.destroyed = true;
  }
  frameSize() {
    return { width: 320, height: 240 };
  }
  emit(w = 320, h = 240, ts = 0) {
    const data = new Uint8Array(w * h);
    this.opts.onFrame({ width: w, height: h, data }, ts);
    return data;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  let source!: FakeSource;
  const updates: TrackUpdate[] = [];
  const tracker = new AnchorTracker({} as HTMLVideoElement, {
    fps: 20,
    onUpdate: (u) => updates.push(u),
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    createFrameSource: (_v, o) => (source = new FakeSource(o)),
  });
  return { tracker, workers, source: () => source, updates };
}

const ref = (w = 320, h = 240): GrayImage => ({ width: w, height: h, data: new Uint8Array(w * h).fill(3) });
const roi = { x: 100, y: 60, width: 120, height: 120 };
const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("AnchorTracker", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    FakeTracker.throwNext = false;
  });

  it("lazily creates the worker, sets the reference and starts the loop", async () => {
    const t = setup();
    expect(t.workers.length).toBe(0);
    expect(t.source().opts.maxFps).toBe(20);
    const r = ref();
    const p = t.tracker.setAnchor({ id: "a1", ref: r, roi, initialH: I });
    expect(t.workers.length).toBe(1);
    expect(t.source().running).toBe(true);
    const posted = t.workers[0].inbox[0];
    expect(posted.msg.type).toBe("setReference");
    expect(posted.transfer).toBeUndefined(); // 복사로 보낸다 (호출측 버퍼 유지)
    t.workers[0].flush();
    await expect(p).resolves.toEqual({ roi, features: 50, trackable: true });
    expect(t.workers[0].trackers[0].initialH).toEqual(I);
    expect(r.data.length).toBe(320 * 240);
  });

  it("frames round-trip with transfer and produce TrackUpdates", async () => {
    const t = setup();
    t.tracker.setAnchor({ id: "a1", ref: ref(), roi, initialH: I });
    const data = t.source().emit(320, 240, 1000);
    const post = t.workers[0].inbox[1];
    expect(post.msg.type).toBe("frame");
    expect(post.transfer).toEqual([data.buffer]);
    t.workers[0].flush();
    expect(t.source().released.length).toBe(1);
    expect(t.source().released[0].buf).toBe(data);
    expect(t.source().released[0].ms).toBe(0);
    expect(t.updates.length).toBe(1);
    expect(t.updates[0]).toEqual({
      anchorId: "a1",
      state: "tracking",
      H: [2, 0, 0, 0, 2, 0, 0, 0, 1],
      confidence: 0.8,
      refSize: { width: 320, height: 240 },
      frameSize: { width: 320, height: 240 },
      processMs: 0,
    });
    expect(t.tracker.latest()).toEqual(t.updates[0]);
  });

  it("ignores results that belong to a replaced anchor", async () => {
    const t = setup();
    const p1 = t.tracker.setAnchor({ id: "a1", ref: ref(), roi, initialH: I });
    t.source().emit();
    const p2 = t.tracker.setAnchor({ id: "a2", ref: ref(), roi });
    await expect(p1).resolves.toBeNull();
    t.workers[0].flush();
    expect(t.updates.length).toBe(0); // a1 세대 프레임 결과는 버림
    expect(t.source().released.length).toBe(1); // 버퍼는 돌려받음
    await expect(p2).resolves.not.toBeNull();
    t.source().emit();
    t.workers[0].flush();
    expect(t.updates.map((u) => u.anchorId)).toEqual(["a2"]);
    expect(t.workers[0].trackers[0].initialH).toBeUndefined();
  });

  it("clearAnchor stops the loop and drops in-flight results", () => {
    const t = setup();
    t.tracker.setAnchor({ id: "a1", ref: ref(), roi, initialH: I });
    t.source().emit();
    t.tracker.clearAnchor();
    expect(t.source().running).toBe(false);
    expect(t.workers[0].inbox.at(-1)?.msg.type).toBe("clear");
    t.workers[0].flush();
    expect(t.updates.length).toBe(0);
    expect(t.tracker.latest()).toBeNull();
    expect(t.tracker.anchorId()).toBeNull();
    // 앵커 없이 온 프레임은 바로 반환
    t.source().emit();
    expect(t.source().released.length).toBe(2);
  });

  it("recovers from a worker crash in search mode, then gives up after maxRestarts", async () => {
    const t = setup();
    const p = t.tracker.setAnchor({ id: "a1", ref: ref(), roi, initialH: I });
    t.source().emit();
    t.workers[0].crash();
    expect(t.workers[0].terminated).toBe(true);
    expect(t.updates.at(-1)).toMatchObject({ anchorId: "a1", state: "lost", H: null });
    expect(t.source().released.at(-1)?.buf).toBeNull(); // in-flight 프레임 포기
    expect(t.workers.length).toBe(2);
    const re = t.workers[1].inbox.find((m) => m.msg.type === "setReference")!;
    expect(re.msg.type === "setReference" && re.msg.initialH).toBeNull(); // 탐색 모드
    t.workers[1].flush();
    await expect(p).resolves.not.toBeNull(); // 처음 약속이 새 세대 결과로 이어짐
    t.source().emit();
    t.workers[1].flush();
    expect(t.updates.at(-1)?.state).toBe("tracking");
    // 계속 죽으면 3회 후 포기
    t.workers[1].crash();
    t.workers[2].crash();
    t.workers[3].crash();
    expect(t.workers.length).toBe(4);
    expect(t.source().running).toBe(false);
    expect(t.updates.at(-1)?.state).toBe("lost");
  });

  it("tracker exception inside the worker triggers a re-reference", () => {
    const t = setup();
    t.tracker.setAnchor({ id: "a1", ref: ref(), roi, initialH: I });
    t.workers[0].flush();
    FakeTracker.throwNext = true;
    t.source().emit();
    t.workers[0].flush();
    expect(t.updates.at(-1)?.state).toBe("lost");
    expect(t.workers.length).toBe(1); // Worker는 살아 있음
    t.source().emit();
    t.workers[0].flush();
    expect(t.updates.at(-1)?.state).toBe("tracking");
  });

  it("destroy terminates the worker, resolves pending and destroys the source", async () => {
    const t = setup();
    const p = t.tracker.setAnchor({ id: "a1", ref: ref(), roi });
    t.tracker.destroy();
    await expect(p).resolves.toBeNull();
    expect(t.workers[0].terminated).toBe(true);
    expect(t.source().destroyed).toBe(true);
    await expect(t.tracker.setAnchor({ id: "a2", ref: ref(), roi })).resolves.toBeNull();
    expect(t.tracker.captureGray()).toBeNull();
  });

  it("rejects invalid references without creating a worker", async () => {
    const t = setup();
    await expect(
      t.tracker.setAnchor({ id: "a", ref: { width: 10, height: 10, data: new Uint8Array(3) }, roi }),
    ).resolves.toBeNull();
    expect(t.workers.length).toBe(0);
  });

  it("worker creation failure → null + lost, never throws", async () => {
    const updates: TrackUpdate[] = [];
    const tr = new AnchorTracker({} as HTMLVideoElement, {
      onUpdate: (u) => updates.push(u),
      createWorker: () => {
        throw new Error("no workers here");
      },
      createFrameSource: (_v, o) => new FakeSource(o),
    });
    await expect(tr.setAnchor({ id: "a", ref: ref(), roi })).resolves.toBeNull();
    expect(updates.at(-1)?.state).toBe("lost");
  });

  it("captureGray delegates to the frame source", () => {
    const t = setup();
    expect(t.tracker.captureGray()?.width).toBe(4);
    expect(t.tracker.frameSize()).toEqual({ width: 320, height: 240 });
  });
});
