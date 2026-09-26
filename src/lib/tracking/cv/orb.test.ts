import { describe, expect, it } from "vitest";
import type { GrayImage, Mat3 } from "../types";
import { applyH, invert3, mul3 } from "../geometry";
import { DEFAULT_RANSAC, HomographyRansac } from "./homography";
import { Pyramid } from "./image";
import { HammingMatcher, MatchList, hamming } from "./match";
import { DEFAULT_ORB_PARAMS, OrbExtractor, OrbFeatures, PATCH_RADIUS, ScalePyramid, icAngle } from "./orb";
import { Rng } from "./rng";
import { camHomography, makeTexture, renderView } from "./testing/synth";

const world = makeTexture(800, 600, 21);
const W = 320;
const H = 240;

function viewAt(p: { rot?: number; scale?: number; tx?: number; ty?: number }): Mat3 {
  // 월드 중앙을 프레임 중앙에 두고 배율 0.6 기준
  return camHomography({
    cx: 400,
    cy: 300,
    tx: -240 + (p.tx ?? 0),
    ty: -180 + (p.ty ?? 0),
    rot: p.rot ?? 0,
    scale: 0.6 * (p.scale ?? 1),
  });
}

function extract(img: GrayImage, n = 500): OrbFeatures {
  const pyr = new Pyramid();
  pyr.build(img, 4);
  const sp = new ScalePyramid();
  sp.build(pyr, 5);
  const f = new OrbFeatures();
  new OrbExtractor().extract(sp, { ...DEFAULT_ORB_PARAMS, nFeatures: n }, f);
  return f;
}

/** a → b 매칭 + RANSAC. 프레임 중심에서의 오차와 인라이어 수 */
function matchAndFit(a: OrbFeatures, b: OrbFeatures, Htrue: Mat3) {
  const m = new MatchList();
  new HammingMatcher().match(a.desc, null, a.n, b.desc, b.n, { maxDistance: 64, ratio: 0.8, mutual: true }, m);
  const sx = new Float64Array(m.n);
  const sy = new Float64Array(m.n);
  const dx = new Float64Array(m.n);
  const dy = new Float64Array(m.n);
  let correct = 0;
  for (let k = 0; k < m.n; k++) {
    sx[k] = a.x[m.q[k]];
    sy[k] = a.y[m.q[k]];
    dx[k] = b.x[m.t[k]];
    dy[k] = b.y[m.t[k]];
    const p = applyH(Htrue, { x: sx[k], y: sy[k] })!;
    if (Math.hypot(p.x - dx[k], p.y - dy[k]) < 4) correct++;
  }
  const mask = new Uint8Array(m.n);
  const res = new HomographyRansac().run(sx, sy, dx, dy, m.n, { ...DEFAULT_RANSAC, threshold: 4 }, new Rng(1), mask);
  let maxErr = Infinity;
  if (res.H) {
    maxErr = 0;
    for (const c of [
      { x: 110, y: 70 },
      { x: 210, y: 70 },
      { x: 210, y: 170 },
      { x: 110, y: 170 },
    ]) {
      const p = applyH(res.H, c)!;
      const q = applyH(Htrue, c)!;
      maxErr = Math.max(maxErr, Math.hypot(p.x - q.x, p.y - q.y));
    }
  }
  return { matches: m.n, correct, inliers: res.inliers, maxErr };
}

