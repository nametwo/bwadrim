// 렌더러 ↔ 정답(GT) 일치 검증: 점 무늬 합성 텍스처를 전체 파이프라인(렌더 → 면적 축소 → JPEG)에 통과시키고
// 점의 밝기 무게중심이 해석적 GT 투영(롤링 셔터 포함)과 맞는지 본다. 좌표 규약(가장자리/중심)·축소 배율·
// 롤링 셔터·모션 블러가 하나라도 어긋나면 여기서 잡힌다.
import { describe, expect, it } from "vitest";
import { mul3 } from "../../src/lib/tracking/geometry";
import type { Point } from "../../src/lib/tracking/types";
import { type ViewFn, intrinsics, keyframes, poseFromView, project, streamToWork, workDims } from "./camera";
import { downscaleArea, jpegRoundTripGray, jpegSimGray, toWorking } from "./imageops";
import { CameraRenderer, type SceneSetup } from "./render";
import { Rng } from "./rng";
import { projectRS } from "./sequence";
import { type Texture, buildMip } from "./textures";

const TW = 800;
const TH = 600;
// 점 위치 (텍스처 픽셀) — 서로 멀리
const DOTS: Point[] = [];
for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) DOTS.push({ x: 90 + i * 155, y: 80 + j * 150 });

function dotTexture(): Texture {
  const d = new Float32Array(TW * TH);
  const sig = 7;
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      let v = 0.8;
      for (const p of DOTS) {
        const dx = x + 0.5 - p.x;
        const dy = y + 0.5 - p.y;
        const r2 = dx * dx + dy * dy;
        if (r2 < 900) v -= 0.75 * Math.exp(-r2 / (2 * sig * sig));
      }
      d[y * TW + x] = v;
    }
  }
  return { id: "dots", width: TW, height: TH, channels: [buildMip(d, TW, TH)] };
}

function flatTexture(v: number): Texture {
  const d = new Float32Array(64 * 64).fill(v);
  return { id: "flat", width: 64, height: 64, channels: [buildMip(d, 64, 64)] };
}

function scene(view: ViewFn, stream: [number, number], exposureMs: number, readoutMs: number): SceneSetup {
  return {
    target: dotTexture(),
    bg: flatTexture(0.8),
    bgPlane: { z: 0, affine: [40, 0, -1200, 0, 40, -1200] },
    poseAt: (t) => poseFromView(view(t)),
    streamAt: () => intrinsics(stream[0], stream[1]),
    exposureMs,
    readoutMs,
    photoAt: () => ({ scene: 1, gain: 1, contrast: 1, brightness: 0 }),
    noise: { shot: 0, read: 0 },
    vignette: 0,
    opticalBlur: true,
    lightDir: [0, 0, 1],
    seed: 1,
  };
}

