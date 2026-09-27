import { describe, expect, it } from "vitest";
import type { Mat3, Rect } from "../types";
import { invert3, mul3 } from "../geometry";
import { Pyramid } from "./image";
import { VerifyModel, emptyVerify } from "./ncc";
import { Rng } from "./rng";
import { camHomography, makePortRow, makeTexture, renderView } from "./testing/synth";

const W = 320;
const H = 240;
const crit = { ncc: 0.5, fracGood: 0.7, blockGood: 0.5, minBlock: 0.15 };

function pyr(img: ReturnType<typeof renderView>) {
  const p = new Pyramid();
  p.build(img, 4);
  return p;
}

describe("photometric verification (block NCC)", () => {
  const world = makeTexture(700, 500, 51);
  const V0 = camHomography({ cx: 350, cy: 250, tx: -190, ty: -130, scale: 0.7 });
  const roi: Rect = { x: 100, y: 60, width: 120, height: 110 };
  const ref = pyr(renderView(world, V0, W, H, { noise: 1, rng: new Rng(1) }));
  const model = VerifyModel.build(ref, roi);

  it("passes the true homography even with lighting change and scale", () => {
    const V1 = camHomography({ cx: 350, cy: 250, tx: -170, ty: -120, scale: 0.9, rot: 0.3, px: 0.0003 });
    const cur = pyr(renderView(world, V1, W, H, { noise: 2, rng: new Rng(2), gain: 0.6, bias: 50 }));
    const v = model.evaluate(cur, mul3(V1, invert3(V0)!), 0.5, emptyVerify());
    expect(v.ncc).toBeGreaterThan(0.9);
    expect(v.fracGood).toBe(1);
    expect(v.blocksVisible).toBe(v.blocksTextured);
    expect(v.visibleFrac).toBe(1);
  });

  it("fails an 8px-off homography and a wrong place", () => {
    const cur = pyr(renderView(world, V0, W, H, { noise: 2, rng: new Rng(3) }));
    const off = model.evaluate(cur, [1, 0, 8, 0, 1, 0, 0, 0, 1], 0.5, emptyVerify());
    expect(off.fracGood).toBeLessThan(0.7);
    const far = model.evaluate(cur, [1, 0, -90, 0, 1, 40, 0, 0, 1], 0.5, emptyVerify());
    expect(far.ncc).toBeLessThan(0.3);
  });

  it("counts only visible blocks when the ROI leaves the frame", () => {
    const cur = pyr(renderView(world, V0, W, H, { noise: 1, rng: new Rng(4) }));
    const T: Mat3 = [1, 0, 160, 0, 1, 0, 0, 0, 1]; // ROI 오른쪽 절반이 프레임 밖
    const v = model.evaluate(cur, T, 0.5, emptyVerify());
    expect(v.visibleFrac).toBeLessThan(0.7);
    expect(v.blocksVisible).toBeLessThan(v.blocksTextured);
  });

  it("repeat scan: textured ROI is distinctive", () => {
    expect(model.scanRepeats(ref, 8, crit).ambiguous).toBe(false);
  });

  it("repeat scan: a single port in a row of identical ports is ambiguous; adding a label fixes it", () => {
    const rowNoLabel = makePortRow(W, H, { period: 40, count: 7, uniqueLabel: false, seed: 1 });
    const p1 = pyr(rowNoLabel);
    const portRoi: Rect = { x: 136, y: 76, width: 48, height: 48 };
    const m1 = VerifyModel.build(p1, portRoi);
    const s1 = m1.scanRepeats(p1, 8, crit);
    expect(s1.ambiguous).toBe(true);
    expect(Math.abs(Math.abs(s1.shiftX) - 40)).toBeLessThanOrEqual(4);

    const rowLabel = makePortRow(W, H, { period: 40, count: 7, uniqueLabel: true, seed: 1 });
    const p2 = pyr(rowLabel);
    // 라벨까지 덮는 ROI
    const labelRoi: Rect = { x: 120, y: 70, width: 80, height: 90 };
    const m2 = VerifyModel.build(p2, labelRoi);
    expect(m2.scanRepeats(p2, 8, crit).ambiguous).toBe(false);
  });
});
