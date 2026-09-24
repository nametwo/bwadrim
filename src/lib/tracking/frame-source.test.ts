import { describe, expect, it, vi } from "vitest";
import {
  FrameClock,
  FrameSource,
  RateController,
  UnsupportedFrameError,
  VideoFrameReader,
  downscaleSteps,
  resamplePlane,
  workingSize,
  type CanvasLike,
  type FramePacket,
  type FrameSourceEnv,
  type VideoFrameLike,
} from "./frame-source";
import { downscaleArea } from "../../../scripts/tracking-bench/imageops";
import type { GrayImage } from "./types";

describe("workingSize", () => {
  it("long side 320, keeps aspect, upscales small video", () => {
    expect(workingSize(640, 480)).toEqual({ width: 320, height: 240 });
    expect(workingSize(480, 640)).toEqual({ width: 240, height: 320 });
    expect(workingSize(1920, 1080)).toEqual({ width: 320, height: 180 });
    expect(workingSize(160, 120)).toEqual({ width: 320, height: 240 });
    expect(workingSize(426, 240)).toEqual({ width: 320, height: 180 });
    expect(workingSize(0, 480)).toBeNull();
    expect(workingSize(640, 0)).toBeNull();
    expect(workingSize(Number.NaN, 1)).toBeNull();
    expect(workingSize(10000, 1)).toEqual({ width: 320, height: 1 });
  });
});

describe("downscaleSteps", () => {
  it("halves until each step is at most 2x", () => {
    expect(downscaleSteps(640, 480, 320, 240)).toEqual([]);
    expect(downscaleSteps(500, 375, 320, 240)).toEqual([]);
    expect(downscaleSteps(1280, 720, 320, 180)).toEqual([{ width: 640, height: 360 }]);
    expect(downscaleSteps(1920, 1080, 320, 180)).toEqual([
      { width: 960, height: 540 },
      { width: 480, height: 270 },
    ]);
    expect(downscaleSteps(160, 120, 320, 240)).toEqual([]);
    // 극단 비율도 무한 반복하지 않는다
    expect(downscaleSteps(100000, 10, 320, 1).length).toBeLessThanOrEqual(9);
  });
});

describe("RateController", () => {
  it("20fps cap on 30fps video grabs 2 of 3 frames", () => {
    const rc = new RateController(20);
    let grabbed = 0;
    for (let i = 0; i < 300; i++) {
      const t = (i * 1000) / 30;
      if (rc.ready(t)) {
        rc.onGrab(t);
        grabbed++;
      }
    }
    expect(grabbed).toBeGreaterThanOrEqual(198);
    expect(grabbed).toBeLessThanOrEqual(202);
  });

  it("30fps cap on 30fps video grabs every frame despite jitter", () => {
    const rc = new RateController(30);
    let grabbed = 0;
    for (let i = 0; i < 300; i++) {
      const t = (i * 1000) / 30 + (i % 2 ? 2 : -2);
      if (rc.ready(t)) {
        rc.onGrab(t);
        grabbed++;
      }
    }
    expect(grabbed).toBeGreaterThanOrEqual(295);
  });

  it("adapts to slow processing", () => {
    const rc = new RateController(30, { headroom: 1.5 });
    expect(rc.intervalMs()).toBeCloseTo(33.33, 1);
    for (let i = 0; i < 50; i++) rc.onProcessed(60);
    expect(rc.intervalMs()).toBeCloseTo(90, 0);
    for (let i = 0; i < 50; i++) rc.onProcessed(5);
    expect(rc.intervalMs()).toBeCloseTo(33.33, 1);
    for (let i = 0; i < 50; i++) rc.onProcessed(5000);
    expect(rc.intervalMs()).toBe(500); // minFps 2
    rc.onProcessed(Number.NaN);
    rc.onProcessed(-1);
    expect(rc.intervalMs()).toBe(500);
  });

  it("resets phase after a long gap instead of bursting", () => {
    const rc = new RateController(10);
    rc.onGrab(0);
    expect(rc.ready(50)).toBe(false);
    expect(rc.ready(1000)).toBe(true);
    rc.onGrab(1000);
    expect(rc.ready(1020)).toBe(false); // 밀린 기한을 몰아서 따라잡지 않는다
  });
});