/** 작업 해상도 영상에서 예상 위치 주변 어두운 점의 무게중심 */
function centroid(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, p: Point, r: number): Point | null {
  // 배경 밝기: 창 테두리 중앙값
  const xs = Math.round(p.x);
  const ys = Math.round(p.y);
  if (xs - r < 0 || ys - r < 0 || xs + r >= img.width || ys + r >= img.height) return null;
  const border: number[] = [];
  for (let i = -r; i <= r; i++) {
    border.push(img.data[(ys - r) * img.width + xs + i], img.data[(ys + r) * img.width + xs + i]);
    border.push(img.data[(ys + i) * img.width + xs - r], img.data[(ys + i) * img.width + xs + r]);
  }
  border.sort((a, b) => a - b);
  const bgv = border[border.length >> 1];
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let y = ys - r; y <= ys + r; y++) {
    for (let x = xs - r; x <= xs + r; x++) {
      const w = Math.max(0, bgv - img.data[y * img.width + x] - 2);
      sw += w;
      sx += w * x;
      sy += w * y;
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
}

function measure(
  sc: SceneSetup,
  t: number,
  opts: { jpeg?: number; blur?: "fast" | "subframes" } = {},
): { errs: number[]; n: number } {
  const r = new CameraRenderer(sc, false, opts.blur ?? "fast");
  const cam = r.render(t);
  let g = cam.planes[0];
  if (opts.jpeg) g = jpegSimGray(g, cam.width, cam.height, opts.jpeg);
  const work = toWorking(g, cam.width, cam.height);
  const S = streamToWork(cam.width, cam.height, work.width, work.height);
  const errs: number[] = [];
  for (const d of DOTS) {
    const ps = projectRS(sc, t, d);
    if (!ps) continue;
    const pw = project(S, ps.x, ps.y)!;
    const c = centroid(work, pw, 7);
    if (!c) continue;
    errs.push(Math.hypot(c.x - pw.x, c.y - pw.y));
  }
  return { errs, n: errs.length };
}

const still = (v: Partial<{ x: number; y: number; dist: number; yaw: number; pitch: number; roll: number }>): ViewFn => {
  const k = keyframes([{ t: 0, x: 400, y: 300, dist: 900, yaw: 0, pitch: 0, roll: 0, ...v }]);
  return k;
};

describe("renderer ↔ GT agreement (dot centroids)", { timeout: 60_000 }, () => {
  it("frontal, static, 480x640 → 240x320", () => {
    const { errs, n } = measure(scene(still({}), [480, 640], 0, 0), 0);
    expect(n).toBeGreaterThanOrEqual(10);
    expect(Math.max(...errs)).toBeLessThan(0.06);
  });

  it("tilted + rolled, static, non-integer downscale 600x800 → 240x320", () => {
    const { errs, n } = measure(scene(still({ yaw: 35, pitch: -20, roll: 25, dist: 1000 }), [600, 800], 0, 0), 0);
    expect(n).toBeGreaterThanOrEqual(8);
    expect(Math.max(...errs)).toBeLessThan(0.12);
  });

  it("landscape 640x480 and HD 720x1280", () => {
    for (const s of [
      [640, 480],
      [720, 1280],
    ] as [number, number][]) {
      const { errs, n } = measure(scene(still({ yaw: 10, pitch: 8, dist: 950 }), s, 0, 0), 0);
      expect(n).toBeGreaterThanOrEqual(8);
      expect(Math.max(...errs)).toBeLessThan(0.1);
    }
  });

  it("fast pan with rolling shutter (25ms readout) + motion blur (16ms)", () => {
    // 초당 ~900 평면단위 → 스트림에서 초당 수백 px: 롤링 셔터 기울어짐이 수 px
    const view = keyframes([
      { t: 0, x: 200, y: 300, dist: 900, yaw: 0, pitch: 0, roll: 0 },
      { t: 1, x: 600, y: 360, roll: 6, ease: "linear" },
    ]);
    const sc = scene(view, [480, 640], 16, 25);
    const { errs, n } = measure(sc, 0.5);
    expect(n).toBeGreaterThanOrEqual(8);
    expect(Math.max(...errs)).toBeLessThan(0.25);
    // 롤링 셔터를 무시한 투영과는 확실히 달라야 한다 (테스트가 RS를 실제로 검증하는지)
    const K = sc.streamAt(0.5);
    const pose = sc.poseAt(0.5);
    let maxShift = 0;
    for (const d of DOTS) {
      const a = projectRS(sc, 0.5, d);
      const Rw = pose.R;
      const xc = [
        Rw[0] * (d.x - pose.C[0]) + Rw[1] * (d.y - pose.C[1]) + Rw[2] * -pose.C[2],
        Rw[3] * (d.x - pose.C[0]) + Rw[4] * (d.y - pose.C[1]) + Rw[5] * -pose.C[2],
        Rw[6] * (d.x - pose.C[0]) + Rw[7] * (d.y - pose.C[1]) + Rw[8] * -pose.C[2],
      ];
      const gx = K.f * (xc[0] / xc[2]) + K.cx;
      if (a) maxShift = Math.max(maxShift, Math.abs(a.x - gx));
    }
    expect(maxShift).toBeGreaterThan(1.0);
  });

  it("fast motion blur (per-surface line integral) ≈ exact sub-frame pose averaging", () => {
    // 회전+이동이 섞인 빠른 움직임, 노출 20ms
    const view = keyframes([
      { t: 0, x: 250, y: 280, dist: 900, yaw: -10, pitch: 5, roll: 0 },
      { t: 1, x: 750, y: 380, yaw: 25, roll: 30, dist: 800, ease: "linear" },
    ]);
    const sc = scene(view, [480, 640], 20, 16);
    sc.bg = dotTexture(); // 배경에도 무늬 (시차 있는 두 평면)
    sc.bgPlane = { z: 300, affine: [1.5, 0, -300, 0, 1.5, -300] };
    const fast = new CameraRenderer(sc, false, "fast").render(0.5);
    const exact = new CameraRenderer(sc, false, "subframes").render(0.5);
    const a = toWorking(fast.planes[0], 480, 640).data;
    const b = toWorking(exact.planes[0], 480, 640).data;
    let mad = 0;
    let mx = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      mad += d;
      mx = Math.max(mx, d);
    }
    // 흐림이 실제로 있음: 선명한 한 장과의 차이보다 두 흐림 방식 사이 차이가 훨씬 작아야 한다
    const sharp = { ...sc, exposureMs: 0 };
    const c = toWorking(new CameraRenderer(sharp, false).render(0.5).planes[0], 480, 640).data;
    let diff = 0;
    let dmax = 0;
    for (let i = 0; i < a.length; i++) {
      diff += Math.abs(a[i] - c[i]);
      dmax = Math.max(dmax, Math.abs(a[i] - c[i]));
    }
    expect(dmax).toBeGreaterThan(25);
    expect(mad).toBeLessThan(0.25 * diff);
    expect(mx).toBeLessThan(0.5 * dmax);
    // 정확 모드도 점 무게중심이 GT와 맞는다
    const { errs } = measure(sc, 0.5, { blur: "subframes" });
    expect(Math.max(...errs)).toBeLessThan(0.3);
  });

  it("JPEG q30 transport does not shift geometry", () => {
    const { errs } = measure(scene(still({ yaw: -15, dist: 950 }), [480, 640], 0, 0), 0, { jpeg: 30 });
    expect(Math.max(...errs)).toBeLessThan(0.2);
  });
});

