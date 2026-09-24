// 실감 효과의 렌더 ↔ 정답 일치: 렌즈 왜곡·롤링 셔터·모션 블러·입체(부조) 시차가 섞여도 점 무늬 무게중심이
// 해석적 GT(projectRS: 왜곡·높이 반영)와 맞아야 한다. 효과가 실제로 있는지(무시하면 수 px 틀림)도 함께 본다.
import { describe, expect, it } from "vitest";
import type { Point } from "../../src/lib/tracking/types";
import { type ViewFn, intrinsics, keyframes, poseFromView, project, streamToWork } from "./camera";
import { fitHomography } from "./dlt";
import { toWorking } from "./imageops";
import { IspPipeline } from "./isp";
import { distort, lensFor, undistort } from "./lens";
import { buildReliefMap, heightAt, traceRelief } from "./relief";
import { CameraRenderer, type SceneSetup } from "./render";
import { projectRS, unprojectRS } from "./sequence";
import { type Texture, buildMip } from "./textures";

const TW = 800;
const TH = 600;
const DOTS: Point[] = [];
for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) DOTS.push({ x: 90 + i * 155, y: 80 + j * 150 });

function dotTexture(): Texture {
  const d = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      let v = 0.8;
      for (const p of DOTS) {
        const dx = x + 0.5 - p.x;
        const dy = y + 0.5 - p.y;
        const r2 = dx * dx + dy * dy;
        if (r2 < 900) v -= 0.75 * Math.exp(-r2 / 98);
      }
      d[y * TW + x] = v;
    }
  }
  return { id: "dots", width: TW, height: TH, channels: [buildMip(d, TW, TH)] };
}

function flat(v: number): Texture {
  return { id: "flat", width: 64, height: 64, channels: [buildMip(new Float32Array(64 * 64).fill(v), 64, 64)] };
}

