import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromRTCDataChannel, type DataChannelLike } from "./data-link";

// 가짜 RTCDataChannel: send하면 bufferedAmount가 쌓이고 drain()으로 비운다
class FakeChannel extends EventTarget implements DataChannelLike {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  throwOnSend = false;

  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("InvalidStateError");
    if (this.throwOnSend) throw new Error("OperationError");
    this.sent.push(data);
    this.bufferedAmount += typeof data === "string" ? data.length : data.byteLength;
  }

  drain(bytes = Infinity) {
    const before = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event("bufferedamountlow"));
    }
  }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  deliver(data: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

describe("fromRTCDataChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets binaryType and low threshold, reports late open", () => {
    const dc = new FakeChannel();
    const link = fromRTCDataChannel(dc, { lowWaterMark: 1000 });
    expect(dc.binaryType).toBe("arraybuffer");
    expect(dc.bufferedAmountLowThreshold).toBe(1000);
    const changes: boolean[] = [];
    link.onOpenChange((o) => changes.push(o));
    expect(link.isOpen()).toBe(false);
    expect(link.send("x")).toBe(false); // 열리기 전에는 버린다
    dc.open();
    expect(link.isOpen()).toBe(true);
    expect(link.send("hello")).toBe(true);
    expect(dc.sent).toEqual(["hello"]);
    dc.close();
    expect(link.isOpen()).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(link.send("late")).toBe(false);
  });

  it("delivers string and ArrayBuffer messages; unsubscribes", () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc);
    const got: unknown[] = [];
    const off = link.onMessage((d) => got.push(d));
    dc.deliver("a");
    const buf = new Uint8Array([1, 2, 3]).buffer;
    dc.deliver(buf);
    dc.deliver(new Uint8Array([9, 8]).subarray(1));
    off();
    dc.deliver("b");
    expect(got.length).toBe(3);
    expect(got[0]).toBe("a");
    expect(got[1]).toBe(buf);
    expect(new Uint8Array(got[2] as ArrayBuffer)).toEqual(new Uint8Array([8]));
  });

  it("converts Blob messages without breaking order", async () => {
    vi.useRealTimers();
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc);
    const got: unknown[] = [];
    link.onMessage((d) => got.push(typeof d === "string" ? d : Array.from(new Uint8Array(d))));
    dc.deliver(new Blob([new Uint8Array([7, 7])]));
    dc.deliver("after-blob");
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([[7, 7], "after-blob"]);
  });

  it("applies backpressure and preserves order", () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc, { highWaterMark: 100, lowWaterMark: 20 });
    const chunk = () => new ArrayBuffer(40);
    expect(link.send(chunk())).toBe(true); // 40
    expect(link.send(chunk())).toBe(true); // 80
    expect(link.send(chunk())).toBe(true); // 120 > 100 → 큐
    expect(link.send("small")).toBe(true); // 큐 뒤로 (순서 유지)
    expect(dc.sent.length).toBe(2);
    expect(link.bufferedAmount()).toBe(80 + 40 + 5);
    dc.drain(70); // 10 → low 이벤트 → flush
    expect(dc.sent.length).toBe(4);
    expect(dc.sent[3]).toBe("small");
    expect(link.bufferedAmount()).toBe(10 + 40 + 5);
  });

  it("polls when bufferedamountlow never fires", () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc, { highWaterMark: 50, lowWaterMark: 10, pollMs: 50 });
    link.send(new ArrayBuffer(40));
    link.send(new ArrayBuffer(40));
    expect(dc.sent.length).toBe(1);
    dc.bufferedAmount = 0; // 이벤트 없이 비워짐
    vi.advanceTimersByTime(60);
    expect(dc.sent.length).toBe(2);
  });

  it("sends oversize message immediately when buffer is empty", () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc, { highWaterMark: 10 });
    expect(link.send(new ArrayBuffer(100))).toBe(true);
    expect(dc.sent.length).toBe(1);
  });

  it("caps the queue", () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc, { highWaterMark: 10, maxQueueBytes: 100 });
    link.send(new ArrayBuffer(10));
    expect(link.send(new ArrayBuffer(60))).toBe(true);
    expect(link.send(new ArrayBuffer(60))).toBe(false);
  });

  it("drops the queue on close and when send throws", () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc, { highWaterMark: 10 });
    link.send(new ArrayBuffer(10));
    link.send(new ArrayBuffer(10));
    expect(link.bufferedAmount()).toBe(20);
    dc.close();
    expect(link.bufferedAmount()).toBe(10); // 채널 버퍼만 남음
    const dc2 = new FakeChannel();
    dc2.readyState = "open";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const l2 = fromRTCDataChannel(dc2);
    dc2.throwOnSend = true;
    expect(l2.send("x")).toBe(false);
    warn.mockRestore();
  });

  it("attach swaps channels (reconnect) and dispose detaches", () => {
    const a = new FakeChannel();
    a.readyState = "open";
    const link = fromRTCDataChannel(a);
    const changes: boolean[] = [];
    const got: unknown[] = [];
    link.onOpenChange((o) => changes.push(o));
    link.onMessage((d) => got.push(d));
    const b = new FakeChannel();
    link.attach(b);
    expect(changes).toEqual([false]);
    a.deliver("from-old");
    b.open();
    b.deliver("from-new");
    expect(got).toEqual(["from-new"]);
    expect(changes).toEqual([false, true]);
    link.send("x");
    expect(b.sent).toEqual(["x"]);
    link.dispose();
    b.deliver("after-dispose");
    expect(got).toEqual(["from-new"]);
    expect(link.send("y")).toBe(false);
    link.attach(a); // dispose 후 attach는 무시
    expect(link.isOpen()).toBe(false);
  });

  it("works with no channel at first", () => {
    const link = fromRTCDataChannel(null);
    expect(link.isOpen()).toBe(false);
    expect(link.send("x")).toBe(false);
    expect(link.bufferedAmount()).toBe(0);
    const dc = new FakeChannel();
    dc.readyState = "open";
    const changes: boolean[] = [];
    link.onOpenChange((o) => changes.push(o));
    link.attach(dc);
    expect(changes).toEqual([true]);
  });

  it("callback exceptions are contained", () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const got: unknown[] = [];
    link.onMessage(() => {
      throw new Error("x");
    });
    link.onMessage((d) => got.push(d));
    dc.deliver("m");
    expect(got).toEqual(["m"]);
    warn.mockRestore();
  });
});

