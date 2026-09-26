import { afterEach, describe, expect, it, vi } from "vitest";
import jpeg from "jpeg-js";
import {
  captureReference,
  decodeReference,
  encodeJpeg,
  readJpegSize,
  roiFromStroke,
  roiFromTap,
} from "./capture";
import type { CanvasLike } from "./frame-source";
import type { Rect } from "./types";

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

describe("roiFromTap", () => {
  it("square of half the short side centred on the tap", () => {
    const r = roiFromTap({ x: 160, y: 120 }, 320, 240);
    expect(r).toEqual({ x: 100, y: 60, width: 120, height: 120 });
  });

  it("keeps the centre on the tap near edges (shrinks symmetrically)", () => {
    const r = roiFromTap({ x: 40, y: 200 }, 320, 240);
    expect(center(r).x).toBeCloseTo(40, 9);
    expect(center(r).y).toBeCloseTo(200, 9);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(240);
    expect(r.width).toBe(80);
    expect(r.height).toBe(80);
  });

  it("never degenerates at the very edge (min half = 10% of short side)", () => {
    const r = roiFromTap({ x: 0, y: 0 }, 320, 240);
    expect(center(r)).toEqual({ x: 0, y: 0 });
    expect(r.width).toBeCloseTo(48, 9);
    expect(r.height).toBeCloseTo(48, 9);
    // norm 범위 [-0.5, 1.5] 안
    expect(r.x / 320).toBeGreaterThanOrEqual(-0.5);
  });

  it("clamps taps outside the frame into it", () => {
    const r = roiFromTap({ x: 500, y: -30 }, 320, 240);
    expect(center(r)).toEqual({ x: 320, y: 0 });
  });

  it("portrait frames use the short side", () => {
    const r = roiFromTap({ x: 120, y: 160 }, 240, 320);
    expect(r).toEqual({ x: 60, y: 100, width: 120, height: 120 });
  });
});

describe("roiFromStroke", () => {
  it("pads the bbox by 15% of the short side", () => {
    const r = roiFromStroke(
      [
        { x: 100, y: 100 },
        { x: 140, y: 120 },
        { x: 180, y: 110 },
      ],
      320,
      240,
    );
    const pad = 0.15 * 240;
    expect(r.x).toBeCloseTo(100 - pad, 9);
    expect(r.y).toBeCloseTo(100 - pad, 9);
    expect(r.width).toBeCloseTo(80 + 2 * pad, 9);
    expect(r.height).toBeCloseTo(20 + 2 * pad, 9);
  });

  it("contains the stroke even at the frame border", () => {
    const pts = [
      { x: 2, y: 10 },
      { x: 60, y: 30 },
    ];
    const r = roiFromStroke(pts, 320, 240);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(r.x);
      expect(p.x).toBeLessThanOrEqual(r.x + r.width);
      expect(p.y).toBeGreaterThanOrEqual(r.y);
      expect(p.y).toBeLessThanOrEqual(r.y + r.height);
    }
    expect(r.x).toBeGreaterThanOrEqual(0);
  });

  it("covers the whole frame for a frame-spanning stroke; ignores junk points", () => {
    const r = roiFromStroke(
      [
        { x: -50, y: -50 },
        { x: Number.NaN, y: 3 },
        { x: 400, y: 300 },
      ],
      320,
      240,
    );
    expect(r).toEqual({ x: 0, y: 0, width: 320, height: 240 });
    expect(roiFromStroke([], 320, 240)).toEqual(roiFromTap({ x: 160, y: 120 }, 320, 240));
  });
});