function scene(view: ViewFn, exposureMs = 0, readoutMs = 0): SceneSetup {
  return {
    target: dotTexture(),
    bg: flat(0.8),
    bgPlane: { z: 0, affine: [40, 0, -1200, 0, 40, -1200] },
    poseAt: (t) => poseFromView(view(t)),
    streamAt: () => intrinsics(480, 640),
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

function centroid(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, p: Point, r: number): Point | null {
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

/** 점마다 (GT 작업 좌표, 측정 무게중심) — z(p)는 점의 표면 높이 */
function measure(sc: SceneSetup, t: number, z: (p: Point) => number = () => 0) {
  const cam = new CameraRenderer(sc, false).render(t);
  const work = toWorking(cam.planes[0], cam.width, cam.height);
  const S = streamToWork(cam.width, cam.height, work.width, work.height);
  const out: { gt: Point; c: Point; flat: Point | null }[] = [];
  for (const d of DOTS) {
    const ps = projectRS(sc, t, d, z(d));
    if (!ps) continue;
    const pw = project(S, ps.x, ps.y)!;
    const c = centroid(work, pw, 6);
    if (!c) continue;
    const pf = projectRS({ ...sc, lens: undefined, relief: undefined }, t, d, 0);
    out.push({ gt: pw, c, flat: pf ? project(S, pf.x, pf.y) : null });
  }
  return out;
}

const still = (v: Partial<{ x: number; y: number; dist: number; yaw: number; pitch: number; roll: number }>): ViewFn =>
  keyframes([{ t: 0, x: 400, y: 300, dist: 900, yaw: 0, pitch: 0, roll: 0, ...v }]);

describe("lens model", () => {
  it("distort ∘ undistort = identity; barrel k1 pulls corners inward", () => {
    const L = lensFor({ k1: -0.12, k2: 0.03, p1: 0.002, p2: -0.001 }, 480, 640);
    for (const [x, y] of [
      [0, 0],
      [480, 640],
      [100, 500],
      [240, 320],
    ]) {
      const q = undistort(L, x, y);
      const s = distort(L, q.x, q.y);
      expect(Math.hypot(s.x - x, s.y - y)).toBeLessThan(1e-7);
    }
    const Lb = lensFor({ k1: -0.1 }, 480, 640);
    const c = distort(Lb, 0, 0);
    expect(c.x).toBeGreaterThan(5); // 모서리가 안쪽으로 (수 px)
    expect(c.y).toBeGreaterThan(5);
  });

  it("DLT fit recovers an exact homography", () => {
    const H = [1.1, 0.05, 3, -0.02, 0.95, -4, 1e-4, -2e-4, 1];
    const src: Point[] = [];
    const dst: Point[] = [];
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 5; i++) {
        const p = { x: 30 + i * 40, y: 20 + j * 35 };
        src.push(p);
        dst.push(project(H, p.x, p.y)!);
      }
    const F = fitHomography(src, dst)!;
    for (let k = 0; k < 9; k++) expect(F[k]).toBeCloseTo(H[k], 6);
  });
});

describe("realism renderer ↔ GT (dot centroids)", { timeout: 120_000 }, () => {
  it("lens distortion (k1=−0.12, tangential) tilted view", () => {
    const sc = scene(still({ yaw: 20, pitch: -12, roll: 8, dist: 950 }));
    sc.lens = { k1: -0.12, k2: 0.03, p1: 0.002, p2: -0.001 };
    const r = measure(sc, 0);
    expect(r.length).toBeGreaterThanOrEqual(10);
    const errs = r.map((m) => Math.hypot(m.c.x - m.gt.x, m.c.y - m.gt.y));
    expect(Math.max(...errs)).toBeLessThan(0.15);
    // 왜곡을 무시한 투영과는 확실히 다르다 (작업 해상도에서 1.5px 넘게)
    const shift = Math.max(...r.map((m) => Math.hypot(m.flat!.x - m.gt.x, m.flat!.y - m.gt.y)));
    expect(shift).toBeGreaterThan(1.5);
  });

  it("lens + rolling shutter + motion blur (fast pan)", () => {
    const view = keyframes([
      { t: 0, x: 200, y: 300, dist: 900, yaw: 0, pitch: 0, roll: 0 },
      { t: 1, x: 600, y: 360, roll: 6, ease: "linear" },
    ]);
    const sc = scene(view, 16, 25);
    sc.lens = { k1: -0.09 };
    const r = measure(sc, 0.5);
    expect(r.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...r.map((m) => Math.hypot(m.c.x - m.gt.x, m.c.y - m.gt.y)))).toBeLessThan(0.3);
  });

  it("relief: dots on raised (+40) and recessed (−30) blocks follow 3D parallax", () => {
    const sc = scene(still({ yaw: 28, pitch: 18, dist: 900 }));
    const boxes = DOTS.map((d, i) => ({ x: d.x - 60, y: d.y - 60, w: 120, h: 120, r: 10, mm: i % 3 === 0 ? 40 : i % 3 === 1 ? -30 : 0 }));
    sc.relief = buildReliefMap("test", boxes, TW, TH, 1);
    const zOf = (p: Point) => -heightAt(sc.relief!, p.x, p.y);
    const r = measure(sc, 0, zOf);
    expect(r.length).toBeGreaterThanOrEqual(10);
    const errs = r.map((m) => Math.hypot(m.c.x - m.gt.x, m.c.y - m.gt.y));
    expect(Math.max(...errs)).toBeLessThan(0.2);
    const shift = Math.max(...r.map((m) => Math.hypot(m.flat!.x - m.gt.x, m.flat!.y - m.gt.y)));
    expect(shift).toBeGreaterThan(3);
  });

  it("relief ray trace: first hit, walls, and unproject ∘ project", () => {
    const R = buildReliefMap("t2", [{ x: 100, y: 100, w: 50, h: 50, mm: 20 }], 400, 300, 1);
    const hit = { u: 0, v: 0, z: 0, wall: false };
    // 정면: 윗면
    expect(traceRelief(R, 125, 125, -500, 0, 0, 1, hit)).toBe(true);
    expect(hit.z).toBeCloseTo(-20, 6);
    expect(hit.wall).toBe(false);
    // 비스듬히 옆벽: 상자 왼쪽(x=100)에 z=−10에서 닿는 광선
    const C = [100 - 510, 125, -510];
    expect(traceRelief(R, C[0], C[1], C[2], 1, 0, 1, hit)).toBe(true);
    expect(hit.wall).toBe(true);
    expect(hit.u).toBeCloseTo(100, 1);
    // unprojectRS ∘ projectRS
    const sc = scene(still({ yaw: 15, pitch: 10 }), 0, 20);
    sc.lens = { k1: -0.1 };
    const s = projectRS(sc, 0, { x: 333, y: 222 }, 0)!;
    const b = unprojectRS(sc, 0, s, 0)!;
    expect(Math.hypot(b.x - 333, b.y - 222)).toBeLessThan(1e-6);
  });
});

describe("ISP", () => {
  it("TNR is chunk-independent and smears a moving edge; sharpening adds halos", () => {
    const W = 64;
    const H = 8;
    // 움직이는 약한 가장자리 (프레임마다 2px 오른쪽) + 잡음
    const raw = (i: number) => {
      const p = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p[y * W + x] = (x < 20 + 2 * i ? 100 : 108) + ((x * 7 + y * 13 + i * 5) % 5) - 2;
      return { width: W, height: H, planes: [p] };
    };
    const spec = { tnr: { alpha: 0.3, lo: 4, hi: 12, window: 5 } };
    const a = new IspPipeline(spec, raw);
    const b = new IspPipeline(spec, raw);
    for (let i = 0; i < 10; i++) a.frame(i); // 앞에서부터 차례로
    const fa = a.frame(10).planes[0];
    const fb = b.frame(10).planes[0]; // 바로 10번
    expect(Buffer.from(fa).equals(Buffer.from(fb))).toBe(true);
    // 가장자리(x=40)가 지나간 왼쪽은 방금 어두워졌는데 이전 프레임의 밝은 값에 끌려 원시보다 밝다 (번짐)
    const r10 = raw(10).planes[0];
    let smear = 0;
    for (let x = 34; x < 40; x++) smear += fa[4 * W + x] - r10[4 * W + x];
    expect(smear / 6).toBeGreaterThan(1.5);
    // 샤프닝: 계단 양쪽에 넘침
    const step = () => {
      const p = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p[y * W + x] = x < 32 ? 60 : 180;
      return { width: W, height: H, planes: [p] };
    };
    const sh = new IspPipeline({ sharpen: { sigma: 1.2, amount: 1, threshold: 2 } }, step).frame(0).planes[0];
    expect(Math.min(...sh.subarray(4 * W, 5 * W))).toBeLessThan(55);
    expect(Math.max(...sh.subarray(4 * W, 5 * W))).toBeGreaterThan(185);
  });
});

describe("working-resolution resample = runtime frame-source (bit-exact)", () => {
  it("downscale (integer & fractional), upscale, limited-range Y — same bytes as resamplePlane", async () => {
    const { resamplePlane, workingSize } = await import("../../src/lib/tracking/frame-source");
    const { resampleGray, toWorkingLimited, limitedToFull } = await import("./imageops");
    const { workDims } = await import("./camera");
    const rng = (seed: number) => {
      let s = seed;
      return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24);
    };
    const cases: [number, number][] = [
      [480, 640],
      [640, 480],
      [720, 1280],
      [360, 480],
      [600, 800],
      [240, 336],
      [180, 240],
      [120, 160],
    ];
    for (const [w, h] of cases) {
      const r = rng(w * 7 + h);
      const src = new Uint8Array(w * h).map(() => r());
      const ws = workingSize(w, h)!;
      expect(workDims(w, h), `${w}x${h}`).toEqual([ws.width, ws.height]);
      for (const limited of [false, true]) {
        const a = new Uint8Array(ws.width * ws.height);
        resamplePlane(src, w, 0, 0, w, h, a, ws.width, ws.height, limited);
        const b = resampleGray(src, w, h, ws.width, ws.height, limited);
        expect(Buffer.from(b).equals(Buffer.from(a)), `${w}x${h} limited=${limited}`).toBe(true);
      }
    }
    // limited: 16 → 0, 235 → 255; 한 번 반올림이 두 번 반올림(전체 범위로 편 뒤 축소)과 ±1 안
    const y = new Uint8Array(480 * 640).map((_, i) => 16 + (i % 220));
    const one = toWorkingLimited(y, 480, 640).data;
    const two = resampleGray(limitedToFull(y), 480, 640, 240, 320);
    let mx = 0;
    for (let i = 0; i < one.length; i++) mx = Math.max(mx, Math.abs(one[i] - two[i]));
    expect(mx).toBeLessThanOrEqual(1);
    expect(limitedToFull(new Uint8Array([16, 235, 0, 255]))).toEqual(new Uint8Array([0, 255, 0, 255]));
  });
});