describe("fromRTCDataChannel — ordering & latency (v2 review)", () => {
  it("after a Blob, later messages (string, ArrayBuffer, typed view) keep order and the chain resets to sync", async () => {
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc);
    const got: unknown[] = [];
    link.onMessage((d) => got.push(typeof d === "string" ? d : Array.from(new Uint8Array(d))));
    dc.deliver(new Blob([new Uint8Array([1])]));
    dc.deliver("s");
    dc.deliver(new Uint8Array([2]).buffer);
    dc.deliver(new Uint8Array([9, 3]).subarray(1));
    expect(got).toEqual([]); // 모두 Blob 뒤로
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([[1], "s", [2], [3]]);
    // 체인이 비었으면 다시 동기 전달
    dc.deliver("sync");
    expect(got.at(-1)).toBe("sync");
  });

  it("messages from a replaced channel's pending Blob are dropped", async () => {
    const a = new FakeChannel();
    a.readyState = "open";
    const link = fromRTCDataChannel(a);
    const got: unknown[] = [];
    link.onMessage((d) => got.push(d));
    a.deliver(new Blob([new Uint8Array([1])]));
    const b = new FakeChannel();
    b.readyState = "open";
    link.attach(b);
    b.deliver("new");
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["new"]);
  });

  it("a queued message goes out at once when the channel buffer already has room (no poll wait)", () => {
    vi.useFakeTimers();
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc, { highWaterMark: 100, pollMs: 1000 });
    link.send(new ArrayBuffer(60));
    link.send(new ArrayBuffer(60)); // 큐
    expect(dc.sent.length).toBe(1);
    dc.bufferedAmount = 0; // 이벤트 없이 비워짐
    link.send("next"); // 큐가 있으니 뒤로 → 곧바로 둘 다
    expect(dc.sent.length).toBe(3);
    expect(dc.sent[2]).toBe("next");
    vi.useRealTimers();
  });
});

describe("fromRTCDataChannel — errors", () => {
  it("a deliberate close ('User-Initiated Abort') closes quietly; other errors warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dc = new FakeChannel();
    dc.readyState = "open";
    const link = fromRTCDataChannel(dc);
    dc.readyState = "closing";
    dc.dispatchEvent(Object.assign(new Event("error"), { error: new Error("User-Initiated Abort, reason=Close called") }));
    expect(link.isOpen()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    const dc2 = new FakeChannel();
    dc2.readyState = "open";
    const l2 = fromRTCDataChannel(dc2);
    dc2.dispatchEvent(Object.assign(new Event("error"), { error: new Error("SCTP failure") }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(l2.isOpen()).toBe(true); // 아직 열려 있으면 유지
    warn.mockRestore();
  });
});