describe("FrameClock", () => {
  it("prefers media time, stays monotonic", () => {
    const c = new FrameClock();
    expect(c.next(1000, 50)).toBe(1000);
    expect(c.next(1033, 83)).toBe(1033);
    // 미디어 시각이 거꾸로 → 벽시계 경과로 대체
    expect(c.next(10, 116)).toBe(1066);
    // 크게 튐 → 대체
    expect(c.next(999999, 150)).toBe(1100);
    expect(c.next(undefined, 183)).toBe(1133);
    expect(c.next(Number.NaN, 216)).toBe(1166);
    expect(c.next(1200, 250)).toBe(1200);
  });

  it("falls back to wall clock from the start", () => {
    const c = new FrameClock();
    expect(c.next(undefined, 500)).toBe(500);
    expect(c.next(undefined, 500)).toBe(501); // 최소 1ms 증가
  });
});

// ───────────────────────── FrameSource (가짜 영상·캔버스) ─────────────────────────

interface DrawCall {
  w: number;
  h: number;
  canvas: FakeCanvas;
}

class FakeCanvas {
  draws: DrawCall[];
  constructor(
    public width: number,
    public height: number,
    draws: DrawCall[],
    private value: { v: number },
  ) {
    this.draws = draws;
  }
  getContext() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const canvas = this;
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage(_src: unknown, _x: number, _y: number, w: number, h: number) {
        canvas.draws.push({ w, h, canvas });
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4);
        data.fill(canvas.value.v);
        return { data, width: w, height: h };
      },
    };
  }
}

function setup(
  opts: {
    rvfc?: boolean;
    width?: number;
    height?: number;
    maxFps?: number;
    onFrame?: (frame: GrayImage, ts: number) => void;
  } = {},
) {
  let now = 0;
  let hidden = false;
  const visCbs = new Set<() => void>();
  const draws: DrawCall[] = [];
  const pixel = { v: 100 };
  let rvfcCb: VideoFrameRequestCallback | null = null;
  let rafCb: ((t: number) => void) | null = null;
  const video = {
    videoWidth: opts.width ?? 640,
    videoHeight: opts.height ?? 480,
    readyState: 4,
    currentTime: 0,
    ...(opts.rvfc === false
      ? {}
      : {
          requestVideoFrameCallback: (cb: VideoFrameRequestCallback) => {
            rvfcCb = cb;
            return 1;
          },
          cancelVideoFrameCallback: () => {
            rvfcCb = null;
          },
        }),
  };
  const env: FrameSourceEnv = {
    now: () => now,
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return 1;
    },
    cancelAnimationFrame: () => {
      rafCb = null;
    },
    createCanvas: (w, h) => new FakeCanvas(w, h, draws, pixel) as unknown as CanvasLike,
    isHidden: () => hidden,
    onVisibilityChange: (cb) => {
      visCbs.add(cb);
      return () => visCbs.delete(cb);
    },
  };
  const frames: { frame: GrayImage; ts: number }[] = [];
  const src = new FrameSource(video, {
    maxFps: opts.maxFps ?? 30,
    onFrame: opts.onFrame ?? ((frame, ts) => frames.push({ frame, ts })),
    env,
  });
  let mediaTime = 0;
  return {
    src,
    video,
    frames,
    draws,
    pixel,
    /** 새 영상 프레임 제시 (33ms 뒤) */
    present(dt = 1000 / 30) {
      now += dt;
      mediaTime += dt / 1000;
      video.currentTime = mediaTime;
      if (video.requestVideoFrameCallback) {
        const cb = rvfcCb;
        rvfcCb = null;
        cb?.(now, { mediaTime } as VideoFrameCallbackMetadata);
      } else {
        const cb = rafCb;
        rafCb = null;
        cb?.(now);
      }
    },
    advance(dt: number) {
      now += dt;
    },
    setHidden(h: boolean) {
      hidden = h;
      visCbs.forEach((cb) => cb());
    },
    pending: () => rvfcCb !== null || rafCb !== null,
  };
}