describe("readJpegSize", () => {
  it("reads SOF dimensions of a real JPEG", () => {
    const w = 64;
    const h = 48;
    const data = Buffer.alloc(w * h * 4, 128);
    const enc = jpeg.encode({ data, width: w, height: h }, 80);
    expect(readJpegSize(new Uint8Array(enc.data))).toEqual({ width: 64, height: 48 });
  });

  it("rejects non-JPEG and truncated input", () => {
    expect(readJpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(readJpegSize(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(readJpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeNull();
    expect(readJpegSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    const enc = jpeg.encode({ data: Buffer.alloc(16 * 16 * 4), width: 16, height: 16 }, 50).data;
    // 무작위로 자른 입력도 예외 없이
    for (let n = 0; n < enc.length; n += 7) expect(() => readJpegSize(new Uint8Array(enc.subarray(0, n)))).not.toThrow();
  });
});

// ───────────────────────── 캔버스 경로 (가짜 캔버스) ─────────────────────────

interface Draw {
  from: string;
  to: string;
  w: number;
  h: number;
}

function fakeCanvasFactory(log: Draw[], blobSizeAt: (q: number) => number = () => 1000) {
  let n = 0;
  return (width: number, height: number): CanvasLike => {
    const name = `c${n++}`;
    const canvas = {
      name,
      width,
      height,
      getContext() {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          drawImage(src: { name?: string }, _x: number, _y: number, w: number, h: number) {
            log.push({ from: src.name ?? "video", to: name, w, h });
          },
          getImageData(_x: number, _y: number, w: number, h: number) {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < data.length; i += 4) {
              data[i] = 255;
              data[i + 1] = 0;
              data[i + 2] = 0;
            }
            return { data };
          },
        };
      },
      toBlob(cb: (b: Blob | null) => void, type: string, q: number) {
        cb(new Blob([new Uint8Array(blobSizeAt(q))], { type }));
      },
    };
    return canvas as unknown as CanvasLike;
  };
}

describe("captureReference (fake canvas)", () => {
  it("returns working-res gray and a 2x JPEG from the same frame", async () => {
    const log: Draw[] = [];
    const r = captureReference(
      { videoWidth: 1280, videoHeight: 720, readyState: 4 },
      { createCanvas: fakeCanvasFactory(log) },
    )!;
    expect(r.gray.width).toBe(320);
    expect(r.gray.height).toBe(180);
    expect(r.gray.data[0]).toBe((255 * 77) >> 8); // 빨강 → 그레이
    expect(r.jpegSize).toEqual({ width: 640, height: 360 });
    // 영상 → 640×360(컬러) → 320×180(그레이): 그레이는 컬러 캔버스에서 만든다
    expect(log).toEqual([
      { from: "video", to: "c0", w: 640, h: 360 },
      { from: "c0", to: "c1", w: 320, h: 180 },
    ]);
    const blob = await r.jpeg;
    expect(blob.type).toBe("image/jpeg");
  });

  it("null before the video has data", () => {
    expect(captureReference({ videoWidth: 640, videoHeight: 480, readyState: 1 })).toBeNull();
    expect(captureReference({ videoWidth: 0, videoHeight: 0, readyState: 4 })).toBeNull();
  });

  it("re-encodes at lower quality when the JPEG is too big, then gives up", async () => {
    const qs: number[] = [];
    const factory = fakeCanvasFactory([], (q) => {
      qs.push(q);
      return q > 0.6 ? 600 * 1024 : 100 * 1024;
    });
    const canvas = factory(10, 10);
    const b = await encodeJpeg(canvas, 0.8, 512 * 1024);
    expect(b.size).toBe(100 * 1024);
    expect(qs).toEqual([0.8, 0.65, 0.5]);
    const huge = fakeCanvasFactory([], () => 1e6)(10, 10);
    await expect(encodeJpeg(huge, 0.8, 512 * 1024)).rejects.toThrow(/too large/);
  });
});

describe("decodeReference (stubbed createImageBitmap)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes to an exact target size or to a long side", async () => {
    const closed: string[] = [];
    vi.stubGlobal("createImageBitmap", async () => ({
      name: "bmp",
      width: 640,
      height: 480,
      close: () => closed.push("bmp"),
    }));
    const log: Draw[] = [];
    const blob = new Blob([new Uint8Array(10)], { type: "image/jpeg" });
    const g = await decodeReference(blob, { width: 320, height: 240 }, fakeCanvasFactory(log));
    expect([g.width, g.height]).toEqual([320, 240]);
    expect(log).toEqual([{ from: "bmp", to: "c0", w: 320, h: 240 }]);
    expect(closed).toEqual(["bmp"]);
    const g2 = await decodeReference(blob, 160, fakeCanvasFactory([]));
    expect([g2.width, g2.height]).toEqual([160, 120]);
  });

  it("rejects oversize blobs before decoding", async () => {
    const spy = vi.fn();
    vi.stubGlobal("createImageBitmap", spy);
    await expect(decodeReference(new Blob([new Uint8Array(512 * 1024 + 1)]))).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
