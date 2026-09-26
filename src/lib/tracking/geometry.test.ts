import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  applyH,
  invert3,
  isConvex,
  localScale,
  mul3,
  pointInPolygon,
  warpRect,
} from "./geometry";

describe("geometry", () => {
  const H = [1.2, 0.1, 5, -0.05, 0.9, 3, 0.0005, -0.0003, 1];

  it("invert3 * m = I", () => {
    const inv = invert3(H)!;
    const I = mul3(H, inv);
    I.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY[i], 10));
  });

  it("applyH round-trips through inverse", () => {
    const p = { x: 37, y: 81 };
    const q = applyH(H, p)!;
    const back = applyH(invert3(H)!, q)!;
    expect(back.x).toBeCloseTo(p.x, 8);
    expect(back.y).toBeCloseTo(p.y, 8);
  });

  it("applyH returns null behind the camera", () => {
    expect(applyH([1, 0, 0, 0, 1, 0, 0, 0, -1], { x: 1, y: 1 })).toBeNull();
  });

  it("warped rect stays convex under mild perspective", () => {
    const quad = warpRect(H, { x: 0, y: 0, width: 100, height: 80 })!;
    expect(isConvex(quad)).toBe(true);
    expect(pointInPolygon(applyH(H, { x: 50, y: 40 })!, quad)).toBe(true);
    expect(pointInPolygon({ x: -500, y: -500 }, quad)).toBe(false);
  });

  it("localScale of pure scaling", () => {
    expect(localScale([2, 0, 0, 0, 2, 0, 0, 0, 1], { x: 10, y: 10 })).toBeCloseTo(2, 8);
  });
});