describe("FrameSource", () => {
  it("does nothing before metadata, then emits working-res gray frames", () => {
    const t = setup();
    t.video.videoWidth = 0;
    t.video.videoHeight = 0;
    t.src.start();
    t.present();
    expect(t.frames.length).toBe(0);
    expect(t.src.frameSize()).toBeNull();
    t.video.videoWidth = 640;
    t.video.videoHeight = 480;
    t.present();
    expect(t.frames.length).toBe(1);
    const f = t.frames[0].frame;
    expect(f.width).toBe(320);
    expect(f.height).toBe(240);
    expect(f.data.length).toBe(320 * 240);
    expect(f.data[0]).toBe(100); // 회색 100 → rgbaToGray
    expect(t.frames[0].ts).toBeCloseTo(66.67, 1); // 미디어 시각(두 번째 제시)
  });

  it("keeps only one frame in flight and grabs the pending frame on release", () => {
    const t = setup();
    t.src.start();
    t.present();
    t.present();
    t.present();
    expect(t.frames.length).toBe(1);
    const first = t.frames[0].frame.data;
    t.src.release(first.buffer as ArrayBuffer, 3);
    expect(t.frames.length).toBe(2); // 기다리던 새 프레임을 바로
    // 버퍼 재사용
    expect(t.frames[1].frame.data.buffer).toBe(first.buffer);
    expect(t.src.getStats().skipped).toBeGreaterThan(0);
  });

  it("respects the fps cap with instant processing", () => {
    const t = setup({ maxFps: 20 });
    t.src.start();
    for (let i = 0; i < 90; i++) {
      t.present();
      const last = t.frames[t.frames.length - 1];
      if (last) t.src.release(last.frame.data, 1);
    }
    // 30fps 영상 3초 → 20fps 상한이면 약 60장
    expect(t.frames.length).toBeGreaterThanOrEqual(58);
    expect(t.frames.length).toBeLessThanOrEqual(62);
  });

  it("slows down when processing is slow", () => {
    const t = setup({ maxFps: 30 });
    t.src.start();
    let released = 0;
    for (let i = 0; i < 90; i++) {
      t.present();
      if (t.frames.length > released) {
        t.src.release(t.frames[t.frames.length - 1].frame.data, 80);
        released = t.frames.length;
      }
    }
    // 간격 ≈ 80×1.5 = 120ms → 3초에 약 25장
    expect(t.frames.length).toBeLessThan(35);
    expect(t.src.getStats().intervalMs).toBeGreaterThan(100);
  });

  it("grabs the current frame immediately on start (even if the video is paused)", () => {
    const t = setup();
    t.src.start();
    expect(t.frames.length).toBe(1);
  });

  it("pauses while hidden and resumes when visible", () => {
    const t = setup();
    t.src.start(); // 즉시 1장
    t.src.release(t.frames[0].frame.data, 1);
    t.setHidden(true);
    expect(t.pending()).toBe(false);
    t.present();
    t.present();
    expect(t.frames.length).toBe(1);
    t.setHidden(false); // 보이면 곧바로 현재 프레임
    expect(t.pending()).toBe(true);
    expect(t.frames.length).toBe(2);
    t.src.release(t.frames[1].frame.data, 1);
    t.present();
    expect(t.frames.length).toBe(3);
  });

  it("handles rotation (dimension change) and drops mismatched buffers", () => {
    const t = setup();
    t.src.start();
    t.present();
    const a = t.frames[0].frame;
    t.video.videoWidth = 480;
    t.video.videoHeight = 640;
    t.src.release(a.data, 1);
    t.present();
    const b = t.frames[t.frames.length - 1].frame;
    expect(b.width).toBe(240);
    expect(b.height).toBe(320);
    expect(b.data.buffer).toBe(a.data.buffer); // 픽셀 수가 같으면 재사용
    t.video.videoWidth = 1280;
    t.video.videoHeight = 720;
    t.src.release(b.data, 1);
    t.present();
    const c = t.frames[t.frames.length - 1].frame;
    expect([c.width, c.height]).toEqual([320, 180]);
    expect(c.data.length).toBe(320 * 180);
    expect(c.data.buffer).not.toBe(a.data.buffer);
  });

  it("uses multi-step downscale for large video", () => {
    const t = setup({ width: 1280, height: 720 });
    t.src.start();
    t.present();
    expect(t.draws.map((d) => [d.w, d.h])).toEqual([
      [640, 360],
      [320, 180],
    ]);
  });

  it("stop halts the loop; release after stop does not grab", () => {
    const t = setup();
    t.src.start();
    t.present();
    t.src.stop();
    expect(t.pending()).toBe(false);
    t.present();
    t.src.release(t.frames[0].frame.data, 1);
    expect(t.frames.length).toBe(1);
    // 재시작하면 즉시 한 장
    t.src.start();
    t.present();
    expect(t.frames.length).toBe(2);
  });

  it("rAF fallback detects new frames through currentTime", () => {
    const t = setup({ rvfc: false });
    t.src.start();
    t.present();
    expect(t.frames.length).toBe(1);
    t.src.release(t.frames[0].frame.data, 1);
    t.present();
    expect(t.frames.length).toBe(2);
  });

  it("gives up on a frame that never comes back", () => {
    const t = setup();
    t.src.start();
    t.present();
    for (let i = 0; i < 10; i++) t.present();
    expect(t.frames.length).toBe(1);
    t.advance(3100);
    t.present();
    expect(t.frames.length).toBe(2);
  });

  it("grab() returns a fresh buffer and works while stopped", () => {
    const t = setup();
    const g = t.src.grab();
    expect(g?.width).toBe(320);
    const g2 = t.src.grab();
    expect(g2?.data).not.toBe(g?.data);
    t.video.readyState = 1;
    expect(t.src.grab()).toBeNull();
  });

  it("onFrame exceptions do not wedge the loop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const t = setup({
      onFrame: () => {
        n++;
        throw new Error("x");
      },
    });
    t.src.start(); // 즉시 1장
    t.present();
    t.present();
    t.present();
    expect(n).toBe(4);
    warn.mockRestore();
  });
});

