import { describe, expect, it } from "vitest";
import {
  ARM_R,
  DISARM_R,
  HOLE_R,
  RING_D,
  RING_R,
  ZOOM_DEAD,
  ZOOM_HYST,
  glyphTransform,
  ringAccepts,
  ringCmdAt,
  sectorOf,
  wedgePath,
  zoomCmdAt,
} from "./guide-pad-geometry";

const polar = (deg: number, r: number) => ({
  x: r * Math.cos((deg * Math.PI) / 180),
  y: r * Math.sin((deg * Math.PI) / 180),
});

describe("링 조각 경로", () => {
  it("위쪽 조각은 좌우 대칭이고 위쪽(음의 y)에 있다", () => {
    const d = wedgePath(-90);
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // M i1 L o1 A ro ro 0 0 1 o2 L i2 A ri ri 0 0 0 i1
    const [i1x, i1y, o1x, o1y] = nums;
    const o2x = nums[9];
    const o2y = nums[10];
    expect(i1y).toBeLessThan(0);
    expect(o1y).toBeLessThan(0);
    expect(o2x).toBeCloseTo(-o1x, 1);
    expect(o2y).toBeCloseTo(o1y, 1);
    // 안쪽 점은 구멍 + 모서리 여유, 바깥 점은 링 − 모서리 여유 반지름에 있다
    expect(Math.hypot(i1x, i1y)).toBeCloseTo(HOLE_R + 3, 1);
    expect(Math.hypot(o1x, o1y)).toBeCloseTo(RING_R - 3, 1);
  });

  it("꺾쇠는 조각 가운데 반지름에 놓인다", () => {
    expect(glyphTransform(0)).toMatch(/^translate\(54 0\) rotate\(0\)/);
    expect(glyphTransform(-90)).toMatch(/^translate\(0 -54\) rotate\(-90\)/);
  });
});

describe("링 누른 자리 → 방향", () => {
  it("네 방향 조각 가운데는 그 방향", () => {
    expect(ringCmdAt(polar(0, 55), null)).toBe("right");
    expect(ringCmdAt(polar(90, 55), null)).toBe("down");
    expect(ringCmdAt(polar(180, 55), null)).toBe("left");
    expect(ringCmdAt(polar(-90, 55), null)).toBe("up");
  });

  it("가운데 구멍은 멈춤(null)이고, 켜진 뒤에는 더 안쪽까지 들어와야 꺼진다", () => {
    expect(ringCmdAt(polar(0, ARM_R - 1), null)).toBeNull();
    expect(ringCmdAt(polar(0, ARM_R + 1), null)).toBe("right");
    expect(ringCmdAt(polar(0, (ARM_R + DISARM_R) / 2), "right")).toBe("right");
    expect(ringCmdAt(polar(0, DISARM_R - 1), "right")).toBeNull();
  });

  it("대각선을 조금 넘어도 지금 방향을 유지하고, 더 가면 바뀐다", () => {
    expect(ringCmdAt(polar(50, 60), null)).toBe("down");
    expect(ringCmdAt(polar(50, 60), "right")).toBe("right");
    expect(ringCmdAt(polar(60, 60), "right")).toBe("down");
  });

  it("누른 채로 링 밖(알약 쪽)으로 넘쳐도 각도로 판정한다", () => {
    expect(ringCmdAt(polar(90, 120), "down")).toBe("down");
    expect(ringCmdAt({ x: 0, y: RING_R + 30 }, null)).toBe("down");
  });

  it("누르기 시작한 자리가 네모 상자의 빈 모서리면 받지 않는다", () => {
    expect(ringAccepts(polar(45, RING_R))).toBe(true);
    expect(ringAccepts({ x: RING_R, y: RING_R })).toBe(false);
  });

  it("sectorOf 경계", () => {
    expect(sectorOf(-45)).toBe("right");
    expect(sectorOf(45)).toBe("down");
    expect(sectorOf(135)).toBe("left");
    expect(sectorOf(225)).toBe("up");
  });
});

describe("알약 누른 자리 → 멀리·가까이", () => {
  const mid = RING_D / 2;
  it("왼쪽 반은 멀리, 오른쪽 반은 가까이", () => {
    expect(zoomCmdAt(20, null, true)).toBe("farther");
    expect(zoomCmdAt(RING_D - 20, null, true)).toBe("closer");
  });

  it("가운데 경계에서 누르기 시작하면 벗어날 때까지 아무것도 보내지 않는다", () => {
    expect(zoomCmdAt(mid - ZOOM_DEAD + 1, null, false)).toBeNull();
    expect(zoomCmdAt(mid + ZOOM_DEAD - 1, null, false)).toBeNull();
    expect(zoomCmdAt(mid - ZOOM_DEAD - 1, null, false)).toBe("farther");
  });

  it("누른 채 옆으로 밀면 떼지 않고 바뀌고, 경계 근처에서는 지금 쪽을 유지한다", () => {
    expect(zoomCmdAt(mid + ZOOM_HYST - 1, "farther", true)).toBe("farther");
    expect(zoomCmdAt(mid + ZOOM_HYST + 1, "farther", true)).toBe("closer");
    expect(zoomCmdAt(mid - ZOOM_HYST + 1, "closer", true)).toBe("closer");
    expect(zoomCmdAt(mid - ZOOM_HYST - 1, "closer", true)).toBe("farther");
  });
});
