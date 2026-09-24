import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jpeg from "jpeg-js";
import type { DataLink, LinkData } from "@/lib/webrtc/data-link";
import {
  CustomerAnchorSession,
  EngineerAnchorSession,
  simplifyStroke,
  type Clock,
  type PointerSample,
  type TrackerLike,
} from "./session";
import type { AnchorSpec } from "./client";
import type { CapturedReference } from "./capture";
import { roiFromStroke, roiFromTap } from "./capture";
import { parseMessage } from "./protocol";
import type { GrayImage, Mat3, ReferenceInfo, TrackState, TrackUpdate } from "./types";
import { applyH } from "./geometry";

// ───────────────────────── 가짜 부품 ─────────────────────────

class FakeTracker implements TrackerLike {
  calls: AnchorSpec[] = [];
  cleared = 0;
  destroyed = false;
  size = { width: 320, height: 240 };
  trackable = true;
  manual = false;
  pending: ((i: ReferenceInfo | null) => void)[] = [];
  onUpdate: (u: TrackUpdate) => void = () => {};
  setAnchor(spec: AnchorSpec): Promise<ReferenceInfo | null> {
    this.calls.push(spec);
    // AnchorTracker처럼: 이전 약속은 null로
    for (const r of this.pending) r(null);
    this.pending = [];
    return new Promise((resolve) => {
      if (this.manual) this.pending.push(resolve);
      else resolve({ roi: spec.roi, features: 60, trackable: this.trackable });
    });
  }
  clearAnchor() {
    this.cleared++;
    for (const r of this.pending) r(null);
    this.pending = [];
  }
  frameSize() {
    return this.size;
  }
  destroy() {
    this.destroyed = true;
  }
  emit(anchorId: string, state: TrackState, H: Mat3 | null, frameSize = this.size) {
    this.onUpdate({
      anchorId,
      state,
      H,
      confidence: state === "tracking" ? 0.9 : 0.3,
      refSize: { width: 320, height: 240 },
      frameSize,
      processMs: 4,
    });
  }
}

class FakeClock implements Clock {
  t = 0;
  timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

class End implements DataLink {
  msgCbs = new Set<(d: LinkData) => void>();
  openCbs = new Set<(o: boolean) => void>();
  inbox: LinkData[] = [];
  sent: LinkData[] = [];
  peer!: End;
  /** 다음 n번의 send를 실패시킨다 (큐 넘침 흉내) */
  failNext = 0;
  constructor(private state: { open: boolean }) {}
  send(d: LinkData) {
    if (!this.state.open) return false;
    if (this.failNext > 0) {
      this.failNext--;
      return false;
    }
    this.sent.push(d);
    this.peer.inbox.push(d);
    return true;
  }
  onMessage(cb: (d: LinkData) => void) {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }
  onOpenChange(cb: (o: boolean) => void) {
    this.openCbs.add(cb);
    return () => this.openCbs.delete(cb);
  }
  isOpen() {
    return this.state.open;
  }
  bufferedAmount() {
    return 0;
  }
  deliver() {
    let n = 0;
    while (this.inbox.length) {
      const d = this.inbox.shift()!;
      for (const cb of [...this.msgCbs]) cb(d);
      n++;
    }
    return n;
  }
  texts() {
    return this.sent.filter((m): m is string => typeof m === "string").map((m) => parseMessage(m));
  }
}

function linkPair(open = true) {
  const state = { open };
  const e = new End(state);
  const c = new End(state);
  e.peer = c;
  c.peer = e;
  return {
    e,
    c,
    setOpen(v: boolean) {
      state.open = v;
      if (!v) {
        e.inbox = [];
        c.inbox = [];
      }
      for (const cb of [...e.openCbs]) cb(v);
      for (const cb of [...c.openCbs]) cb(v);
    },
    flush() {
      while (e.deliver() + c.deliver() > 0) {
        // 양쪽이 조용해질 때까지
      }
    },
  };
}

function makeJpeg(w: number, h: number): Blob {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const px = i / 4;
    const v = ((px % w) * 7 + Math.floor(px / w) * 3) & 255;
    data[i] = v;
    data[i + 1] = 255 - v;
    data[i + 2] = (v * 3) & 255;
    data[i + 3] = 255;
  }
  const enc = jpeg.encode({ data, width: w, height: h }, 80);
  return new Blob([new Uint8Array(enc.data)], { type: "image/jpeg" });
}

