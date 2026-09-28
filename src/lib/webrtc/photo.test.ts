import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataLink, LinkData } from "./data-link";
import { PhotoError, PhotoRequester, fromBase64, parsePhotoMsg, servePhotos, toBase64 } from "./photo";

// 서로 이어진 가짜 전송로 한 쌍 (메시지는 다음 틱에 도착)
function pair() {
  const make = () => {
    const msg = new Set<(d: LinkData) => void>();
    const open = new Set<(o: boolean) => void>();
    let isOpen = true;
    let peer: ReturnType<typeof make> | null = null;
    const sent: string[] = [];
    const link: DataLink = {
      send(d) {
        if (!isOpen) return false;
        sent.push(d as string);
        const p = peer!;
        queueMicrotask(() => p.msg.forEach((cb) => cb(d)));
        return true;
      },
      onMessage(cb) {
        msg.add(cb);
        return () => msg.delete(cb);
      },
      onOpenChange(cb) {
        open.add(cb);
        return () => open.delete(cb);
      },
      isOpen: () => isOpen,
      bufferedAmount: () => 0,
    };
    const api = {
      link,
      msg,
      sent,
      close() {
        isOpen = false;
        open.forEach((cb) => cb(false));
      },
      set peer(p: ReturnType<typeof make>) {
        peer = p;
      },
    };
    return api;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return { eng: a, cust: b };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("base64", () => {
  it("큰 바이트 배열도 그대로 되돌아온다", () => {
    const bytes = new Uint8Array(100_003).map((_, i) => (i * 31) % 256);
    expect(Array.from(fromBase64(toBase64(bytes.buffer)))).toEqual(Array.from(bytes));
  });
});

describe("메시지 검사", () => {
  it("형식이 틀린 조각은 버린다", () => {
    expect(parsePhotoMsg({ t: "photo-chunk", id: "a", i: 2, n: 2, d: "x" })).toBeNull();
    expect(parsePhotoMsg({ t: "photo-chunk", id: "a", i: 0, n: 5000, d: "x" })).toBeNull();
    expect(parsePhotoMsg({ t: "photo-req", id: "" })).toBeNull();
    expect(parsePhotoMsg({ t: "photo-req", id: "a" })).toEqual({ t: "photo-req", id: "a" });
  });
});

describe("사진 요청 → 찍기 → 받기", () => {
  it("여러 조각으로 나눠 와도 같은 JPEG로 모인다", async () => {
    const { eng, cust } = pair();
    const bytes = new Uint8Array(50_000).map((_, i) => i % 251);
    const onRequest = vi.fn();
    servePhotos(cust.link, async () => new Blob([bytes], { type: "image/jpeg" }), onRequest);
    const req = new PhotoRequester(eng.link);
    const blob = await req.request();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(blob.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(bytes));
    // 5만 바이트 → base64 약 6.7만 자 → 16000자 조각 5개
    expect(cust.sent.filter((s) => s.includes("photo-chunk"))).toHaveLength(5);
  });

  it("고객 폰이 못 찍으면 실패로 끝난다", async () => {
    const { eng, cust } = pair();
    servePhotos(cust.link, async () => null);
    await expect(new PhotoRequester(eng.link).request()).rejects.toMatchObject({ reason: "failed" });
  });

  it("연결이 닫혀 있으면 바로 실패, 기다리는 중에 끊겨도 실패", async () => {
    const { eng, cust } = pair();
    const req = new PhotoRequester(eng.link);
    // 고객이 답하지 않는 동안 끊김
    const p = req.request();
    eng.close();
    await expect(p).rejects.toBeInstanceOf(PhotoError);
    await expect(req.request()).rejects.toMatchObject({ reason: "closed" });
    void cust;
  });

  it("답이 없으면 시간이 지나 실패한다", async () => {
    vi.useFakeTimers();
    const { eng } = pair();
    const p = new PhotoRequester(eng.link).request();
    const check = expect(p).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(13_000);
    await check;
  });

  it("요청 두 개는 차례로 찍어 각각 돌려준다", async () => {
    const { eng, cust } = pair();
    let k = 0;
    servePhotos(cust.link, async () => new Blob([new Uint8Array([++k])], { type: "image/jpeg" }));
    const req = new PhotoRequester(eng.link);
    const [a, b] = await Promise.all([req.request(), req.request()]);
    expect(new Uint8Array(await a.arrayBuffer())[0]).toBe(1);
    expect(new Uint8Array(await b.arrayBuffer())[0]).toBe(2);
  });
});
