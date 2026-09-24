import { describe, expect, it } from "vitest";
import type { AnchorDescriptor, Annotation } from "./types";
import {
  ANCHOR_HEADER_BUDGET,
  CHUNK_HEADER_BYTES,
  CHUNK_PAYLOAD_BYTES,
  PROTOCOL_LIMITS,
  ProtocolReceiver,
  chunkCount,
  encodeAnchorTransfer,
  encodeChunks,
  encodeMessage,
  parseMessage,
  quantizeNorm,
  readChunkHeader,
  transferTag,
  validateAnchorDescriptor,
  validateAnnotation,
  validateMessage,
  type ReceivedAnchor,
} from "./protocol";

// 결정적 난수 (fuzz 재현용)
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bytes(n: number, seed = 1): Uint8Array {
  const r = rng(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
  return b;
}

const pin = (id: string, x = 0.5, y = 0.5): Annotation => ({ id, kind: "pin", p: { x, y } });
const stroke = (id: string, n: number): Annotation => ({
  id,
  kind: "stroke",
  points: Array.from({ length: n }, (_, i) => ({ x: quantizeNorm(i / n), y: quantizeNorm(0.3 + 0.1 * Math.sin(i)) })),
});

function anchor(id = "a1", annotations: Annotation[] = [pin("p1")]): AnchorDescriptor {
  return { id, refWidth: 320, refHeight: 240, roi: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, annotations };
}

function collect(role: "customer" | "engineer" = "customer", now?: () => number) {
  const got = {
    anchors: [] as ReceivedAnchor[],
    anns: [] as { anchorId: string; ann: Annotation }[],
    clears: 0,
    statuses: [] as { anchorId: string; state: string }[],
    drops: [] as string[],
    pending: 0,
  };
  const rx = new ProtocolReceiver(
    {
      onAnchor: (r) => got.anchors.push(r),
      onAnchorPending: () => got.pending++,
      onAnn: (anchorId, ann) => got.anns.push({ anchorId, ann }),
      onClear: () => got.clears++,
      onStatus: (anchorId, state) => got.statuses.push({ anchorId, state }),
      onDrop: (r) => got.drops.push(r),
    },
    { role, now },
  );
  return { rx, got };
}

describe("validators", () => {
  it("accepts well-formed annotations and copies only known fields", () => {
    const a = validateAnnotation({ id: "p", kind: "pin", p: { x: 0.1, y: 1.2, extra: 1 }, evil: true });
    expect(a).toEqual({ id: "p", kind: "pin", p: { x: 0.1, y: 1.2 } });
    expect(Object.keys(a!)).toEqual(["id", "kind", "p"]);
    const s = validateAnnotation(stroke("s", 10));
    expect(s?.kind).toBe("stroke");
  });

  it("rejects bad annotations", () => {
    const bad: unknown[] = [
      null,
      42,
      "pin",
      [],
      { id: "p", kind: "pin" },
      { id: "", kind: "pin", p: { x: 0, y: 0 } },
      { id: "x".repeat(65), kind: "pin", p: { x: 0, y: 0 } },
      { id: 5, kind: "pin", p: { x: 0, y: 0 } },
      { id: "p", kind: "circle", p: { x: 0, y: 0 } },
      { id: "p", kind: "pin", p: { x: Number.NaN, y: 0 } },
      { id: "p", kind: "pin", p: { x: Infinity, y: 0 } },
      { id: "p", kind: "pin", p: { x: -0.51, y: 0 } },
      { id: "p", kind: "pin", p: { x: 0, y: 1.51 } },
      { id: "p", kind: "pin", p: { x: "0.5", y: 0 } },
      { id: "s", kind: "stroke", points: [] },
      { id: "s", kind: "stroke", points: [{ x: 0, y: 0 }] },
      { id: "s", kind: "stroke", points: "nope" },
      { id: "s", kind: "stroke", points: [{ x: 0, y: 0 }, null] },
      { id: "s", kind: "stroke", points: Array.from({ length: 501 }, () => ({ x: 0, y: 0 })) },
    ];
    for (const b of bad) expect(validateAnnotation(b), JSON.stringify(b)).toBeNull();
    expect(validateAnnotation({ id: "x".repeat(64), kind: "pin", p: { x: -0.5, y: 1.5 } })).not.toBeNull();
    expect(validateAnnotation(stroke("s", 500))).not.toBeNull();
  });

  it("anchor descriptor limits", () => {
    expect(validateAnchorDescriptor(anchor())).toEqual(anchor());
    const many = Array.from({ length: 50 }, (_, i) => pin(`p${i}`));
    expect(validateAnchorDescriptor(anchor("a", many))).not.toBeNull();
    expect(validateAnchorDescriptor(anchor("a", [...many, pin("p50")]))).toBeNull();
    expect(validateAnchorDescriptor(anchor("a", [pin("dup"), pin("dup")]))).toBeNull();
    expect(validateAnchorDescriptor({ ...anchor(), refWidth: 320.5 })).toBeNull();
    expect(validateAnchorDescriptor({ ...anchor(), refWidth: 0 })).toBeNull();
    expect(validateAnchorDescriptor({ ...anchor(), refHeight: 5000 })).toBeNull();
    expect(validateAnchorDescriptor({ ...anchor(), roi: { x: 0, y: 0, width: 0, height: 1 } })).toBeNull();
    expect(validateAnchorDescriptor({ ...anchor(), roi: { x: 1, y: 0, width: 0.6, height: 1 } })).toBeNull();
    expect(validateAnchorDescriptor({ ...anchor(), roi: { x: -0.2, y: -0.1, width: 0.5, height: 0.5 } })).not.toBeNull();
    expect(validateAnchorDescriptor({ ...anchor(), annotations: undefined })).toBeNull();
  });

  it("messages", () => {
    const img = { bytes: 1000, mime: "image/jpeg", width: 640, height: 480 };
    expect(validateMessage({ t: "anchor", anchor: anchor(), img })).not.toBeNull();
    expect(validateMessage({ t: "anchor", anchor: anchor(), img: { ...img, mime: "image/png" } })).toBeNull();
    expect(validateMessage({ t: "anchor", anchor: anchor(), img: { ...img, bytes: 512 * 1024 + 1 } })).toBeNull();
    expect(validateMessage({ t: "anchor", anchor: anchor(), img: { ...img, bytes: 0 } })).toBeNull();
    // 비율이 ref와 다르면 거부
    expect(validateMessage({ t: "anchor", anchor: anchor(), img: { ...img, height: 360 } })).toBeNull();
    expect(validateMessage({ t: "ann", anchorId: "a", ann: pin("p") })).not.toBeNull();
    expect(validateMessage({ t: "ann", anchorId: "", ann: pin("p") })).toBeNull();
    expect(validateMessage({ t: "clear", junk: 1 })).toEqual({ t: "clear" });
    expect(validateMessage({ t: "status", anchorId: "a", state: "weak" })).not.toBeNull();
    expect(validateMessage({ t: "status", anchorId: "a", state: "happy" })).toBeNull();
    expect(validateMessage({ t: "pointer", x: 0 })).toBeNull();
    expect(parseMessage("{")).toBeNull();
    expect(parseMessage("null")).toBeNull();
    expect(parseMessage("[]")).toBeNull();
    expect(parseMessage("")).toBeNull();
    expect(parseMessage(" ".repeat(PROTOCOL_LIMITS.maxTextLength + 1))).toBeNull();
    expect(parseMessage('{"t":"clear"}')).toEqual({ t: "clear" });
  });

  it("prototype-polluting keys do not leak", () => {
    const msg = parseMessage('{"t":"ann","anchorId":"a","ann":{"id":"p","kind":"pin","p":{"x":0,"y":0},"__proto__":{"polluted":1}}}');
    expect(msg).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((msg as unknown as { ann: Record<string, unknown> }).ann.polluted).toBeUndefined();
  });
});

describe("chunks", () => {
  it("round-trips headers", () => {
    const data = bytes(CHUNK_PAYLOAD_BYTES * 2 + 123);
    const chunks = encodeChunks("anchor-x", data);
    expect(chunks.length).toBe(3);
    expect(chunkCount(data.length)).toBe(3);
    chunks.forEach((c, i) => {
      const h = readChunkHeader(c)!;
      expect(h).toEqual({
        tag: transferTag("anchor-x"),
        index: i,
        count: 3,
        length: i < 2 ? CHUNK_PAYLOAD_BYTES : 123,
      });
    });
    expect(chunks[0].byteLength).toBe(CHUNK_HEADER_BYTES + CHUNK_PAYLOAD_BYTES);
  });

  it("rejects malformed chunk headers", () => {
    expect(readChunkHeader(new ArrayBuffer(0))).toBeNull();
    expect(readChunkHeader(new ArrayBuffer(8))).toBeNull(); // 페이로드 없음
    expect(readChunkHeader(new ArrayBuffer(CHUNK_HEADER_BYTES + CHUNK_PAYLOAD_BYTES + 1))).toBeNull();
    const c = encodeChunks("a", bytes(10))[0];
    const bad = (mut: (dv: DataView) => void) => {
      const copy = c.slice(0);
      mut(new DataView(copy));
      return readChunkHeader(copy);
    };
    expect(bad((dv) => dv.setUint8(0, 0))).toBeNull();
    expect(bad((dv) => dv.setUint8(1, 2))).toBeNull();
    expect(bad((dv) => dv.setUint16(6, 0))).toBeNull();
    expect(bad((dv) => dv.setUint16(4, 1))).toBeNull(); // index >= count
  });

  it("tags differ for different ids (mostly)", () => {
    const tags = new Set<number>();
    for (let i = 0; i < 1000; i++) tags.add(transferTag(`a-${i}`));
    expect(tags.size).toBeGreaterThan(980);
  });
});

describe("encodeAnchorTransfer", () => {
  it("header + chunks, in that order", () => {
    const img = bytes(40000);
    const msgs = encodeAnchorTransfer(anchor(), { bytes: img, width: 640, height: 480 });
    expect(typeof msgs[0]).toBe("string");
    expect(parseMessage(msgs[0] as string)).toEqual({
      t: "anchor",
      anchor: anchor(),
      img: { bytes: 40000, mime: "image/jpeg", width: 640, height: 480 },
    });
    expect(msgs.length).toBe(1 + 3);
    expect(msgs.slice(1).every((m) => m instanceof ArrayBuffer)).toBe(true);
  });

  it("overflows annotations beyond the header budget into ann messages", () => {
    const anns = Array.from({ length: 50 }, (_, i) => stroke(`s${i}`, 500));
    const msgs = encodeAnchorTransfer(anchor("big", anns), { bytes: bytes(100), width: 640, height: 480 });
    const texts = msgs.filter((m): m is string => typeof m === "string");
    expect(texts.every((t) => t.length <= Math.max(ANCHOR_HEADER_BUDGET, 20000))).toBe(true);
    const header = parseMessage(texts[0]);
    expect(header?.t).toBe("anchor");
    const headAnns = header?.t === "anchor" ? header.anchor.annotations.length : 0;
    expect(headAnns).toBeGreaterThan(0);
    expect(headAnns).toBeLessThan(50);
    expect(texts.length - 1).toBe(50 - headAnns);
    // 조각 다음에 ann들
    const firstAnn = msgs.findIndex((m) => typeof m === "string" && m.includes('"t":"ann"'));
    expect(msgs[firstAnn - 1]).toBeInstanceOf(ArrayBuffer);

    // 수신하면 50개 전부 복원
    const { rx, got } = collect();
    for (const m of msgs) rx.receive(m);
    expect(got.anchors.length).toBe(1);
    const all = [...got.anchors[0].anchor.annotations.map((a) => a.id), ...got.anns.map((a) => a.ann.id)];
    expect(all).toEqual(anns.map((a) => a.id));
  });

  it("throws on oversize image", () => {
    expect(() =>
      encodeAnchorTransfer(anchor(), { bytes: new Uint8Array(512 * 1024 + 1), width: 640, height: 480 }),
    ).toThrow(RangeError);
    expect(() => encodeAnchorTransfer(anchor(), { bytes: new Uint8Array(0), width: 640, height: 480 })).toThrow(
      RangeError,
    );
  });
});

describe("ProtocolReceiver", () => {
  const send = (id: string, img: Uint8Array, anns: Annotation[] = [pin("p1")]) =>
    encodeAnchorTransfer(anchor(id, anns), { bytes: img, width: 640, height: 480 });

  it("reassembles in order", () => {
    const img = bytes(50000, 7);
    const { rx, got } = collect();
    for (const m of send("a1", img)) rx.receive(m);
    expect(got.pending).toBe(1);
    expect(got.anchors.length).toBe(1);
    expect(got.anchors[0].bytes).toEqual(img);
    expect(got.anchors[0].anchor.id).toBe("a1");
    expect(rx.currentAnchorId()).toBe("a1");
    expect(rx.isReceiving()).toBe(false);
  });

  it("reassembles out of order and ignores duplicates", () => {
    const img = bytes(CHUNK_PAYLOAD_BYTES * 4 + 5, 3);
    const [header, ...chunks] = send("a1", img);
    const { rx, got } = collect();
    rx.receive(header);
    const order = [3, 0, 4, 0, 2, 3, 1];
    for (const i of order) rx.receive((chunks[i] as ArrayBuffer).slice(0));
    expect(got.anchors.length).toBe(1);
    expect(got.anchors[0].bytes).toEqual(img);
  });

  it("new anchor header aborts previous partial transfer; stale chunks are ignored", () => {
    const img1 = bytes(40000, 1);
    const img2 = bytes(30000, 2);
    const t1 = send("old", img1);
    const t2 = send("new", img2);
    const { rx, got } = collect();
    rx.receive(t1[0]);
    rx.receive(t1[1]);
    rx.receive(t2[0]); // 새 헤더 → old 폐기
    expect(got.drops).toContain("transfer-superseded");
    rx.receive(t1[2]); // 이전 전송 조각 — 태그 불일치
    rx.receive(t1[3]);
    for (const m of t2.slice(1)) rx.receive(m);
    expect(got.anchors.length).toBe(1);
    expect(got.anchors[0].anchor.id).toBe("new");
    expect(got.anchors[0].bytes).toEqual(img2);
  });

  it("clear aborts a partial transfer and forgets the anchor", () => {
    const t = send("a", bytes(40000));
    const { rx, got } = collect();
    rx.receive(t[0]);
    rx.receive(t[1]);
    rx.receive(encodeMessage({ t: "clear" }));
    for (const m of t.slice(2)) rx.receive(m);
    expect(got.anchors.length).toBe(0);
    expect(got.clears).toBe(1);
    rx.receive(encodeMessage({ t: "ann", anchorId: "a", ann: pin("x") }));
    expect(got.anns.length).toBe(0);
  });

  it("abandoned transfers time out", () => {
    let now = 0;
    const t = send("a", bytes(40000));
    const { rx, got } = collect("customer", () => now);
    rx.receive(t[0]);
    rx.receive(t[1]);
    now = 20000;
    rx.receive(t[2]);
    rx.receive(t[3]);
    expect(got.drops).toContain("transfer-timeout");
    expect(got.anchors.length).toBe(0);
    expect(rx.isReceiving()).toBe(false);
  });

  it("chunk of wrong length/count is ignored", () => {
    const img = bytes(CHUNK_PAYLOAD_BYTES + 10);
    const t = send("a", img);
    const { rx, got } = collect();
    rx.receive(t[0]);
    // 마지막 조각을 잘라 길이 불일치
    rx.receive((t[2] as ArrayBuffer).slice(0, CHUNK_HEADER_BYTES + 5));
    // count 위조
    const forged = (t[1] as ArrayBuffer).slice(0);
    new DataView(forged).setUint16(6, 9);
    rx.receive(forged);
    expect(got.anchors.length).toBe(0);
    rx.receive(t[1]);
    rx.receive(t[2]);
    expect(got.anchors.length).toBe(1);
    expect(got.anchors[0].bytes).toEqual(img);
  });

  it("ann during transfer is attached to the pending anchor; after that it goes to onAnn", () => {
    const t = send("a", bytes(40000));
    const { rx, got } = collect();
    rx.receive(t[0]);
    rx.receive(t[1]);
    rx.receive(encodeMessage({ t: "ann", anchorId: "a", ann: pin("p2") }));
    rx.receive(encodeMessage({ t: "ann", anchorId: "a", ann: pin("p1") })); // 중복
    for (const m of t.slice(2)) rx.receive(m);
    expect(got.anchors[0].anchor.annotations.map((a) => a.id)).toEqual(["p1", "p2"]);
    rx.receive(encodeMessage({ t: "ann", anchorId: "a", ann: pin("p3") }));
    rx.receive(encodeMessage({ t: "ann", anchorId: "a", ann: pin("p3") }));
    rx.receive(encodeMessage({ t: "ann", anchorId: "other", ann: pin("p4") }));
    expect(got.anns.map((a) => a.ann.id)).toEqual(["p3"]);
  });

  it("enforces the 50-annotation limit across ann messages", () => {
    const t = send("a", bytes(100), Array.from({ length: 48 }, (_, i) => pin(`p${i}`)));
    const { rx, got } = collect();
    for (const m of t) rx.receive(m);
    for (let i = 0; i < 5; i++) rx.receive(encodeMessage({ t: "ann", anchorId: "a", ann: pin(`q${i}`) }));
    expect(got.anns.length).toBe(2);
  });

  it("role filtering", () => {
    const eng = collect("engineer");
    for (const m of send("a", bytes(100))) eng.rx.receive(m);
    eng.rx.receive(encodeMessage({ t: "status", anchorId: "a", state: "tracking" }));
    expect(eng.got.anchors.length).toBe(0);
    expect(eng.got.statuses).toEqual([{ anchorId: "a", state: "tracking" }]);
    const cust = collect("customer");
    cust.rx.receive(encodeMessage({ t: "status", anchorId: "a", state: "tracking" }));
    expect(cust.got.statuses.length).toBe(0);
  });

  it("handler exceptions do not escape", () => {
    const rx = new ProtocolReceiver(
      {
        onClear: () => {
          throw new Error("boom");
        },
      },
      { role: "customer" },
    );
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(() => rx.receive('{"t":"clear"}')).not.toThrow();
    } finally {
      console.warn = warn;
    }
  });
});