// ───────────────────────── 면적 평균 리샘플 · VideoFrame 획득 ─────────────────────────


function noisePlane(w: number, h: number, seed = 1) {
  const a = new Uint8Array(w * h);
  let s = seed;
  for (let i = 0; i < a.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    // 부드러운 무늬 + 잡음 (가장자리 값 0·255 포함)
    const x = i % w;
    const y = (i / w) | 0;
    a[i] = Math.max(0, Math.min(255, Math.round(128 + 120 * Math.sin(x * 0.07) * Math.cos(y * 0.05) + ((s >>> 24) - 128) * 0.4)));
  }
  return a;
}

describe("resamplePlane", () => {
  it("is bit-identical to the bench's downscaleArea (full range)", () => {
    const cases: [number, number, number, number][] = [
      [640, 480, 320, 240], // 2배 (정수 빠른 경로)
      [480, 640, 240, 320],
      [1280, 720, 320, 180], // 4배
      [960, 540, 320, 180], // 3배
      [1920, 1080, 320, 180], // 6배
      [1024, 768, 320, 240], // 3.2배 (일반 경로)
      [848, 480, 320, 181], // 가로·세로 배율이 조금 다름
      [500, 375, 320, 240],
      [320, 240, 320, 240], // 그대로
    ];
    for (const [sw, sh, dw, dh] of cases) {
      const src = noisePlane(sw, sh, sw + sh);
      const ours = new Uint8Array(dw * dh);
      resamplePlane(src, sw, 0, 0, sw, sh, ours, dw, dh, false);
      const bench = downscaleArea(src, sw, sh, dw, dh);
      let diff = 0;
      for (let i = 0; i < ours.length; i++) if (ours[i] !== bench[i]) diff++;
      expect(`${sw}x${sh}: ${diff}`).toBe(`${sw}x${sh}: 0`);
    }
  });

  it("32-bit fast paths and the byte-wise fallback agree (unaligned offset / stride, limited range)", () => {
    for (const [sw, sh, dw, dh] of [
      [640, 480, 320, 240],
      [1280, 720, 320, 180],
      [1920, 1080, 320, 180],
    ] as const) {
      const plane = noisePlane(sw, sh, 7);
      const aligned = new Uint8Array(dw * dh);
      resamplePlane(plane, sw, 0, 0, sw, sh, aligned, dw, dh, true);
      // 1바이트 밀린 버퍼 + 홀수 행 간격 → 32비트 경로 불가
      const stride = sw + 1;
      const big = new Uint8Array(1 + stride * sh);
      for (let y = 0; y < sh; y++) big.set(plane.subarray(y * sw, (y + 1) * sw), 1 + y * stride);
      const slow = new Uint8Array(dw * dh);
      resamplePlane(big.subarray(1), stride, 0, 0, sw, sh, slow, dw, dh, true);
      expect(Buffer.from(slow).equals(Buffer.from(aligned))).toBe(true);
    }
  });

  it("honours stride/offset and limited → full range", () => {
    // 16(검정)·235(흰색) 2×2 블록 → 0·255
    const stride = 10;
    const src = new Uint8Array(stride * 4).fill(99);
    const put = (x: number, y: number, v: number) => (src[(1 + y) * stride + 2 + x] = v);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) put(x, y, 16);
    for (let y = 0; y < 2; y++) for (let x = 2; x < 4; x++) put(x, y, 235);
    const out = new Uint8Array(2);
    resamplePlane(src, stride, 2, 1, 4, 2, out, 2, 1, true);
    expect([...out]).toEqual([0, 255]);
    // 중간값: 126 → (126−16)·255/219 = 128.08 → 128
    const mid = new Uint8Array(4).fill(126);
    const o2 = new Uint8Array(1);
    resamplePlane(mid, 2, 0, 0, 2, 2, o2, 1, 1, true);
    expect(o2[0]).toBe(128);
    // 범위 밖(0, 255)은 자른다
    resamplePlane(new Uint8Array(4).fill(0), 2, 0, 0, 2, 2, o2, 1, 1, true);
    expect(o2[0]).toBe(0);
    resamplePlane(new Uint8Array(4).fill(255), 2, 0, 0, 2, 2, o2, 1, 1, true);
    expect(o2[0]).toBe(255);
  });

  it("upscales with pixel-centre linear interpolation (low-res WebRTC)", () => {
    const src = new Uint8Array([0, 100, 200, 0, 100, 200]); // 3×2
    const out = new Uint8Array(6 * 2);
    resamplePlane(src, 3, 0, 0, 3, 2, out, 6, 2, false);
    // 출력 x → 원본 (x+0.5)/2−0.5: 0→−0.25(자름 0), 1→0.25, 2→0.75, 3→1.25, 4→1.75, 5→2.25(자름)
    expect([...out.subarray(0, 6)]).toEqual([0, 25, 75, 125, 175, 200]);
  });

  it("rejects bad sizes", () => {
    expect(() => resamplePlane(new Uint8Array(4), 2, 0, 0, 2, 2, new Uint8Array(0), 1, 1)).toThrow(RangeError);
  });
});

