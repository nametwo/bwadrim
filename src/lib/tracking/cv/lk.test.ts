import { describe, expect, it } from "vitest";
import { CornerList, detectFast, minDistanceFilter, scoreCorners } from "./fast";
import { Pyramid } from "./image";
import { DEFAULT_LK, PyrLK } from "./lk";
import { Rng } from "./rng";
import { camHomography, makeFlat, makeTexture, renderView } from "./testing/synth";

const world = makeTexture(700, 500, 31);
const W = 320;
const H = 240;
const base = (tx = 0, ty = 0) => camHomography({ cx: 350, cy: 250, tx: -190 + tx, ty: -130 + ty, scale: 0.7 });

function corners(img: ReturnType<typeof renderView>, max = 80) {
  const raw = new CornerList();
  detectFast(img, 12, 12, raw);
  scoreCorners(img, raw, "mineig", 3);
  const sel = new CornerList();
  minDistanceFilter(raw, sel, img.width, img.height, 8, max, 4);
  // 가장자리에서 먼 점만 (큰 이동에도 창이 안에 있게)
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < sel.n; i++) {
    if (sel.x[i] > 40 && sel.x[i] < W - 40 && sel.y[i] > 40 && sel.y[i] < H - 40) {
      xs.push(sel.x[i]);
      ys.push(sel.y[i]);
    }
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), n: xs.length };
}

function run(tx: number, ty: number, opts: { gain?: number; bias?: number; guess?: boolean } = {}) {
  const img0 = renderView(world, base(), W, H, { noise: 1, rng: new Rng(1) });
  const img1 = renderView(world, base(tx, ty), W, H, {
    noise: 1,
    rng: new Rng(2),
    gain: opts.gain,
    bias: opts.bias,
  });
  const p0 = new Pyramid();
  const p1 = new Pyramid();
  p0.build(img0, 4);
  p1.build(img1, 4);
  const c = corners(img0);
  const n = c.n;
  const gx = new Float64Array(n);
  const gy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    gx[i] = c.x[i] + (opts.guess ? tx * 0.8 : 0);
    gy[i] = c.y[i] + (opts.guess ? ty * 0.8 : 0);
  }
  const ox = new Float64Array(n);
  const oy = new Float64Array(n);
  const st = new Uint8Array(n).fill(1);
  const err = new Float32Array(n);
  const good = new PyrLK().track(p0, p1, n, c.x, c.y, gx, gy, ox, oy, st, err, DEFAULT_LK);
  // 월드 배율 0.7로 볼 때 이동량 (tx, ty)는 프레임 픽셀 그대로
  const errs: number[] = [];
  for (let i = 0; i < n; i++) if (st[i]) errs.push(Math.hypot(ox[i] - c.x[i] - tx, oy[i] - c.y[i] - ty));
  errs.sort((a, b) => a - b);
  return { n, good, median: errs[errs.length >> 1], p90: errs[Math.floor(errs.length * 0.9)], p0, p1, c, ox, oy, st };
}

describe("pyramidal Lucas–Kanade", () => {
  it("recovers sub-pixel translations", () => {
    const r = run(1.37, -0.62);
    expect(r.n).toBeGreaterThan(20);
    expect(r.good / r.n).toBeGreaterThan(0.9);
    expect(r.median).toBeLessThan(0.05);
    expect(r.p90).toBeLessThan(0.15);
  });

  it("recovers large translations through the pyramid (no initial guess)", () => {
    const r = run(17.4, 11.8);
    expect(r.good / r.n).toBeGreaterThan(0.8);
    expect(r.median).toBeLessThan(0.08);
  });

  it("uses an initial guess for very large motion", () => {
    const r = run(45.2, -31.7, { guess: true });
    expect(r.good / r.n).toBeGreaterThan(0.8);
    expect(r.median).toBeLessThan(0.08);
  });

  it("is robust to brightness changes (mean compensation)", () => {
    const r = run(3.3, 2.1, { gain: 1.0, bias: 25 });
    expect(r.good / r.n).toBeGreaterThan(0.9);
    expect(r.median).toBeLessThan(0.08);
    const g = run(3.3, 2.1, { gain: 1.2, bias: -10 });
    expect(g.median).toBeLessThan(0.15);
  });

  it("forward–backward round trip returns to the start", () => {
    const r = run(6.5, -4.25);
    const n = r.n;
    const bx = new Float64Array(n);
    const by = new Float64Array(n);
    const st = r.st.slice();
    new PyrLK().track(r.p1, r.p0, n, r.ox, r.oy, r.c.x, r.c.y, bx, by, st, null, DEFAULT_LK);
    let bad = 0;
    for (let i = 0; i < n; i++) if (st[i] && Math.hypot(bx[i] - r.c.x[i], by[i] - r.c.y[i]) > 0.1) bad++;
    expect(bad).toBeLessThan(n * 0.1);
  });

  it("rejects untextured windows and points leaving the image", () => {
    const flat = makeFlat(W, H, 1, 0.5);
    const p = new Pyramid();
    p.build(flat, 4);
    const x = new Float64Array([160, 2, 318]);
    const y = new Float64Array([120, 120, 120]);
    const st = new Uint8Array(3).fill(1);
    const o = new Float64Array(3);
    new PyrLK().track(p, p, 3, x, y, x, y, o, new Float64Array(3), st, null, DEFAULT_LK);
    expect(Array.from(st)).toEqual([0, 0, 0]);
    // status 0으로 들어온 점은 건드리지 않는다
    const st2 = new Uint8Array([0]);
    expect(new PyrLK().track(p, p, 1, x, y, x, y, o, o, st2, null, DEFAULT_LK)).toBe(0);
  });
});
