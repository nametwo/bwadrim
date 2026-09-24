import { describe, expect, it } from "vitest";
import {
  PIN_MAX_CSS_RADIUS,
  PIN_MIN_CSS_RADIUS,
  canvasBackingSize,
  computeDisplayMapping,
  cssToFrame,
  frameToCss,
  insideFrame,
  mappingForVideo,
  normToCssMatrix,
  renderAnnotations,
  stateOpacity,
  toFramePx,
  type DisplayMapping,
  type OverlayContext,
} from "./overlay";
import { applyH } from "./geometry";
import type { Annotation, Mat3 } from "./types";

const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const frame = { width: 320, height: 240 };

describe("computeDisplayMapping", () => {
  it("contain letterboxes (pillarbox) and centres", () => {
    // 4:3 영상, 390×844 세로 폰 요소 → 좌우 꽉, 위아래 여백
    const m = computeDisplayMapping(640, 480, 390, 844, "contain", 3)!;
    expect(m.width).toBeCloseTo(390, 9);
    expect(m.height).toBeCloseTo(292.5, 9);
    expect(m.x).toBeCloseTo(0, 9);
    expect(m.y).toBeCloseTo((844 - 292.5) / 2, 9);
    expect(m.devicePixelRatio).toBe(3);
  });

  it("cover crops and centres", () => {
    const m = computeDisplayMapping(640, 480, 390, 844, "cover")!;
    expect(m.height).toBeCloseTo(844, 9);
    expect(m.width).toBeCloseTo((640 * 844) / 480, 9);
    expect(m.x).toBeCloseTo((390 - m.width) / 2, 9);
    expect(m.x).toBeLessThan(0);
    expect(m.y).toBeCloseTo(0, 9);
  });

  it("fill stretches", () => {
    const m = computeDisplayMapping(640, 480, 100, 300, "fill")!;
    expect([m.x, m.y, m.width, m.height]).toEqual([0, 0, 100, 300]);
  });

  it("null for unknown sizes; sanitises dpr", () => {
    expect(computeDisplayMapping(0, 480, 100, 100)).toBeNull();
    expect(computeDisplayMapping(640, 480, 0, 100)).toBeNull();
    expect(computeDisplayMapping(640, 480, 100, 100, "contain", Number.NaN)!.devicePixelRatio).toBe(1);
  });
});