const JPEG_640 = makeJpeg(640, 480);
const gray = (w = 320, h = 240): GrayImage => ({ width: w, height: h, data: new Uint8Array(w * h).fill(9) });

function setup(opts: { open?: boolean } = {}) {
  const pair = linkPair(opts.open ?? true);
  const clock = new FakeClock();
  const trackers: FakeTracker[] = [];
  const createTracker = (_v: HTMLVideoElement, o: { fps: number; onUpdate: (u: TrackUpdate) => void }) => {
    const t = new FakeTracker();
    t.onUpdate = o.onUpdate;
    trackers.push(t);
    return t;
  };
  let captures = 0;
  const capture = (): CapturedReference => {
    captures++;
    return { gray: gray(), jpeg: Promise.resolve(JPEG_640), jpegSize: { width: 640, height: 480 } };
  };
  const decodes: { size: { width: number; height: number } }[] = [];
  let failDecode = false;
  const urls = { created: [] as string[], revoked: [] as string[] };
  const video = {} as HTMLVideoElement;
  const eng = new EngineerAnchorSession({ video, link: pair.e, deps: { createTracker, capture, clock } });
  const cust = new CustomerAnchorSession({
    video,
    link: pair.c,
    deps: {
      createTracker,
      clock,
      decode: async (_b, size) => {
        decodes.push({ size });
        if (failDecode) throw new Error("bad jpeg");
        return gray(size.width, size.height);
      },
      createObjectURL: () => {
        const u = `blob:${urls.created.length}`;
        urls.created.push(u);
        return u;
      },
      revokeObjectURL: (u) => urls.revoked.push(u),
    },
  });
  const [et, ct] = trackers;
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      pair.flush();
    }
  };
  // css = frame × 2 (폰 화면이 작업 해상도보다 큼)
  const sample = (fx: number, fy: number, t = clock.t, pointerId = 1): PointerSample => ({
    pointerId,
    css: { x: fx * 2, y: fy * 2 },
    frame: { x: fx, y: fy },
    t,
  });
  const tap = (fx: number, fy: number) => {
    eng.handlePointer("down", sample(fx, fy));
    clock.advance(80);
    eng.handlePointer("up", sample(fx, fy));
  };
  return {
    pair,
    clock,
    eng,
    cust,
    et,
    ct,
    settle,
    sample,
    tap,
    decodes,
    urls,
    captures: () => captures,
    setFailDecode: (v: boolean) => {
      failDecode = v;
    },
  };
}

// ───────────────────────── 테스트 ─────────────────────────

describe("simplifyStroke", () => {
  it("collapses a straight line to its endpoints", () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 2 * i + 1 }));
    expect(simplifyStroke(pts, 0.5, 500)).toEqual([pts[0], pts[99]]);
  });

  it("keeps corners of a zigzag", () => {
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: i, y: (i % 10 < 5 ? i % 10 : 10 - (i % 10)) * 4 });
    const s = simplifyStroke(pts, 0.5, 500);
    expect(s[0]).toEqual(pts[0]);
    expect(s.at(-1)).toEqual(pts[40]);
    expect(s.length).toBeGreaterThanOrEqual(9);
    expect(s.length).toBeLessThan(pts.length);
  });

  it("respects maxPoints on noisy input", () => {
    const pts = Array.from({ length: 3000 }, (_, i) => ({ x: i * 0.5, y: Math.sin(i) * 20 }));
    const s = simplifyStroke(pts, 0.1, 500);
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s.length).toBeGreaterThan(10);
  });

  it("degenerate inputs", () => {
    expect(simplifyStroke([], 1, 500)).toEqual([]);
    expect(simplifyStroke([{ x: 1, y: 1 }], 1, 500)).toEqual([{ x: 1, y: 1 }]);
    const same = Array.from({ length: 10 }, () => ({ x: 5, y: 5 }));
    expect(simplifyStroke(same, 1, 500).length).toBe(2);
  });
});

