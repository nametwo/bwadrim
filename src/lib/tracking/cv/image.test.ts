import { describe, expect, it } from "vitest";
import { Pyramid, blur7, createImage, pyrDown, resizeBilinear, sampleSafe, warpPerspective } from "./image";
import type { GrayImage } from "../types";

function ramp(w: number, h: number, fx: (x: number, y: number) => number): GrayImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data[y * w + x] = fx(x, y);
  return img;
}

describe("image", () => {
  it("pyrDown keeps constants and follows the dst(i) ↔ src(2i) convention", () => {
    const c = ramp(40, 30, () => 77);
    const d = createImage(20, 15);
    pyrDown(c, d);
    expect(Array.from(d.data).every((v) => v === 77)).toBe(true);

    const r = ramp(64, 32, (x) => x * 2);
    const rd = createImage(32, 16);
    pyrDown(r, rd);
    // 내부: 선형 램프는 가우시안에 불변 → dst(i) = src(2i) = 4i
    for (let i = 2; i < 30; i++) expect(rd.data[5 * 32 + i]).toBe(4 * i);
  });

  it("pyrDown handles odd sizes", () => {
    const r = ramp(33, 21, (x, y) => (x * 3 + y * 5) & 255);
    const d = createImage(16, 10);
    expect(() => pyrDown(r, d)).not.toThrow();
    expect(() => pyrDown(r, createImage(17, 10))).toThrow();
  });

  it("blur7 preserves constants and linear ramps (interior)", () => {
    const r = ramp(30, 20, (x) => 10 + x * 3);
    const d = createImage(30, 20);
    blur7(r, d);
    for (let y = 0; y < 20; y++) for (let x = 3; x < 27; x++) expect(d.data[y * 30 + x]).toBe(10 + x * 3);
  });

  it("resizeBilinear maps dst x to src x·(sw/dw)", () => {
    const r = ramp(200, 10, (x) => x);
    const d = createImage(141, 7);
    resizeBilinear(r, d);
    for (let x = 0; x < 141; x++) expect(Math.abs(d.data[3 * 141 + x] - (x * 200) / 141)).toBeLessThanOrEqual(0.6);
  });

  it("warpPerspective: identity copies, translation shifts", () => {
    const r = ramp(50, 40, (x, y) => (x * 7 + y * 13) & 255);
    const d = createImage(50, 40);
    warpPerspective(r, [1, 0, 0, 0, 1, 0, 0, 0, 1], d);
    expect(Array.from(d.data)).toEqual(Array.from(r.data));
    warpPerspective(r, [1, 0, 3, 0, 1, 2, 0, 0, 1], d, 9);
    expect(d.data[10 * 50 + 10]).toBe(r.data[8 * 50 + 7]);
    expect(d.data[0]).toBe(9);
  });

  it("Pyramid builds halving levels and copies level 0", () => {
    const src = ramp(320, 240, (x, y) => (x + y) & 255);
    const p = new Pyramid();
    p.build(src, 4);
    expect(p.length).toBe(4);
    expect(p.levels.slice(0, 4).map((l) => [l.width, l.height])).toEqual([
      [320, 240],
      [160, 120],
      [80, 60],
      [40, 30],
    ]);
    src.data[0] = 99;
    expect(p.levels[0].data[0]).toBe(0);
    // 작은 영상은 가능한 단계까지만
    p.build(ramp(40, 30, () => 1), 6);
    expect(p.length).toBe(2);
  });

  it("sampleSafe returns NaN outside and interpolates inside", () => {
    const r = ramp(20, 20, (x) => x * 10);
    expect(sampleSafe(r, 2.5, 3)).toBeCloseTo(25, 6);
    expect(sampleSafe(r, 19, 19)).toBeCloseTo(190, 3);
    expect(Number.isNaN(sampleSafe(r, -0.1, 3))).toBe(true);
    expect(Number.isNaN(sampleSafe(r, 3, 19.5))).toBe(true);
  });
});