describe("frame ↔ css", () => {
  const m = computeDisplayMapping(640, 480, 390, 844, "contain", 2)!;

  it("image corners map to the displayed rect corners (pixel-centre convention)", () => {
    const tl = frameToCss(m, { x: -0.5, y: -0.5 }, frame);
    const br = frameToCss(m, { x: 319.5, y: 239.5 }, frame);
    expect(tl.x).toBeCloseTo(m.x, 9);
    expect(tl.y).toBeCloseTo(m.y, 9);
    expect(br.x).toBeCloseTo(m.x + m.width, 9);
    expect(br.y).toBeCloseTo(m.y + m.height, 9);
    const c = frameToCss(m, { x: 159.5, y: 119.5 }, frame);
    expect(c.x).toBeCloseTo(195, 9);
    expect(c.y).toBeCloseTo(422, 9);
  });

  it("round-trips for cover and contain", () => {
    for (const fit of ["cover", "contain"] as const) {
      const mm = computeDisplayMapping(480, 640, 1024, 700, fit)!;
      const f = { width: 240, height: 320 };
      for (const p of [
        { x: 0, y: 0 },
        { x: 17.25, y: 300.5 },
        { x: -3, y: 400 },
      ]) {
        const back = cssToFrame(mm, frameToCss(mm, p, f), f);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    }
  });

  it("toFramePx subtracts the element rect", () => {
    const p = toFramePx(m, { clientX: 10 + 195, clientY: 50 + 422 }, { left: 10, top: 50 }, frame);
    expect(p.x).toBeCloseTo(159.5, 9);
    expect(p.y).toBeCloseTo(119.5, 9);
  });

  it("letterbox taps are outside the frame", () => {
    const p = cssToFrame(m, { x: 195, y: 10 }, frame);
    expect(insideFrame(p, frame)).toBe(false);
    expect(insideFrame({ x: 0, y: 0 }, frame)).toBe(true);
    expect(insideFrame({ x: 319.5, y: 239.5 }, frame)).toBe(true);
    expect(insideFrame({ x: 321, y: 0 }, frame)).toBe(false);
    expect(insideFrame({ x: 321, y: 0 }, frame, 2)).toBe(true);
  });

  it("working frame of slightly different aspect still spans the displayed rect", () => {
    // 426×240 영상 → 작업 320×180 (비율 0.15% 차이)
    const mm = computeDisplayMapping(426, 240, 852, 480, "contain")!;
    const f = { width: 320, height: 180 };
    const br = frameToCss(mm, { x: 319.5, y: 179.5 }, f);
    expect(br.x).toBeCloseTo(852, 9);
    expect(br.y).toBeCloseTo(480, 9);
  });

  it("backing size and mappingForVideo", () => {
    expect(canvasBackingSize(390, 844, 3)).toEqual({ width: 1170, height: 2532 });
    expect(canvasBackingSize(100.4, 50.6, 1)).toEqual({ width: 100, height: 51 });
    expect(canvasBackingSize(0, 0, 0)).toEqual({ width: 1, height: 1 });
    const mv = mappingForVideo({ videoWidth: 640, videoHeight: 480, clientWidth: 320, clientHeight: 240 }, "cover", 2);
    expect(mv).toMatchObject({ x: 0, y: 0, width: 320, height: 240, devicePixelRatio: 2 });
  });

  it("normToCssMatrix composes norm → ref → frame → css", () => {
    const H: Mat3 = [0.5, 0, 10, 0, 0.5, 20, 0, 0, 1];
    const ref = { width: 320, height: 240 };
    const G = normToCssMatrix(H, ref, frame, m);
    const n = { x: 0.25, y: 0.75 };
    const viaG = applyH(G, n)!;
    const viaSteps = frameToCss(m, applyH(H, { x: n.x * 320, y: n.y * 240 })!, frame);
    expect(viaG.x).toBeCloseTo(viaSteps.x, 9);
    expect(viaG.y).toBeCloseTo(viaSteps.y, 9);
  });

  it("stateOpacity", () => {
    expect(stateOpacity("tracking")).toBe(1);
    expect(stateOpacity("weak")).toBeCloseTo(0.45);
    expect(stateOpacity("lost")).toBe(0);
    expect(stateOpacity("searching")).toBe(0);
    expect(stateOpacity(null)).toBe(0);
  });
});

// ───────────────────────── 렌더링 (기록용 가짜 컨텍스트) ─────────────────────────

type Op = { op: string; args: number[]; style?: string; width?: number; alpha?: number };

function recorder() {
  const ops: Op[] = [];
  let path: { x: number; y: number; move: boolean }[] = [];
  const paths: { points: { x: number; y: number; move: boolean }[]; style: string; width: number; alpha: number }[] = [];
  const state = { globalAlpha: 1, strokeStyle: "", fillStyle: "", lineWidth: 1 };
  const stack: (typeof state)[] = [];
  const ctx = {
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    lineJoin: "miter",
    lineCap: "butt",
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => path.push({ x, y, move: true }),
    lineTo: (x: number, y: number) => path.push({ x, y, move: false }),
    closePath: () => {},
    arc: (x: number, y: number, r: number) => ops.push({ op: "arc", args: [x, y, r] }),
    stroke: () => paths.push({ points: [...path], style: state.strokeStyle, width: state.lineWidth, alpha: state.globalAlpha }),
    fill: () => ops.push({ op: "fill", args: [], style: state.fillStyle }),
  };
  return { ctx: ctx as unknown as OverlayContext, ops, paths };
}

/** 링 경로(32점)의 평균 반지름 */
function meanRadius(points: { x: number; y: number }[], cx: number, cy: number) {
  return points.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / points.length;
}

describe("renderAnnotations", () => {
  const ref = { width: 320, height: 240 };
  // 요소 = 프레임과 같은 크기(1 CSS px = 1 frame px)
  const m: DisplayMapping = computeDisplayMapping(320, 240, 320, 240, "fill")!;
  const pin: Annotation = { id: "p", kind: "pin", p: { x: 0.5, y: 0.5 } };

  it("pin: projected centre, perspective ring, white under red", () => {
    const r = recorder();
    renderAnnotations(r.ctx, [pin], I, ref, frame, m, { opacity: 1, timeMs: 0 });
    // 경로: 맥동 1 + 링 2(흰·빨강)
    const rings = r.paths.filter((p) => p.points.length === 32);
    expect(rings.length).toBe(3);
    const [pulse, white, red] = rings;
    expect(white.style).toBe("#FFFFFF");
    expect(white.width).toBe(7);
    expect(red.style).toBe("#FF3B30");
    expect(pulse.style).toBe("#FF3B30");
    // norm 0.5 → ref px 160 → css (160 + 0.5)·1 (픽셀 중심 규약)
    const cx = 160.5;
    const cy = 120.5;
    // 반지름 = 4% × 320 = 12.8 → 최소 14로 클램프
    expect(meanRadius(red.points, cx, cy)).toBeCloseTo(PIN_MIN_CSS_RADIUS, 0);
    const arcs = r.ops.filter((o) => o.op === "arc");
    expect(arcs[0].args[0]).toBeCloseTo(cx, 9);
    expect(arcs[0].args[1]).toBeCloseTo(cy, 9);
  });

  it("pin radius is clamped to 80 px when zoomed in, and scales in between", () => {
    const big = recorder();
    renderAnnotations(big.ctx, [pin], [10, 0, 0, 0, 10, 0, 0, 0, 1], ref, frame, m);
    const red = big.paths.filter((p) => p.points.length === 32)[2];
    const c = { x: 10 * 160 + 0.5, y: 10 * 120 + 0.5 };
    expect(meanRadius(red.points, c.x, c.y)).toBeCloseTo(PIN_MAX_CSS_RADIUS, 0);

    const mid = recorder();
    renderAnnotations(mid.ctx, [pin], [3, 0, 0, 0, 3, 0, 0, 0, 1], ref, frame, m);
    const red2 = mid.paths.filter((p) => p.points.length === 32)[2];
    expect(meanRadius(red2.points, 480.5, 360.5)).toBeCloseTo(3 * 12.8, 0);
  });

  it("pin ring is an ellipse under perspective (tilt)", () => {
    // y방향으로 기울어진 평면: 위쪽이 멀어짐
    const H: Mat3 = [3, 0, 0, 0, 3, 0, 0, 0.004, 1];
    const r = recorder();
    renderAnnotations(r.ctx, [pin], H, ref, frame, m);
    const red = r.paths.filter((p) => p.points.length === 32)[2];
    const xs = red.points.map((p) => p.x);
    const ys = red.points.map((p) => p.y);
    const wx = Math.max(...xs) - Math.min(...xs);
    const wy = Math.max(...ys) - Math.min(...ys);
    expect(Math.abs(wx - wy)).toBeGreaterThan(0.5);
  });

  it("pin behind the camera is not drawn (others still are)", () => {
    const r = recorder();
    // w = 2 − 0.01·x_ref: ref 중심(x=160)은 앞(w=0.4), x_ref=304는 뒤(w<0)
    const H: Mat3 = [1, 0, 0, 0, 1, 0, -0.01, 0, 2];
    renderAnnotations(r.ctx, [{ id: "q", kind: "pin", p: { x: 0.95, y: 0.5 } }], H, ref, frame, m);
    expect(r.paths.length + r.ops.length).toBe(0);
    renderAnnotations(r.ctx, [{ id: "q", kind: "pin", p: { x: 0.3, y: 0.5 } }], H, ref, frame, m);
    expect(r.paths.length).toBeGreaterThan(0);
  });

  it("stroke: white 10px under red 6px, round joins", () => {
    const s: Annotation = {
      id: "s",
      kind: "stroke",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.2 },
        { x: 0.9, y: 0.1 },
      ],
    };
    const r = recorder();
    renderAnnotations(r.ctx, [s], I, ref, frame, m);
    expect(r.paths.map((p) => [p.style, p.width])).toEqual([
      ["#FFFFFF", 10],
      ["#FF3B30", 6],
    ]);
    const pts = r.paths[0].points;
    expect(pts.length).toBe(3);
    expect(pts[0]).toMatchObject({ x: 32.5, y: 24.5, move: true });
    expect(pts[2]).toMatchObject({ x: 288.5, y: 24.5, move: false });
    expect(r.ctx.lineJoin).toBe("round");
  });

  it("stroke crossing behind the camera is clipped, not wrapped around", () => {
    // w = 1 - 1.5·x_norm·... : x가 커지면 카메라 뒤로
    const H: Mat3 = [1, 0, 0, 0, 1, 0, -0.004, 0, 1];
    const s: Annotation = {
      id: "s",
      kind: "stroke",
      points: [
        { x: 0.1, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.95, y: 0.5 }, // w = 1 - 0.004·304 < 0 → 뒤
        { x: 0.3, y: 0.6 }, // 다시 앞
        { x: 0.2, y: 0.6 },
      ],
    };
    const r = recorder();
    renderAnnotations(r.ctx, [s], H, ref, frame, m);
    const pts = r.paths[0].points;
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThan(1e5);
    }
    // 뒤로 간 점 앞뒤로 경로가 끊겨 두 조각
    expect(pts.filter((p) => p.move).length).toBe(2);
    // 잘린 점들은 원래 방향(오른쪽 = 멀리)으로 뻗는다
    expect(Math.max(...pts.map((p) => p.x))).toBeGreaterThan(300);
  });

  it("nothing drawn when H is null, opacity 0, or no annotations; opacity applied", () => {
    for (const [H, op] of [
      [null, 1],
      [I, 0],
    ] as const) {
      const r = recorder();
      renderAnnotations(r.ctx, [pin], H, ref, frame, m, { opacity: op });
      expect(r.paths.length).toBe(0);
    }
    const e = recorder();
    renderAnnotations(e.ctx, [], I, ref, frame, m);
    expect(e.paths.length).toBe(0);
    const w = recorder();
    renderAnnotations(w.ctx, [pin], I, ref, frame, m, { opacity: 0.45 });
    const red = w.paths.filter((p) => p.points.length === 32)[2];
    expect(red.alpha).toBeCloseTo(0.45, 9);
    expect(w.ctx.globalAlpha).toBe(1); // restore
  });

  it("maps through a different frame size than the ref (e.g. rotation)", () => {
    const f2 = { width: 160, height: 120 };
    const r = recorder();
    renderAnnotations(r.ctx, [pin], [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1], ref, f2, m);
    const arcs = r.ops.filter((o) => o.op === "arc");
    // frame 픽셀 (80,60) → css: (80+0.5)·2 = 161
    expect(arcs[0].args[0]).toBeCloseTo(161, 9);
    expect(arcs[0].args[1]).toBeCloseTo(121, 9);
  });
});
