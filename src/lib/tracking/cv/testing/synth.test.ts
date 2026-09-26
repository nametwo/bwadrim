import { describe, expect, it } from "vitest";
import { applyH } from "../../geometry";
import {
  backProject,
  distortPoint,
  intrinsics,
  orbitPose,
  planeToImage,
  projectWorld,
  renderCamera,
  undistortPoint,
  unsharpMask,
  type ReliefScene,
} from "./synth";

// 합성 3D 카메라 도구 자체 검증 (강건성 테스트의 정답이 맞아야 의미가 있다)

describe("synth 3D camera", () => {
  const K = intrinsics(320, 240, 65);

  it("orbitPose looks at the target: target projects to the principal point", () => {
    for (const [yaw, pitch, roll] of [
      [0, 0, 0],
      [0.4, -0.3, 0.2],
      [-0.5, 0.2, -1.2],
    ]) {
      const P = orbitPose({ x: 400, y: 300 }, 500, yaw, pitch, roll);
      const p = projectWorld(K, P, { x: 400, y: 300 })!;
      expect(p.x).toBeCloseTo(K.cx, 6);
      expect(p.y).toBeCloseTo(K.cy, 6);
      // 정면이면 배율 f/dist
      if (yaw === 0 && pitch === 0 && roll === 0) {
        const q = projectWorld(K, P, { x: 410, y: 300 })!;
        expect(q.x - p.x).toBeCloseTo((10 * K.f) / 500, 6);
      }
    }
  });

  it("planeToImage / backProject round-trip, raised plane shows parallax", () => {
    const P = orbitPose({ x: 400, y: 300 }, 500, 0.35, 0.1, 0.05);
    const w = { x: 430, y: 280 };
    const img = applyH(planeToImage(K, P, 0), w)!;
    const back = backProject(K, P, img, 0)!;
    expect(back.x).toBeCloseTo(w.x, 6);
    expect(back.y).toBeCloseTo(w.y, 6);
    // 카메라 쪽으로 20 튀어나온 점은 비스듬히 볼 때 옆으로 밀려 보인다
    const top = projectWorld(K, P, { ...w, z: -20 })!;
    expect(Math.hypot(top.x - img.x, top.y - img.y)).toBeGreaterThan(3);
  });

  it("distortion round-trips and bends toward the centre for k1 < 0", () => {
    for (const k1 of [-0.15, 0.1]) {
      for (const p of [
        { x: 0, y: 0 },
        { x: 300, y: 20 },
        { x: 160, y: 120 },
      ]) {
        const d = distortPoint(K, k1, p);
        const u = undistortPoint(K, k1, d);
        expect(u.x).toBeCloseTo(p.x, 6);
        expect(u.y).toBeCloseTo(p.y, 6);
      }
    }
    const corner = distortPoint(K, -0.15, { x: 0, y: 0 });
    expect(corner.x).toBeGreaterThan(10); // 모서리가 안쪽으로 15%
  });

  it("renderCamera puts a world dot where projectWorld says (distortion + relief)", () => {
    const base = { width: 800, height: 600, data: new Uint8Array(800 * 600).fill(40) };
    const top = { width: 800, height: 600, data: new Uint8Array(800 * 600).fill(40) };
    // 바닥 (300, 250)과 키 윗면 (452, 310)에 밝은 점
    const dot = (img: typeof base, cx: number, cy: number) => {
      for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) img.data[y * 800 + x] = 240;
    };
    dot(base, 300, 250);
    dot(top, 452, 310);
    const S: ReliefScene = { base, top, keys: [{ x: 420, y: 280, width: 70, height: 60 }], height: 24, wall: 40 };
    const P = orbitPose({ x: 400, y: 300 }, 450, 0.3, -0.2, 0.1);
    for (const k1 of [0, -0.15]) {
      const img = renderCamera(S, K, [P], { supersample: 3, k1 });
      for (const w of [
        { x: 300, y: 250, z: 0 },
        { x: 452, y: 310, z: -24 },
      ]) {
        const p = projectWorld(K, P, w, k1)!;
        // 점 주변 밝기 무게중심
        let sx = 0;
        let sy = 0;
        let s = 0;
        for (let y = Math.round(p.y) - 6; y <= Math.round(p.y) + 6; y++) {
          for (let x = Math.round(p.x) - 6; x <= Math.round(p.x) + 6; x++) {
            const v = Math.max(0, img.data[y * 320 + x] - 40);
            sx += v * x;
            sy += v * y;
            s += v;
          }
        }
        expect(s).toBeGreaterThan(0);
        expect(Math.hypot(sx / s - p.x, sy / s - p.y)).toBeLessThan(0.3);
      }
    }
  });

  it("unsharpMask creates overshoot halos at edges", () => {
    const img = { width: 32, height: 8, data: new Uint8Array(32 * 8) };
    for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) img.data[y * 32 + x] = x < 16 ? 80 : 160;
    const s = unsharpMask(img, 1, 1.2);
    expect(s.data[4 * 32 + 14]).toBeLessThan(80);
    expect(s.data[4 * 32 + 17]).toBeGreaterThan(160);
  });
});