describe("fuzz", () => {
  it("random bytes and random text never throw and never produce anchors", () => {
    const r = rng(42);
    const { rx, got } = collect();
    for (let i = 0; i < 3000; i++) {
      if (r() < 0.5) {
        const n = (r() * 20000) | 0;
        const b = bytes(n, i + 1);
        // 가끔 매직·버전을 맞춰 헤더 검사까지 들어가게
        if (n > 8 && r() < 0.5) {
          b[0] = 0xbd;
          b[1] = 1;
        }
        rx.receive(b.buffer as ArrayBuffer);
      } else {
        const n = (r() * 200) | 0;
        let s = "";
        for (let k = 0; k < n; k++) s += String.fromCharCode(32 + ((r() * 95) | 0));
        rx.receive(s);
      }
    }
    expect(got.anchors.length).toBe(0);
    expect(got.anns.length).toBe(0);
  });

  it("mutated valid messages either validate to a clean message or are rejected", () => {
    const r = rng(7);
    const base = [
      encodeMessage({
        t: "anchor",
        anchor: anchor("a", [pin("p1"), stroke("s1", 5)]),
        img: { bytes: 100, mime: "image/jpeg", width: 640, height: 480 },
      }),
      encodeMessage({ t: "ann", anchorId: "a", ann: stroke("s2", 4) }),
      encodeMessage({ t: "status", anchorId: "a", state: "lost" }),
    ];
    const alphabet = '{}[]":,-.0123456789eE truefalsnul"xyp';
    let accepted = 0;
    for (let i = 0; i < 5000; i++) {
      const src = base[i % base.length];
      const chars = src.split("");
      const edits = 1 + ((r() * 4) | 0);
      for (let e = 0; e < edits; e++) {
        const pos = (r() * chars.length) | 0;
        const op = r();
        const c = alphabet[(r() * alphabet.length) | 0];
        if (op < 0.4) chars[pos] = c;
        else if (op < 0.7) chars.splice(pos, 1);
        else chars.splice(pos, 0, c);
      }
      const text = chars.join("");
      let msg: ReturnType<typeof parseMessage> = null;
      expect(() => (msg = parseMessage(text))).not.toThrow();
      if (msg) {
        accepted++;
        // 통과했다면 다시 검증해도 같은 값이어야 한다 (정규화된 깨끗한 값)
        expect(validateMessage(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it("interleaved garbage does not break a real transfer", () => {
    const r = rng(9);
    const img = bytes(70000, 5);
    const t = encodeAnchorTransfer(anchor("real"), { bytes: img, width: 640, height: 480 });
    const { rx, got } = collect();
    for (const m of t) {
      for (let k = 0; k < 3; k++) {
        const g = bytes(8 + ((r() * 100) | 0), k + 100);
        g[0] = 0xbd;
        g[1] = 1;
        rx.receive(g.buffer as ArrayBuffer);
        rx.receive('{"t":"ann","anchorId":"zzz","ann":{"id":"q","kind":"pin","p":{"x":0,"y":0}}}');
      }
      rx.receive(m);
    }
    expect(got.anchors.length).toBe(1);
    expect(got.anchors[0].bytes).toEqual(img);
  });
});