/** I420·NV12·RGBA 가짜 VideoFrame (copyTo는 Chrome처럼 visibleRect 기준으로 촘촘히) */
class FakeVideoFrame implements VideoFrameLike {
  closed = false;
  /** copyTo의 format: "RGBA" 변환을 지원하는지 (Chrome 신버전은 지원) */
  convertible = true;
  visibleRect: { x: number; y: number; width: number; height: number };
  constructor(
    public format: string | null,
    public displayWidth: number,
    public displayHeight: number,
    private readonly y: Uint8Array,
    public colorSpace: { fullRange?: boolean | null } | null = { fullRange: false },
    public rotation = 0,
    public flip = false,
  ) {
    this.visibleRect = { x: 0, y: 0, width: displayWidth, height: displayHeight };
  }
  allocationSize(opts?: { format?: string }) {
    const n = this.displayWidth * this.displayHeight;
    if (opts?.format && opts.format !== this.format && !this.convertible) throw new DOMException("no conversion", "NotSupportedError");
    const f = opts?.format ?? this.format;
    if (f === "I420" || f === "NV12") return n + (n >> 1);
    if (f === "RGBA" || f === "BGRA") return n * 4;
    throw new DOMException("unsupported", "NotSupportedError");
  }
  async copyTo(dest: AllowSharedBufferSource, opts?: { format?: string }): Promise<PlaneLayout[]> {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
    const d = dest as Uint8Array;
    const w = this.displayWidth;
    const n = w * this.displayHeight;
    const f = opts?.format ?? this.format;
    if (f === "RGBA" || f === "BGRA") {
      for (let i = 0; i < n; i++) {
        d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = this.y[i];
        d[4 * i + 3] = 255;
      }
      return [{ offset: 0, stride: 4 * w }];
    }
    if (f !== "I420" && f !== "NV12") throw new DOMException("unsupported", "NotSupportedError");
    d.set(this.y, 0);
    d.fill(128, n, n + (n >> 1));
    return f === "I420"
      ? [
          { offset: 0, stride: w },
          { offset: n, stride: w >> 1 },
          { offset: n + (n >> 2), stride: w >> 1 },
        ]
      : [
          { offset: 0, stride: w },
          { offset: n, stride: w },
        ];
  }
  close() {
    this.closed = true;
  }
}

