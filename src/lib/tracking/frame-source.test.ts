import { describe, expect, it, vi } from "vitest";
import {
  FrameClock,
  FrameSource,
  RateController,
  downscaleSteps,
  workingSize,
  type CanvasLike,
  type FrameSourceEnv,
} from "./frame-source";
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