describe("engineer ↔ customer sessions", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("tap → new anchor tracked with I, sent with JPEG, customer searches with the same ref and ROI", async () => {
    const s = setup();
    s.tap(100, 80);
    // 누르는 순간 새 앵커: 단위행렬로 추적 시작 + 합성 갱신
    expect(s.et.calls.length).toBe(1);
    const call = s.et.calls[0];
    expect(call.initialH).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(call.roi).toEqual(roiFromTap({ x: 100, y: 80 }, 320, 240));
    let snap = s.eng.getSnapshot();
    expect(snap.anchor?.annotations).toEqual([{ id: expect.any(String), kind: "pin", p: { x: 0.3125, y: 0.3333 } }]);
    expect(snap.update?.state).toBe("tracking");
    expect(snap.update?.H).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(snap.customerState).toBeNull();

    await s.settle();
    snap = s.eng.getSnapshot();
    expect(snap.trackable).toBe(true);
    // 전송: 헤더 + 조각
    const header = parseMessage(s.pair.e.sent[0] as string);
    expect(header?.t).toBe("anchor");
    expect(s.pair.e.sent.slice(1).every((m) => m instanceof ArrayBuffer)).toBe(true);

    // 고객: JPEG → ref 크기 그레이 → initialH 없이 탐색
    expect(s.decodes).toEqual([{ size: { width: 320, height: 240 } }]);
    expect(s.ct.calls.length).toBe(1);
    expect(s.ct.calls[0].initialH).toBeUndefined();
    expect(s.ct.calls[0].roi.x).toBeCloseTo(call.roi.x, 1);
    expect(s.ct.calls[0].roi.width).toBeCloseTo(call.roi.width, 1);
    const cs = s.cust.getSnapshot();
    expect(cs.anchor).toEqual(snap.anchor);
    expect(cs.cardUrl).toBe("blob:0");
    expect(cs.showCard).toBe(false);
    // 고객 status(searching)가 엔지니어에게
    expect(s.eng.getSnapshot().customerState).toBe("searching");
  });

  it("customer status follows tracking; card appears after 0.8s of searching/lost", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const id = s.eng.getSnapshot().anchor!.id;
    s.clock.advance(700);
    expect(s.cust.getSnapshot().showCard).toBe(false);
    s.clock.advance(150);
    expect(s.cust.getSnapshot().showCard).toBe(true);
    s.ct.emit(id, "tracking", [1, 0, 5, 0, 1, 3, 0, 0, 1]);
    s.pair.flush();
    expect(s.cust.getSnapshot().showCard).toBe(false);
    expect(s.cust.getSnapshot().update?.state).toBe("tracking");
    expect(s.eng.getSnapshot().customerState).toBe("tracking");
    // weak는 카드 없음
    s.clock.advance(200);
    s.ct.emit(id, "weak", [1, 0, 5, 0, 1, 3, 0, 0, 1]);
    s.clock.advance(2000);
    expect(s.cust.getSnapshot().showCard).toBe(false);
    s.pair.flush();
    expect(s.eng.getSnapshot().customerState).toBe("weak");
    // lost 0.8초 → 카드
    s.ct.emit(id, "lost", null);
    s.clock.advance(799);
    expect(s.cust.getSnapshot().showCard).toBe(false);
    s.clock.advance(2);
    expect(s.cust.getSnapshot().showCard).toBe(true);
    s.pair.flush();
    expect(s.eng.getSnapshot().customerState).toBe("lost");
  });

  it("status messages are rate-limited but the last state always arrives", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const id = s.eng.getSnapshot().anchor!.id;
    const before = s.pair.c.sent.length;
    const states: TrackState[] = ["tracking", "weak", "tracking", "lost", "tracking", "weak"];
    for (const st of states) {
      s.ct.emit(id, st, st === "lost" ? null : [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      s.clock.advance(10);
    }
    s.clock.advance(500);
    s.pair.flush();
    const sent = s.pair.c.sent.slice(before).map((m) => parseMessage(m as string));
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent.at(-1)).toMatchObject({ t: "status", state: "weak" });
    expect(s.eng.getSnapshot().customerState).toBe("weak");
  });

  it("tap inside the tracked ROI adds to the same anchor via H⁻¹", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const id = s.eng.getSnapshot().anchor!.id;
    // 카메라가 오른쪽으로 20px, 아래로 10px 이동한 셈
    const H: Mat3 = [1, 0, 20, 0, 1, 10, 0, 0, 1];
    s.et.emit(id, "tracking", H);
    s.tap(190, 140); // ref (170, 130)
    await s.settle();
    const anns = s.eng.getSnapshot().anchor!.annotations;
    expect(anns.length).toBe(2);
    expect(anns[1]).toMatchObject({ kind: "pin", p: { x: quantize(170 / 320), y: quantize(130 / 240) } });
    expect(s.et.calls.length).toBe(1); // 기준 재설정 없음
    expect(s.pair.e.texts().at(-1)).toMatchObject({ t: "ann", anchorId: id });
    expect(s.cust.getSnapshot().anchor!.annotations).toEqual(anns);
  });

  it("tap outside the ROI (or while not tracking) replaces the anchor", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const first = s.eng.getSnapshot().anchor!.id;
    s.et.emit(first, "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    s.tap(20, 20); // ROI(100..220) 밖
    await s.settle();
    const second = s.eng.getSnapshot().anchor!;
    expect(second.id).not.toBe(first);
    expect(second.annotations.length).toBe(1);
    expect(s.cust.getSnapshot().anchor?.id).toBe(second.id);
    expect(s.urls.revoked).toEqual(["blob:0"]);
    expect(s.cust.getSnapshot().cardUrl).toBe("blob:1");
    // lost 상태에서는 ROI 안이어도 새 앵커
    s.et.emit(second.id, "lost", null);
    s.tap(20, 20);
    expect(s.eng.getSnapshot().anchor!.id).not.toBe(second.id);
  });

  it("drag → stroke: live draft, simplified points, ROI re-set around the stroke with the current H", async () => {
    const s = setup();
    s.eng.handlePointer("down", s.sample(60, 100));
    const id = s.eng.getSnapshot().anchor!.id;
    // 드래그 중 카메라가 살짝 움직임 → ref 좌표로 보정되어야 한다
    const H: Mat3 = [1, 0, 4, 0, 1, 2, 0, 0, 1];
    for (let i = 1; i <= 60; i++) {
      if (i === 30) s.et.emit(id, "tracking", H);
      s.clock.advance(16);
      s.eng.handlePointer("move", s.sample(60 + i * 2, 100 + (i % 2) * 0.1));
    }
    s.clock.advance(20);
    const draft = s.eng.getSnapshot().anchor!.annotations.find((a) => a.id === "draft");
    expect(draft?.kind).toBe("stroke");
    s.eng.handlePointer("up", s.sample(180, 100));
    await s.settle();
    const snap = s.eng.getSnapshot();
    expect(snap.anchor!.annotations.length).toBe(1);
    const stroke = snap.anchor!.annotations[0];
    expect(stroke.kind).toBe("stroke");
    if (stroke.kind !== "stroke") return;
    expect(stroke.points.length).toBeLessThan(20);
    // 마지막 점: frame (180,100) → ref (176, 98)
    expect(stroke.points.at(-1)!.x).toBeCloseTo(176 / 320, 3);
    expect(stroke.points.at(-1)!.y).toBeCloseTo(98 / 240, 3);
    // 선 기준으로 ROI 재설정 + 현재 H로 즉시 추적
    expect(s.et.calls.length).toBe(2);
    expect(s.et.calls[1].id).toBe(id);
    expect(s.et.calls[1].initialH).toEqual(H);
    const refPts = stroke.points.map((p) => ({ x: p.x * 320, y: p.y * 240 }));
    const want = roiFromStroke(refPts, 320, 240);
    expect(s.et.calls[1].roi.x).toBeCloseTo(want.x, 0);
    expect(s.et.calls[1].roi.width).toBeCloseTo(want.width, 0);
    expect(snap.trackable).toBe(true); // 대체된 첫 setAnchor(null)가 뒤집지 않음
    expect(s.cust.getSnapshot().anchor?.annotations).toEqual(snap.anchor!.annotations);
  });

  it("shows a draft pin at touch-down, replaced by the real pin on release", () => {
    const s = setup();
    s.eng.handlePointer("down", s.sample(100, 60));
    const d = s.eng.getSnapshot().anchor!.annotations;
    expect(d).toEqual([{ id: "draft", kind: "pin", p: { x: 0.3125, y: 0.25 } }]);
    s.eng.handlePointer("up", s.sample(100, 60));
    const a = s.eng.getSnapshot().anchor!.annotations;
    expect(a.length).toBe(1);
    expect(a[0].id).not.toBe("draft");
  });

  it("retries the whole transfer when a send fails while the link stays open", async () => {
    const s = setup();
    s.pair.e.failNext = 2; // 첫 시도와 첫 재시도 실패
    s.tap(160, 120);
    await s.settle();
    expect(s.cust.getSnapshot().anchor).toBeNull();
    s.clock.advance(1000);
    await s.settle();
    expect(s.cust.getSnapshot().anchor).toBeNull();
    s.clock.advance(1000);
    await s.settle();
    expect(s.cust.getSnapshot().anchor?.id).toBe(s.eng.getSnapshot().anchor?.id);
    // 성공 후에는 재시도 타이머가 남지 않는다 (남은 것은 고객 카드 타이머뿐)
    expect((s.eng as unknown as { resendTimer: unknown }).resendTimer).toBeNull();
  });

  it("a failed ann send triggers a full resend", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const id = s.eng.getSnapshot().anchor!.id;
    s.et.emit(id, "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    s.pair.e.failNext = 1;
    s.tap(165, 125);
    s.pair.flush();
    expect(s.cust.getSnapshot().anchor?.annotations.length).toBe(1);
    s.clock.advance(1000);
    await s.settle();
    expect(s.cust.getSnapshot().anchor?.annotations.length).toBe(2);
    expect(s.decodes.length).toBe(1); // 같은 앵커 → 다시 디코딩하지 않음
  });

  it("a full anchor (50 annotations) ignores taps inside its ROI instead of wiping them", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const id = s.eng.getSnapshot().anchor!.id;
    for (let i = 0; i < 60; i++) {
      s.et.emit(id, "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      s.tap(150 + (i % 10), 110 + Math.floor(i / 10));
    }
    const snap = s.eng.getSnapshot();
    expect(snap.anchor!.id).toBe(id);
    expect(snap.anchor!.annotations.length).toBe(50);
    expect(snap.anchor!.annotations.some((a) => a.id === "draft")).toBe(false);
    await s.settle();
    expect(s.cust.getSnapshot().anchor!.annotations.length).toBe(50);
  });

  it("clear() during a new-anchor gesture does not resurrect the previous anchor", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const calls = s.et.calls.length;
    s.eng.handlePointer("down", s.sample(10, 10)); // 새 앵커 제스처 시작
    s.eng.clear();
    s.eng.handlePointer("up", s.sample(10, 10));
    await s.settle();
    expect(s.et.calls.length).toBe(calls + 1); // 새 앵커 1회뿐, 이전 앵커 재설정 없음
    expect(s.eng.getSnapshot().anchor).toBeNull();
    expect(s.cust.getSnapshot().anchor).toBeNull();
  });

  it("still long-press is a pin; small wobble under the slop is a pin", () => {
    const s = setup();
    s.eng.handlePointer("down", s.sample(100, 100));
    s.clock.advance(600);
    s.eng.handlePointer("move", s.sample(102, 101)); // css 4.5px
    s.eng.handlePointer("up", s.sample(102, 101));
    expect(s.eng.getSnapshot().anchor!.annotations[0]).toMatchObject({
      kind: "pin",
      p: { x: 100 / 320, y: quantize(100 / 240) },
    });
  });

  it("cancel during a new-anchor gesture restores the previous anchor without telling the customer", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const first = s.eng.getSnapshot().anchor!;
    s.et.emit(first.id, "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    s.pair.flush();
    const sentBefore = s.pair.e.sent.length;
    s.eng.handlePointer("down", s.sample(10, 10));
    expect(s.eng.getSnapshot().anchor!.id).not.toBe(first.id);
    s.eng.handlePointer("cancel", s.sample(10, 10));
    await s.settle();
    expect(s.eng.getSnapshot().anchor).toEqual(first);
    const last = s.et.calls.at(-1)!;
    expect(last.id).toBe(first.id);
    expect(last.initialH).toBeUndefined(); // 자세를 모르니 탐색
    expect(s.pair.e.sent.length).toBe(sentBefore);
    expect(s.cust.getSnapshot().anchor?.id).toBe(first.id);
    expect(s.eng.getSnapshot().customerState).toBe("searching");
  });

  it("ignores taps in the letterbox and secondary pointers", () => {
    const s = setup();
    s.eng.handlePointer("down", s.sample(-20, 100));
    expect(s.eng.getSnapshot().anchor).toBeNull();
    s.eng.handlePointer("down", s.sample(100, 100, 0, 1));
    s.eng.handlePointer("down", s.sample(200, 100, 0, 2));
    s.eng.handlePointer("up", s.sample(200, 100, 0, 2));
    s.eng.handlePointer("up", s.sample(100, 100, 0, 1));
    expect(s.captures()).toBe(1);
    expect(s.eng.getSnapshot().anchor!.annotations.length).toBe(1);
  });

  it("clear removes everything on both sides and revokes the card URL", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    s.eng.clear();
    s.pair.flush();
    expect(s.eng.getSnapshot()).toMatchObject({ anchor: null, update: null, customerState: null, trackable: null });
    expect(s.cust.getSnapshot()).toEqual({ anchor: null, update: null, cardUrl: null, showCard: false });
    expect(s.urls.revoked).toEqual(["blob:0"]);
    expect(s.et.cleared).toBeGreaterThan(0);
    expect(s.ct.cleared).toBeGreaterThan(0);
  });

  it("annotations made while the JPEG is pending ride in the anchor header", async () => {
    const s = setup();
    let release!: (b: Blob) => void;
    const slow = new Promise<Blob>((r) => (release = r));
    // 첫 캡처의 JPEG를 늦게
    (s.eng as unknown as { capture: () => CapturedReference }).capture = () => ({
      gray: gray(),
      jpeg: slow,
      jpegSize: { width: 640, height: 480 },
    });
    s.tap(160, 120);
    const id = s.eng.getSnapshot().anchor!.id;
    s.et.emit(id, "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    s.tap(170, 125);
    s.tap(150, 110);
    expect(s.pair.e.sent.length).toBe(0);
    release(JPEG_640);
    await s.settle();
    const header = parseMessage(s.pair.e.sent[0] as string);
    expect(header?.t === "anchor" && header.anchor.annotations.length).toBe(3);
    expect(s.pair.e.texts().filter((m) => m?.t === "ann").length).toBe(0);
    expect(s.cust.getSnapshot().anchor?.annotations.length).toBe(3);
  });

  it("closed link: anchor is kept locally and sent on open; reconnect re-sync does not re-decode", async () => {
    const s = setup({ open: false });
    s.tap(160, 120);
    await s.settle();
    expect(s.pair.e.sent.length).toBe(0);
    expect(s.cust.getSnapshot().anchor).toBeNull();
    s.pair.setOpen(true);
    await s.settle();
    expect(s.cust.getSnapshot().anchor?.id).toBe(s.eng.getSnapshot().anchor?.id);
    expect(s.decodes.length).toBe(1);
    const id = s.eng.getSnapshot().anchor!.id;
    s.ct.emit(id, "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // 끊김 → 엔지니어는 고객 상태를 모름
    s.pair.setOpen(false);
    expect(s.eng.getSnapshot().customerState).toBeNull();
    // 끊긴 동안 추가한 주석
    s.et.emit(id, "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    s.tap(165, 125);
    // 재연결: 전체 재전송 → 고객은 같은 앵커라 추적 유지, 주석만 합침
    s.pair.setOpen(true);
    await s.settle();
    expect(s.decodes.length).toBe(1);
    expect(s.ct.calls.length).toBe(1);
    expect(s.cust.getSnapshot().anchor?.annotations.length).toBe(2);
    // 고객은 열릴 때 현재 상태를 다시 알린다
    expect(s.eng.getSnapshot().customerState).toBe("tracking");
  });

  it("engineer sends clear on (re)open when there is no anchor", async () => {
    const s = setup({ open: false });
    s.pair.setOpen(true);
    expect(s.pair.e.texts()).toEqual([{ t: "clear" }]);
  });

  it("customer rejects a JPEG whose header disagrees with the declared size", async () => {
    const s = setup();
    (s.eng as unknown as { capture: () => CapturedReference }).capture = () => ({
      gray: gray(),
      jpeg: Promise.resolve(makeJpeg(320, 240)), // 헤더는 320×240인데 640×480이라 선언
      jpegSize: { width: 640, height: 480 },
    });
    s.tap(160, 120);
    await s.settle();
    expect(s.cust.getSnapshot().anchor).toBeNull();
    expect(s.decodes.length).toBe(0);
  });

  it("customer decode failure → lost → card", async () => {
    const s = setup();
    s.setFailDecode(true);
    s.tap(160, 120);
    await s.settle();
    expect(s.cust.getSnapshot().anchor).not.toBeNull();
    s.clock.advance(900);
    expect(s.cust.getSnapshot().showCard).toBe(true);
    s.pair.flush();
    expect(s.eng.getSnapshot().customerState).toBe("lost");
  });

  it("frozen: tracker updates are ignored and taps map with the last pose", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const id = s.eng.getSnapshot().anchor!.id;
    s.eng.setFrozen(true);
    expect(s.eng.getSnapshot().frozen).toBe(true);
    s.et.emit(id, "lost", null);
    expect(s.eng.getSnapshot().update?.state).toBe("tracking");
    s.tap(170, 125);
    expect(s.eng.getSnapshot().anchor!.annotations.length).toBe(2);
    s.eng.setFrozen(false);
    s.et.emit(id, "lost", null);
    expect(s.eng.getSnapshot().update?.state).toBe("lost");
  });

  it("untrackable reference is reported", async () => {
    const s = setup();
    s.et.trackable = false;
    s.tap(160, 120);
    await s.settle();
    expect(s.eng.getSnapshot().trackable).toBe(false);
  });

  it("snapshots are stable between changes (useSyncExternalStore contract)", async () => {
    const s = setup();
    const a = s.eng.getSnapshot();
    expect(s.eng.getSnapshot()).toBe(a);
    let calls = 0;
    const off = s.eng.subscribe(() => calls++);
    s.tap(160, 120);
    expect(calls).toBeGreaterThan(0);
    const b = s.eng.getSnapshot();
    expect(s.eng.getSnapshot()).toBe(b);
    const id = b.anchor!.id;
    s.et.emit(id, "tracking", [1, 0, 1, 0, 1, 0, 0, 0, 1]);
    const c = s.eng.getSnapshot();
    expect(c).not.toBe(b);
    expect(c.anchor).toBe(b.anchor); // 앵커가 안 바뀌면 같은 객체 (오버레이 효과 재시작 방지)
    off();
    const n = calls;
    s.et.emit(id, "tracking", [1, 0, 2, 0, 1, 0, 0, 0, 1]);
    expect(calls).toBe(n);
  });

  it("updates of other anchors are ignored", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const before = s.eng.getSnapshot();
    s.et.emit("someone-else", "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    s.ct.emit("someone-else", "tracking", [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(s.eng.getSnapshot()).toBe(before);
    expect(s.cust.getSnapshot().update).toBeNull();
  });

  it("destroy cleans up both sessions", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    s.eng.destroy();
    s.cust.destroy();
    expect(s.et.destroyed).toBe(true);
    expect(s.ct.destroyed).toBe(true);
    expect(s.urls.revoked).toEqual(["blob:0"]);
    expect(s.pair.e.msgCbs.size + s.pair.e.openCbs.size + s.pair.c.msgCbs.size + s.pair.c.openCbs.size).toBe(0);
    // 파괴 후 입력은 무시
    s.eng.handlePointer("down", s.sample(10, 10));
    s.eng.clear();
    expect(s.pair.e.sent.filter((m) => typeof m === "string" && m.includes("clear")).length).toBe(0);
    expect(s.clock.timers.length).toBe(0);
  });

  it("maps pointer frame px through H for rotated/different frame sizes", async () => {
    const s = setup();
    s.tap(160, 120);
    await s.settle();
    const id = s.eng.getSnapshot().anchor!.id;
    // 추적 결과는 절반 크기 프레임 기준 (H가 0.5배)
    s.et.emit(id, "tracking", [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1], { width: 160, height: 120 });
    s.tap(170, 130); // 현재 작업 크기 320×240 → 160×120 기준으로 바꿔서 H⁻¹
    const pin = s.eng.getSnapshot().anchor!.annotations[1];
    expect(pin.kind).toBe("pin");
    if (pin.kind !== "pin") return;
    const back = applyH([0.5, 0, 0, 0, 0.5, 0, 0, 0, 1], { x: pin.p.x * 320, y: pin.p.y * 240 })!;
    expect(back.x).toBeCloseTo(((170 + 0.5) * 160) / 320 - 0.5, 1);
  });
});

function quantize(v: number) {
  return Math.round(v * 1e4) / 1e4;
}