describe("image ops", { timeout: 30_000 }, () => {
  it("downscaleArea: integer 2x equals rounded 2x2 box mean", () => {
    const r = new Rng(3);
    const w = 16;
    const h = 12;
    const src = new Uint8Array(w * h).map(() => r.int(256));
    const out = downscaleArea(src, w, h, 8, 6);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 8; x++) {
        const s = src[2 * y * w + 2 * x] + src[2 * y * w + 2 * x + 1] + src[(2 * y + 1) * w + 2 * x] + src[(2 * y + 1) * w + 2 * x + 1];
        expect(out[y * 8 + x]).toBe(Math.floor(s / 4 + 0.5));
      }
    }
  });

  it("downscaleArea: non-integer ratio preserves mean and a flat image", () => {
    const flat = new Uint8Array(600 * 800).fill(137);
    expect(downscaleArea(flat, 600, 800, 240, 320).every((v) => v === 137)).toBe(true);
    const r = new Rng(5);
    const src = new Uint8Array(600 * 800).map(() => r.int(256));
    const out = downscaleArea(src, 600, 800, 240, 320);
    const m1 = src.reduce((a, b) => a + b, 0) / src.length;
    const m2 = out.reduce((a, b) => a + b, 0) / out.length;
    expect(Math.abs(m1 - m2)).toBeLessThan(0.6);
  });

  it("workDims: long side 320", () => {
    expect(workDims(480, 640)).toEqual([240, 320]);
    expect(workDims(640, 480)).toEqual([320, 240]);
    expect(workDims(720, 1280)).toEqual([180, 320]);
    expect(workDims(240, 320)).toEqual([240, 320]);
  });

  it("jpegSimGray ≈ jpeg-js round trip (luma)", () => {
    const sc = scene(still({ yaw: 20, pitch: -10, dist: 700 }), [480, 640], 0, 0);
    sc.noise = { shot: 0.0003, read: 0.002 };
    const g = new CameraRenderer(sc, false).render(0).planes[0];
    for (const q of [25, 50, 80]) {
      const a = jpegSimGray(g, 480, 640, q);
      const b = jpegRoundTripGray(g, 480, 640, q);
      let mad = 0;
      for (let i = 0; i < a.length; i++) mad += Math.abs(a[i] - b[i]);
      expect(mad / a.length).toBeLessThan(0.15);
    }
  });

  it("stream→work transform maps pixel centers consistently", () => {
    // 스트림 픽셀 중심 (0.5,0.5)과 (1.5,1.5) 사이 중점(=가장자리 1,1)이 작업 픽셀 0의 중심(0,0)이어야 한다 (2배 축소)
    const S = streamToWork(480, 640, 240, 320);
    const p = project(S, 1, 1)!;
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(0, 12);
    expect(mul3(S, [1, 0, 0, 0, 1, 0, 0, 0, 1])).toEqual(S);
  });
});