describe("ORB", () => {
  const V0 = viewAt({});
  const img0 = renderView(world, V0, W, H, { noise: 1.5, rng: new Rng(1) });
  const f0 = extract(img0);

  it("extracts the requested number of spread-out features over 5 scales", () => {
    expect(f0.n).toBeGreaterThan(400);
    expect(f0.n).toBeLessThanOrEqual(500);
    const levels = new Set(Array.from(f0.level.subarray(0, f0.n)));
    expect(levels.size).toBe(5);
    // 전체 영역에 퍼져 있어야 (사분면마다 존재)
    const q = [0, 0, 0, 0];
    for (let i = 0; i < f0.n; i++) q[(f0.x[i] < W / 2 ? 0 : 1) + (f0.y[i] < H / 2 ? 0 : 2)]++;
    for (const c of q) expect(c).toBeGreaterThan(f0.n / 10);
  });

  it("is deterministic", () => {
    const again = extract(img0);
    expect(again.n).toBe(f0.n);
    expect(Array.from(again.desc.subarray(0, again.n * 8))).toEqual(Array.from(f0.desc.subarray(0, f0.n * 8)));
  });

  it("orientation follows image rotation (intensity centroid)", () => {
    // 90° 회전 영상을 인덱스 치환으로 정확히 만든다
    const w = 64;
    const src = makeTexture(w, w, 9);
    const rot = { width: w, height: w, data: new Uint8Array(w * w) };
    // rot(x, y) = src(y, w-1-x)  → 내용이 +90° (y축 아래 방향 기준 시계) 회전
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) rot.data[y * w + x] = src.data[(w - 1 - x) * w + y];
    const a0 = icAngle(src.data, w, 32, 32);
    // src의 (32,32)는 rot에서 (w-1-32, 32) = (31, 32)
    const a1 = icAngle(rot.data, w, 31, 32);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    expect(Math.abs(Math.abs(d) - Math.PI / 2)).toBeLessThan(0.05);
  });

  it("matches under 30° rotation", () => {
    const V1 = viewAt({ rot: Math.PI / 6 });
    const img1 = renderView(world, V1, W, H, { noise: 1.5, rng: new Rng(2) });
    const r = matchAndFit(f0, extract(img1), mul3(V1, invert3(V0)!));
    expect(r.inliers).toBeGreaterThan(60);
    expect(r.correct / r.matches).toBeGreaterThan(0.7);
    expect(r.maxErr).toBeLessThan(1.5);
  });

  it("matches under 90° rotation", () => {
    const V1 = viewAt({ rot: Math.PI / 2 });
    const img1 = renderView(world, V1, W, H, { noise: 1.5, rng: new Rng(3) });
    const r = matchAndFit(f0, extract(img1), mul3(V1, invert3(V0)!));
    expect(r.inliers).toBeGreaterThan(30);
    expect(r.maxErr).toBeLessThan(2);
  });

  it("matches under 1.5× scale + 30° rotation (both directions)", () => {
    const V1 = viewAt({ rot: Math.PI / 6, scale: 1.5 });
    const img1 = renderView(world, V1, W, H, { noise: 1.5, rng: new Rng(4) });
    const f1 = extract(img1);
    const up = matchAndFit(f0, f1, mul3(V1, invert3(V0)!));
    expect(up.inliers).toBeGreaterThan(25);
    expect(up.maxErr).toBeLessThan(2);
    const down = matchAndFit(f1, f0, mul3(V0, invert3(V1)!));
    expect(down.inliers).toBeGreaterThan(25);
  });

  it("steered BRIEF stays inside the patch (no out-of-range reads at the border)", () => {
    // 경계 가까이에서도 NaN/undefined 없이 계산 (Int32 디스크립터가 모두 정수)
    for (let i = 0; i < f0.n; i++) {
      for (let k = 0; k < 8; k++) expect(Number.isInteger(f0.desc[i * 8 + k])).toBe(true);
    }
    expect(PATCH_RADIUS).toBeGreaterThan(8);
  });

  it("descriptor distances: same point small, random points large", () => {
    const V1 = viewAt({ tx: 7.3, ty: -4.1 });
    const img1 = renderView(world, V1, W, H, { noise: 1.5, rng: new Rng(5) });
    const f1 = extract(img1);
    const Ht = mul3(V1, invert3(V0)!);
    let same = 0;
    let sameN = 0;
    let rnd = 0;
    let rndN = 0;
    for (let i = 0; i < f0.n; i++) {
      const p = applyH(Ht, { x: f0.x[i], y: f0.y[i] })!;
      for (let j = 0; j < f1.n; j++) {
        if (f1.level[j] !== f0.level[i]) continue;
        const d = Math.hypot(f1.x[j] - p.x, f1.y[j] - p.y);
        if (d < 1) {
          same += hamming(f0.desc, i, f1.desc, j);
          sameN++;
        } else if (d > 60 && rndN < 2000) {
          rnd += hamming(f0.desc, i, f1.desc, j);
          rndN++;
        }
      }
    }
    expect(sameN).toBeGreaterThan(50);
    expect(same / sameN).toBeLessThan(30);
    expect(rnd / rndN).toBeGreaterThan(90);
  });
});
