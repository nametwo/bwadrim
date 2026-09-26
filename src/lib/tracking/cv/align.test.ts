import { describe, expect, it } from "vitest";
import type { Mat3, Rect } from "../types";
import { applyH, invert3, mul3 } from "../geometry";
import { Aligner, DEFAULT_ALIGN, buildAlignTemplate } from "./align";
import { homographyFromQuads, maxCornerDistance } from "./homography";
import { Pyramid } from "./image";
import { Rng } from "./rng";
import { camHomography, makeTexture, renderView } from "./testing/synth";

const world = makeTexture(700, 500, 41);
const W = 320;
const H = 240;
const V0 = camHomography({ cx: 350, cy: 250, tx: -190, ty: -130, scale: 0.7 });
const roi: Rect = { x: 100, y: 60, width: 120, height: 110 };

function setup(V1: Mat3, opts: { gain?: number; bias?: number; occlude?: boolean } = {}) {
  const ref = renderView(world, V0, W, H, { noise: 1, rng: new Rng(1) });
  const cur = renderView(world, V1, W, H, { noise: 1.5, rng: new Rng(2), gain: opts.gain, bias: opts.bias });
  if (opts.occlude) {
    // 손가락처럼 ROI의 일부를 평평한 덩어리로 가린다
    for (let y = 60; y < 240; y++) for (let x = 190; x < 240; x++) cur.data[y * W + x] = 200;
  }
  const rp = new Pyramid();
  const cp = new Pyramid();
  rp.build(ref, 4);
  cp.build(cur, 4);
  const Htrue = mul3(V1, invert3(V0)!);
  return { rp, cp, Htrue };
}

/** 참값에서 네 꼭짓점을 ±amp px 흔든 초기값 */
function perturbed(Htrue: Mat3, amp: number, seed: number): Mat3 {
  const rng = new Rng(seed);
  const src = [
    { x: roi.x, y: roi.y },
    { x: roi.x + roi.width, y: roi.y },
    { x: roi.x + roi.width, y: roi.y + roi.height },
    { x: roi.x, y: roi.y + roi.height },
  ];
  const dst = src.map((p) => {
    const w = Htrue[6] * p.x + Htrue[7] * p.y + Htrue[8];
    return {
      x: (Htrue[0] * p.x + Htrue[1] * p.y + Htrue[2]) / w + rng.range(-amp, amp),
      y: (Htrue[3] * p.x + Htrue[4] * p.y + Htrue[5]) / w + rng.range(-amp, amp),
    };
  });
  return homographyFromQuads(src, dst)!;
}

/** ROI 중심(핀 위치)에서의 오차 */
function centerErr(A: Mat3, B: Mat3): number {
  const c = { x: roi.x + roi.width / 2, y: roi.y + roi.height / 2 };
  const pa = applyH(A, c)!;
  const pb = applyH(B, c)!;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** ROI 왼쪽 절반(가리지 않은 쪽)의 최대 오차 */
function leftHalfErr(A: Mat3, B: Mat3): number {
  return maxCornerDistance(A, B, { x: roi.x, y: roi.y, width: roi.width / 2, height: roi.height });
}

function alignCoarseToFine(rp: Pyramid, cp: Pyramid, H0: Mat3, levels: number[]) {
  const al = new Aligner();
  let H = H0;
  let ncc = 0;
  for (const l of levels) {
    const tpl = buildAlignTemplate(rp.levels[l], l, roi, 600);
    const r = al.align(tpl, cp.levels[l], l, H, DEFAULT_ALIGN);
    expect(r.ok).toBe(true);
    H = r.H;
    ncc = r.ncc;
  }
  return { H, ncc };
}

describe("direct template alignment (inverse compositional)", () => {
  it("template picks high-gradient samples inside the ROI", () => {
    const { rp } = setup(V0);
    const t = buildAlignTemplate(rp.levels[0], 0, roi, 400);
    expect(t.n).toBe(400);
    for (let k = 0; k < t.n; k++) {
      expect(Math.abs(t.u[k])).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(t.v[k])).toBeLessThanOrEqual(1.0001);
    }
  });

  it("refines a 3px-perturbed estimate to sub-0.1px under rotation+perspective", () => {
    const V1 = camHomography({ cx: 350, cy: 250, tx: -180, ty: -125, scale: 0.75, rot: 0.2, px: 0.0003, py: -0.0002 });
    const { rp, cp, Htrue } = setup(V1);
    const H0 = perturbed(Htrue, 3, 1);
    expect(maxCornerDistance(H0, Htrue, roi)).toBeGreaterThan(1.5);
    const { H, ncc } = alignCoarseToFine(rp, cp, H0, [1, 0]);
    // 원근 항은 작은 ROI에서 약하게 결정되므로 꼭짓점은 느슨하게, 핀(중심)은 엄격하게
    expect(centerErr(H, Htrue)).toBeLessThan(0.08);
    expect(maxCornerDistance(H, Htrue, roi)).toBeLessThan(0.3);
    expect(ncc).toBeGreaterThan(0.95);
  });

  it("handles gain/bias changes", () => {
    const V1 = camHomography({ cx: 350, cy: 250, tx: -186, ty: -128, scale: 0.7, rot: -0.1 });
    const { rp, cp, Htrue } = setup(V1, { gain: 0.7, bias: 40 });
    const { H } = alignCoarseToFine(rp, cp, perturbed(Htrue, 2.5, 2), [1, 0]);
    expect(centerErr(H, Htrue)).toBeLessThan(0.08);
    expect(maxCornerDistance(H, Htrue, roi)).toBeLessThan(0.3);
  });

  it("is robust to partial occlusion (Tukey IRLS + LM step control)", () => {
    const V1 = camHomography({ cx: 350, cy: 250, tx: -186, ty: -128, scale: 0.7, rot: 0.05 });
    const { rp, cp, Htrue } = setup(V1, { occlude: true });
    const H0 = perturbed(Htrue, 2, 3);
    const { H } = alignCoarseToFine(rp, cp, H0, [1, 0]);
    // 가려진 오른쪽은 관측이 없으니 보이는 쪽과 핀으로 판단
    expect(centerErr(H, Htrue)).toBeLessThan(0.2);
    expect(leftHalfErr(H, Htrue)).toBeLessThan(0.5);
    expect(leftHalfErr(H0, Htrue)).toBeGreaterThan(1);
  });

  it("scale-matched levels: current zoomed 2× uses current level 1", () => {
    const V1 = camHomography({ cx: 350, cy: 250, tx: -190, ty: -130, scale: 1.4 });
    const { rp, cp, Htrue } = setup(V1);
    const al = new Aligner();
    const tpl = buildAlignTemplate(rp.levels[0], 0, roi, 600);
    const r = al.align(tpl, cp.levels[1], 1, perturbed(Htrue, 2, 4), DEFAULT_ALIGN);
    expect(r.ok).toBe(true);
    expect(centerErr(r.H, Htrue)).toBeLessThan(0.1);
    // 2배 확대라 현재 프레임 px 오차도 2배로 보인다 (ref px로는 절반)
    expect(maxCornerDistance(r.H, Htrue, roi)).toBeLessThan(1);
  });

  it("reports failure when the template is not visible", () => {
    const { rp, cp } = setup(V0);
    const tpl = buildAlignTemplate(rp.levels[0], 0, roi, 400);
    const away: Mat3 = [1, 0, 1000, 0, 1, 0, 0, 0, 1];
    expect(new Aligner().align(tpl, cp.levels[0], 0, away, DEFAULT_ALIGN).ok).toBe(false);
  });
});