describe("VideoFrameReader", () => {
  it("reads the Y plane of I420/NV12 (limited range) and RGBA frames", async () => {
    const y = new Uint8Array(640 * 480).fill(126);
    const r = new VideoFrameReader();
    for (const fmt of ["I420", "NV12"]) {
      const g = await r.read(new FakeVideoFrame(fmt, 640, 480, y), 320, 240);
      expect([g.width, g.height, g.data.length]).toEqual([320, 240, 320 * 240]);
      expect(g.data[0]).toBe(128);
    }
    // 전체 범위 표시면 그대로
    const full = await r.read(new FakeVideoFrame("I420", 640, 480, y, { fullRange: true }), 320, 240);
    expect(full.data[5]).toBe(126);
    // RGBA는 cv/color와 같은 회색 식 (회색 입력 → (256·v)>>8 = v)
    const rgba = await r.read(new FakeVideoFrame("RGBA", 640, 480, y), 320, 240);
    expect(rgba.data[7]).toBe(126);
    // 불투명 형식(null) → RGBA 변환 요청으로 읽는다
    const opaque = await r.read(new FakeVideoFrame(null, 640, 480, y), 320, 240);
    expect(opaque.data[7]).toBe(126);
  });

  it("reuses the output buffer and refuses rotated / unreadable frames", async () => {
    const y = new Uint8Array(64 * 48).fill(200);
    const r = new VideoFrameReader();
    const out = new Uint8Array(32 * 24);
    const g = await r.read(new FakeVideoFrame("I420", 64, 48, y), 32, 24, out);
    expect(g.data).toBe(out);
    await expect(r.read(new FakeVideoFrame("I420", 64, 48, y, null, 90), 32, 24)).rejects.toBeInstanceOf(UnsupportedFrameError);
    const odd = new FakeVideoFrame("I444X", 64, 48, y);
    odd.convertible = false;
    await expect(r.read(odd, 32, 24)).rejects.toBeInstanceOf(UnsupportedFrameError);
  });
});

