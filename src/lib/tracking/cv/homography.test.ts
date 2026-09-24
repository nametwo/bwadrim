import { describe, expect, it } from "vitest";
import type { Mat3 } from "../types";
import { applyH, normalizeH } from "../geometry";
import {
  DEFAULT_RANSAC,
  HomographyRansac,
  checkHomography,
  countInliers,
  fitHomographyDLT,
  homographyFromQuads,
  hullArea,
  jacobiEigen,
  maxCornerDistance,
  refineHomographyLM,
  solveSPD,
} from "./homography";
import { Rng } from "./rng";

const Htrue: Mat3 = [1.1, 0.12, 14, -0.08, 0.93, -6, 0.0009, -0.0006, 1];

function expectSameH(A: Mat3, B: Mat3, tol = 1e-7) {
  const a = normalizeH(A);
  const b = normalizeH(B);
  for (let i = 0; i < 9; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol * Math.max(1, Math.abs(b[i])));
}

function makeCorr(n: number, H: Mat3, noise: number, outlierFrac: number, rng: Rng) {
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const isIn = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    sx[i] = rng.range(0, 320);
    sy[i] = rng.range(0, 240);
    if (rng.next() < outlierFrac) {
      dx[i] = rng.range(0, 320);
      dy[i] = rng.range(0, 240);
    } else {
      const p = applyH(H, { x: sx[i], y: sy[i] })!;
      dx[i] = p.x + rng.gauss() * noise;
      dy[i] = p.y + rng.gauss() * noise;
      isIn[i] = 1;
    }
  }
  return { sx, sy, dx, dy, isIn };
}