describe("codec frame-number band", () => {
  it("round-trips at full and half resolution, rejects a flipped bit (parity)", async () => {
    const { BAND_ROWS, bandBits, decodeBand } = await import("./codec");
    const W = 480;
    const H = 640 + BAND_ROWS;
    for (const idx of [0, 1, 211, 4095, 8191]) {
      const y = new Uint8Array(W * H).fill(90);
      const bits = bandBits(idx);
      for (let r = 640; r < H; r++) for (let x = 0; x < W; x++) y[r * W + x] = bits[Math.floor(x / (W / 16))] ? 235 : 16;
      expect(decodeBand(y, W, H, BAND_ROWS)).toBe(idx);
      const half = new Uint8Array((W / 2) * (H / 2));
      for (let r = 0; r < H / 2; r++) for (let x = 0; x < W / 2; x++) half[r * (W / 2) + x] = y[2 * r * W + 2 * x];
      expect(decodeBand(half, W / 2, H / 2, BAND_ROWS / 2)).toBe(idx);
      // 비트 하나를 뒤집으면 홀짝 검사에서 거른다
      const bad = y.slice();
      for (let r = 640; r < H; r++) for (let x = 30; x < 60; x++) bad[r * W + x] = bits[1] ? 16 : 235;
      expect(decodeBand(bad, W, H, BAND_ROWS)).toBeNull();
    }
  });
});
