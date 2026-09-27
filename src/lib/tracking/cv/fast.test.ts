import { describe, expect, it } from "vitest";
import { CornerList, detectFast, gridFilter, minDistanceFilter, scoreCorners, sortByScore } from "./fast";
import { createImage } from "./image";
import { makeFlat, makeTexture } from "./testing/synth";

function squareImage(): ReturnType<typeof createImage> {
  const img = createImage(64, 64);
  img.data.fill(30);
  for (let y = 20; y < 44; y++) for (let x = 16; x < 40; x++) img.data[y * 64 + x] = 220;
  return img;
}

describe("FAST-9", () => {
  it("finds exactly the four corners of a bright square", () => {
    const img = squareImage();
    const out = new CornerList(16);
    const n = detectFast(img, 20, 3, out);
    expect(n).toBe(4);
    const pts = Array.from({ length: n }, (_, i) => [out.x[i], out.y[i]]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const expected = [
      [16, 20],
      [39, 20],
      [16, 43],
      [39, 43],
    ];
    pts.forEach((p, i) => {
      expect(Math.abs(p[0] - expected[i][0])).toBeLessThanOrEqual(1);
      expect(Math.abs(p[1] - expected[i][1])).toBeLessThanOrEqual(1);
    });
  });

  it("without NMS returns more candidates; region restricts", () => {
    const img = squareImage();
    const out = new CornerList(4);
    const nAll = detectFast(img, 20, 3, out, null, false);
    expect(nAll).toBeGreaterThan(4);
    const n = detectFast(img, 20, 3, out, { x0: 0, y0: 0, x1: 30, y1: 30 });
    expect(n).toBe(1);
    expect(out.x[0]).toBeLessThan(30);
  });

  it("finds nothing on flat noisy images", () => {
    const img = makeFlat(160, 120, 3, 1.5);
    const out = new CornerList();
    expect(detectFast(img, 12, 3, out)).toBe(0);
  });

  it("is deterministic and stable across calls (score map reset)", () => {
    const img = makeTexture(160, 120, 5);
    const a = new CornerList();
    const b = new CornerList();
    detectFast(img, 15, 8, a);
    detectFast(img, 30, 8, b); // 다른 임계값으로 한 번 끼워 넣기
    detectFast(img, 15, 8, b);
    expect(b.n).toBe(a.n);
    expect(Array.from(b.x.subarray(0, b.n))).toEqual(Array.from(a.x.subarray(0, a.n)));
    expect(Array.from(b.score.subarray(0, b.n))).toEqual(Array.from(a.score.subarray(0, a.n)));
  });

  it("Harris/min-eig scores: corners > edges > flat", () => {
    const img = squareImage();
    const l = new CornerList();
    l.push(16, 20, 0); // 코너
    l.push(28, 20, 0); // 가장자리
    l.push(28, 32, 0); // 평평
    scoreCorners(img, l, "mineig", 3);
    expect(l.score[0]).toBeGreaterThan(10 * Math.max(1e-6, l.score[1]));
    expect(l.score[1]).toBeLessThan(1e-6);
    expect(l.score[2]).toBe(0);
    scoreCorners(img, l, "harris", 3);
    expect(l.score[0]).toBeGreaterThan(0);
    expect(l.score[1]).toBeLessThan(0);
  });

  it("sortByScore orders descending with index tiebreak (non-positive last)", () => {
    const l = new CornerList();
    [3, 9, 9, 1, -2, 0, 5].forEach((s, i) => l.push(i, i, s));
    expect(Array.from(sortByScore(l))).toEqual([1, 2, 6, 0, 3, 4, 5]);
  });

  it("gridFilter caps per cell and total", () => {
    const l = new CornerList();
    for (let i = 0; i < 50; i++) l.push(i % 10, 0, 100 - i); // 모두 첫 셀(0..9)
    for (let i = 0; i < 5; i++) l.push(40 + i, 0, 1); // 다른 셀
    const out = new CornerList();
    const n = gridFilter(l, out, { x0: 0, y0: 0, x1: 64, y1: 16 }, 16, 3, 100);
    expect(n).toBe(6);
    expect(Array.from(out.score.subarray(0, 3))).toEqual([100, 99, 98]);
    expect(gridFilter(l, out, { x0: 0, y0: 0, x1: 64, y1: 16 }, 16, 3, 2)).toBe(2);
  });

  it("minDistanceFilter enforces spacing and keeps strongest", () => {
    const l = new CornerList();
    l.push(10, 10, 5);
    l.push(12, 10, 9); // 더 강함 → 남고 (10,10)은 탈락
    l.push(30, 10, 1);
    l.push(30, 14, 2);
    const out = new CornerList();
    const n = minDistanceFilter(l, out, 64, 64, 5, 10);
    expect(n).toBe(2);
    expect([out.x[0], out.y[0]]).toEqual([12, 10]);
    expect([out.x[1], out.y[1]]).toEqual([30, 14]);
  });
});