describe("homography", () => {
  it("4-point solve is exact", () => {
    const src = [
      { x: 10, y: 20 },
      { x: 300, y: 15 },
      { x: 290, y: 230 },
      { x: 25, y: 210 },
    ];
    const dst = src.map((p) => applyH(Htrue, p)!);
    expectSameH(homographyFromQuads(src, dst)!, Htrue, 1e-9);
    // 일직선 3점은 퇴화
    expect(
      homographyFromQuads(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 0, y: 5 },
        ],
        dst,
      ),
    ).toBeNull();
  });

  it("normalized DLT is exact on noiseless points and accurate with noise", () => {
    const rng = new Rng(1);
    const c = makeCorr(30, Htrue, 0, 0, rng);
    expectSameH(fitHomographyDLT(c.sx, c.sy, c.dx, c.dy, 30)!, Htrue, 1e-8);
    const noisy = makeCorr(200, Htrue, 0.5, 0, rng);
    const H = fitHomographyDLT(noisy.sx, noisy.sy, noisy.dx, noisy.dy, 200)!;
    expect(maxCornerDistance(H, Htrue, { x: 0, y: 0, width: 320, height: 240 })).toBeLessThan(0.5);
    // mask로 부분집합만
    const mask = new Uint8Array(30);
    mask.fill(1, 0, 6);
    expectSameH(fitHomographyDLT(c.sx, c.sy, c.dx, c.dy, 30, mask)!, Htrue, 1e-8);
  });

  it("RANSAC recovers the model with 50% outliers, deterministically", () => {
    const rng = new Rng(2);
    const n = 200;
    const c = makeCorr(n, Htrue, 0.4, 0.5, rng);
    const mask = new Uint8Array(n);
    const r = new HomographyRansac();
    const res = r.run(c.sx, c.sy, c.dx, c.dy, n, { ...DEFAULT_RANSAC, threshold: 2 }, new Rng(42), mask);
    expect(res.H).not.toBeNull();
    expect(maxCornerDistance(res.H!, Htrue, { x: 0, y: 0, width: 320, height: 240 })).toBeLessThan(0.6);
    let tp = 0;
    let fp = 0;
    let nIn = 0;
    for (let i = 0; i < n; i++) {
      nIn += c.isIn[i];
      if (mask[i] && c.isIn[i]) tp++;
      if (mask[i] && !c.isIn[i]) fp++;
    }
    expect(tp / nIn).toBeGreaterThan(0.97);
    expect(fp).toBeLessThanOrEqual(2);
    expect(res.inliers).toBe(tp + fp);
    // 같은 시드 → 같은 결과
    const mask2 = new Uint8Array(n);
    const res2 = new HomographyRansac().run(c.sx, c.sy, c.dx, c.dy, n, { ...DEFAULT_RANSAC, threshold: 2 }, new Rng(42), mask2);
    expect(res2.H).toEqual(res.H);
    expect(Array.from(mask2)).toEqual(Array.from(mask));
  });

  it("RANSAC adapts iterations: few when clean, more with outliers", () => {
    const rng = new Rng(3);
    const clean = makeCorr(100, Htrue, 0.3, 0, rng);
    const dirty = makeCorr(100, Htrue, 0.3, 0.6, rng);
    const r = new HomographyRansac();
    const a = r.run(clean.sx, clean.sy, clean.dx, clean.dy, 100, DEFAULT_RANSAC, new Rng(1), new Uint8Array(100));
    const b = r.run(dirty.sx, dirty.sy, dirty.dx, dirty.dy, 100, DEFAULT_RANSAC, new Rng(1), new Uint8Array(100));
    expect(a.iterations).toBeLessThan(40);
    expect(b.iterations).toBeGreaterThan(a.iterations);
    expect(b.H).not.toBeNull();
  });

  it("RANSAC uses a supplied hypothesis and fails cleanly on garbage", () => {
    const rng = new Rng(4);
    const c = makeCorr(50, Htrue, 0.2, 0.2, rng);
    const res = new HomographyRansac().run(
      c.sx,
      c.sy,
      c.dx,
      c.dy,
      50,
      { ...DEFAULT_RANSAC, maxIters: 1 },
      new Rng(1),
      new Uint8Array(50),
      [Htrue],
    );
    expect(res.inliers).toBeGreaterThan(35);
    const junk = makeCorr(50, Htrue, 0, 1, rng);
    const bad = new HomographyRansac().run(junk.sx, junk.sy, junk.dx, junk.dy, 50, DEFAULT_RANSAC, new Rng(1), new Uint8Array(50));
    expect(bad.inliers).toBeLessThan(10);
    expect(new HomographyRansac().run(junk.sx, junk.sy, junk.dx, junk.dy, 3, DEFAULT_RANSAC, new Rng(1), new Uint8Array(3)).H).toBeNull();
  });

  it("LM refinement reduces reprojection error vs. a perturbed start", () => {
    const rng = new Rng(5);
    const c = makeCorr(80, Htrue, 0.3, 0, rng);
    const start: Mat3 = Htrue.map((v, i) => v * (1 + (i < 8 ? 0.02 : 0)));
    const err = (H: Mat3) => {
      let e = 0;
      for (let i = 0; i < 80; i++) {
        const p = applyH(H, { x: c.sx[i], y: c.sy[i] })!;
        e += (p.x - c.dx[i]) ** 2 + (p.y - c.dy[i]) ** 2;
      }
      return Math.sqrt(e / 80);
    };
    const H = refineHomographyLM(c.sx, c.sy, c.dx, c.dy, 80, null, start, 20);
    expect(err(start)).toBeGreaterThan(2);
    expect(err(H)).toBeLessThan(0.5);
    expect(maxCornerDistance(H, Htrue, { x: 0, y: 0, width: 320, height: 240 })).toBeLessThan(0.3);
  });

  it("countInliers / hullArea", () => {
    const rng = new Rng(6);
    const c = makeCorr(40, Htrue, 0, 0.25, rng);
    const mask = new Uint8Array(40);
    const k = countInliers(Htrue, c.sx, c.sy, c.dx, c.dy, 40, 1, mask);
    expect(k).toBe(c.isIn.reduce((a, b) => a + b, 0));
    const xs = new Float64Array([0, 10, 10, 0, 5]);
    const ys = new Float64Array([0, 0, 10, 10, 5]);
    expect(hullArea(xs, ys, 5, null)).toBeCloseTo(100, 9);
    expect(hullArea(xs, ys, 5, new Uint8Array([1, 1, 0, 0, 1]))).toBeCloseTo(25, 9);
  });

  it("sanity checks reject implausible warps", () => {
    const roi = { x: 100, y: 80, width: 120, height: 80 };
    expect(checkHomography([1, 0, 0, 0, 1, 0, 0, 0, 1], roi).ok).toBe(true);
    expect(checkHomography(Htrue, roi).ok).toBe(true);
    expect(checkHomography([-1, 0, 400, 0, 1, 0, 0, 0, 1], roi).reason).toBe("flipped");
    expect(checkHomography([5, 0, 0, 0, 5, 0, 0, 0, 1], roi).reason).toBe("area");
    expect(checkHomography([0.2, 0, 0, 0, 0.2, 0, 0, 0, 1], roi).reason).toBe("area");
    expect(checkHomography([1, 0, 0, 0, 1, 0, -0.004, 0, 1], roi).reason).toBe("perspective");
    // 완만한 원근은 통과
    expect(checkHomography([1, 0, 0, 0, 1, 0, 0.001, 0.0005, 1], roi).ok).toBe(true);
    expect(checkHomography([1, 3, 0, 0, 1, 0, 0, 0, 1], roi).ok).toBe(false); // 극단적 전단
    expect(checkHomography([1, 0, 0, 0, 1, 0, 0, 0, NaN], roi).reason).toBe("nan");
    // 꼬인(비볼록) 사각형
    const twisted = homographyFromQuads(
      [
        { x: 100, y: 80 },
        { x: 220, y: 80 },
        { x: 220, y: 160 },
        { x: 100, y: 160 },
      ],
      [
        { x: 100, y: 80 },
        { x: 220, y: 80 },
        { x: 100, y: 160 },
        { x: 220, y: 160 },
      ],
    );
    if (twisted) expect(checkHomography(twisted, roi).ok).toBe(false);
  });

  it("jacobiEigen and solveSPD", () => {
    const rng = new Rng(7);
    const n = 6;
    const B = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) B[i] = rng.gauss();
    const A = new Float64Array(n * n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += B[i * n + k] * B[j * n + k];
        A[i * n + j] = s + (i === j ? 0.5 : 0);
      }
    const A0 = A.slice();
    const V = new Float64Array(n * n);
    const d = new Float64Array(n);
    jacobiEigen(A, n, V, d);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += A0[i * n + j] * V[j * n + k];
        expect(s).toBeCloseTo(d[k] * V[i * n + k], 8);
      }
    }
    const b = new Float64Array(n).map(() => rng.gauss());
    const x = new Float64Array(n);
    expect(solveSPD(A0, b, n, x)).toBe(true);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += A0[i * n + j] * x[j];
      expect(s).toBeCloseTo(b[i], 8);
    }
  });
});