function vfSetup(opts: {
  onPacket?: boolean;
  make?: () => VideoFrameLike;
  width?: number;
  height?: number;
  acquisition?: ("videoframe-worker" | "videoframe" | "canvas")[];
}) {
  const t = setup({ width: opts.width, height: opts.height });
  // setup()이 만든 FrameSource 대신 VideoFrame을 쓰는 것을 새로 만든다 (같은 가짜 영상·캔버스)
  t.src.destroy();
  const packets: { p: FramePacket; ts: number }[] = [];
  const frames = t.frames;
  const made: FakeVideoFrame[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const video = Object.assign(t.video, {
    addEventListener: (type: string, cb: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => listeners.get(type)?.delete(cb),
  });
  const make =
    opts.make ??
    (() => {
      const f = new FakeVideoFrame("I420", video.videoWidth, video.videoHeight, new Uint8Array(video.videoWidth * video.videoHeight).fill(126));
      made.push(f);
      return f;
    });
  const src = new FrameSource(video, {
    maxFps: 30,
    onFrame: (frame, ts) => frames.push({ frame, ts }),
    onPacket: opts.onPacket ? (p, ts) => packets.push({ p, ts }) : undefined,
    acquisition: opts.acquisition,
    env: {
      ...(t.src as unknown as { env: FrameSourceEnv }).env,
      supportsVideoFrame: () => true,
      createVideoFrame: () => make(),
    },
  });
  return { ...t, src, packets, made, listeners, fire: (type: string) => listeners.get(type)?.forEach((cb) => cb()) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FrameSource acquisition modes", () => {
  it("with a packet consumer, hands VideoFrames over (videoframe-worker) sized from the frame", () => {
    const t = vfSetup({ onPacket: true });
    expect(t.src.acquisition()).toBe("videoframe-worker");
    t.src.start();
    expect(t.packets.length).toBe(1);
    const p = t.packets[0].p;
    expect(p.kind).toBe("videoframe");
    if (p.kind !== "videoframe") return;
    expect([p.width, p.height]).toEqual([320, 240]);
    expect(p.frame).toBe(t.made[0]);
    expect(t.made[0].closed).toBe(false); // 소비자 책임
    expect(t.draws.length).toBe(0); // 캔버스 안 씀
    t.src.release(null, 2);
    t.present();
    expect(t.packets.length).toBe(2);
    expect(t.src.getStats().acquisition).toBe("videoframe-worker");
  });

  it("without a packet consumer, reads VideoFrames on the main thread and delivers gray (async)", async () => {
    const t = vfSetup({});
    expect(t.src.acquisition()).toBe("videoframe");
    t.src.start();
    expect(t.frames.length).toBe(0);
    await tick();
    expect(t.frames.length).toBe(1);
    expect(t.frames[0].frame.data[0]).toBe(128); // limited 126 → 128
    expect(t.made[0].closed).toBe(true);
    // 버퍼 재사용
    const buf = t.frames[0].frame.data;
    t.src.release(buf, 1);
    await tick();
    t.present();
    await tick();
    expect(t.frames.length).toBe(2);
    expect(t.frames[1].frame.data.buffer).toBe(buf.buffer);
  });

  it("falls back to canvas without VideoFrame support, or when asked", () => {
    const t = setup();
    expect(t.src.acquisition()).toBe("canvas");
    const c = vfSetup({ onPacket: true, acquisition: ["canvas"] });
    expect(c.src.acquisition()).toBe("canvas");
    c.src.start();
    expect(c.packets[0].p).toMatchObject({ kind: "gray", mode: "canvas" });
  });

  it("rotated VideoFrames demote both VideoFrame modes; this frame still arrives via canvas", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = vfSetup({
      onPacket: true,
      make: () => new FakeVideoFrame("I420", 640, 480, new Uint8Array(640 * 480), null, 90),
    });
    t.src.start();
    expect(t.src.acquisition()).toBe("canvas");
    expect(t.packets[0].p).toMatchObject({ kind: "gray", mode: "canvas" });
    expect(t.src.getStats().demoted.map((d) => d.mode)).toEqual(["videoframe-worker", "videoframe"]);
    warn.mockRestore();
  });

  it("repeated VideoFrame construction failures demote after 3 tries (canvas meanwhile)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = vfSetup({
      onPacket: true,
      make: () => {
        throw new DOMException("no frame", "InvalidStateError");
      },
    });
    t.src.start();
    expect(t.src.acquisition()).toBe("videoframe-worker");
    for (let i = 0; i < 2; i++) {
      const last = t.packets.at(-1)!.p;
      t.src.release(last.kind === "gray" ? last.frame.data : null, 1);
      t.present();
    }
    expect(t.packets.length).toBe(3);
    expect(t.packets.every((x) => x.p.kind === "gray")).toBe(true);
    expect(t.src.acquisition()).toBe("canvas");
    warn.mockRestore();
  });

  it("a persistent aspect mismatch (hidden rotation) demotes; a brief one during rotation does not", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let w = 480;
    let h = 640; // 프레임은 세로인데 <video>는 가로(640×480)라고 보고
    const t = vfSetup({ onPacket: true, make: () => new FakeVideoFrame("I420", w, h, new Uint8Array(w * h)) });
    t.src.start();
    t.src.release(null, 1);
    t.present();
    expect(t.src.acquisition()).toBe("videoframe-worker"); // 2번까지는 그 프레임만 캔버스로
    w = 640;
    h = 480;
    t.src.release(null, 1);
    t.present();
    expect(t.packets.at(-1)!.p.kind).toBe("videoframe");
    w = 480;
    h = 640;
    for (let i = 0; i < 5; i++) {
      const last = t.packets.at(-1)!.p;
      t.src.release(last.kind === "gray" ? last.frame.data : null, 1);
      t.present();
    }
    expect(t.src.acquisition()).toBe("canvas");
    warn.mockRestore();
  });

  it("demote() from the consumer (worker could not read) switches to main-thread reads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = vfSetup({ onPacket: true });
    t.src.start();
    const p = t.packets[0].p;
    if (p.kind === "videoframe") p.frame.close();
    t.src.demote("videoframe-worker", "transfer 실패");
    t.src.demote("canvas", "무시됨");
    t.src.release(null);
    t.present();
    await tick();
    expect(t.src.acquisition()).toBe("videoframe");
    expect(t.packets.at(-1)!.p).toMatchObject({ kind: "gray", mode: "videoframe" });
    warn.mockRestore();
  });

  it("an unsupported format on the main thread demotes to canvas and grabs again right away", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = vfSetup({
      make: () => Object.assign(new FakeVideoFrame("I444X", 640, 480, new Uint8Array(640 * 480)), { convertible: false }),
    });
    t.src.start();
    await tick();
    expect(t.src.acquisition()).toBe("canvas");
    expect(t.frames.length).toBe(1); // 실패 직후 캔버스로 한 장
    expect(t.draws.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("stop() while a main-thread read is pending drops the late frame", async () => {
    const t = vfSetup({});
    t.src.start();
    t.src.stop();
    await tick();
    expect(t.frames.length).toBe(0);
    expect(t.made[0].closed).toBe(true);
  });

  it("source swap / resize events re-arm the frame callback and grab at once; listeners are removed on stop", () => {
    const t = vfSetup({ onPacket: true });
    t.src.start();
    t.src.release(null, 1);
    // 공급원 교체: rVFC 예약이 사라졌다고 가정
    (t.video as { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback?.(1);
    expect(t.pending()).toBe(false);
    t.fire("emptied");
    expect(t.pending()).toBe(true);
    t.advance(40);
    t.fire("loadedmetadata");
    expect(t.packets.length).toBe(2);
    t.src.stop();
    expect([...t.listeners.values()].every((s) => s.size === 0)).toBe(true);
  });
});
