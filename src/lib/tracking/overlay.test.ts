import { describe, expect, it } from "vitest";
import {
  ARROW_INSET_CSS,
  ARROW_LENGTH_CSS,
  GuideArrowState,
  PIN_MAX_CSS_RADIUS,
  annotationBounds,
  guideArrowBounds,
  PIN_MIN_CSS_RADIUS,
  annotationAnchorPx,
  computeGuideArrow,
  primaryAnchorPx,
  renderGuideArrow,
  visibleRect,
  type ArrowContext,
  type GuideArrow,
  type GuideUpdate,
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

// ───────────────────────── 화면 밖 안내 화살표 ─────────────────────────

describe("annotation anchor points", () => {
  it("pin = position, stroke = length-weighted centroid (uneven sampling does not bias it)", () => {
    expect(annotationAnchorPx({ id: "p", kind: "pin", p: { x: 0.25, y: 0.5 } }, 320, 240)).toEqual({ x: 80, y: 120 });
    // 가로 선: 왼쪽에 점이 몰려 있어도 중심은 선의 가운데
    const dense = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 1].map((x) => ({ x, y: 0.5 }));
    const c = annotationAnchorPx({ id: "s", kind: "stroke", points: dense }, 320, 240)!;
    expect(c.x).toBeCloseTo(160, 9);
    expect(c.y).toBeCloseTo(120, 9);
    // 길이 0 → 점 평균
    const z = annotationAnchorPx({ id: "z", kind: "stroke", points: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }] }, 320, 240);
    expect(z).toEqual({ x: 160, y: 120 });
  });

  it("primary = first annotation", () => {
    const anns: Annotation[] = [
      { id: "a", kind: "pin", p: { x: 0.1, y: 0.2 } },
      { id: "b", kind: "pin", p: { x: 0.9, y: 0.9 } },
    ];
    expect(primaryAnchorPx(anns, 100, 100)).toEqual({ x: 10, y: 20 });
    expect(primaryAnchorPx([], 100, 100)).toBeNull();
  });
});

describe("computeGuideArrow", () => {
  const ref = { width: 320, height: 240 };
  const fs = { width: 320, height: 240 };
  // 요소 = 프레임 크기 (1 CSS px = 1 frame px, contain)
  const mc = computeDisplayMapping(320, 240, 320, 240, "contain")!;
  const anchor = { x: 160, y: 120 };
  const T = (tx: number, ty: number): Mat3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];
  const upd = (over: Partial<GuideUpdate>): GuideUpdate => ({
    state: "tracking",
    H: I,
    hint: null,
    refSize: ref,
    frameSize: fs,
    ...over,
  });

  it("visible pin → no arrow; unknown pose → no arrow", () => {
    expect(computeGuideArrow(upd({}), anchor, mc)).toBeNull();
    expect(computeGuideArrow(upd({ state: "searching", H: null }), anchor, mc)).toBeNull();
    // lost인데 이유가 offscreen이 아니면 hint가 있어도 쓰지 않는다
    expect(computeGuideArrow(upd({ state: "lost", H: null, hint: T(400, 0), reason: "unverified" }), anchor, mc)).toBeNull();
    expect(computeGuideArrow(upd({ state: "lost", H: null, hint: null, reason: "offscreen" }), anchor, mc)).toBeNull();
  });

  it("hint to the right → arrow at the right inset edge pointing right", () => {
    const a = computeGuideArrow(upd({ state: "lost", H: null, hint: T(400, 0), reason: "offscreen" }), anchor, mc)!;
    expect(a.source).toBe("hint");
    expect(a.x).toBeCloseTo(320 - ARROW_INSET_CSS, 9);
    expect(a.y).toBeCloseTo(120.5, 9);
    expect(a.angle).toBeCloseTo(0, 9);
    expect(a.target!.x).toBeCloseTo(560.5, 9);
  });

  it("direction for each side and diagonals (clamped into the inset rectangle)", () => {
    const cases: [number, number, number][] = [
      [-400, 0, Math.PI],
      [0, -300, -Math.PI / 2],
      [0, 300, Math.PI / 2],
    ];
    for (const [tx, ty, ang] of cases) {
      const a = computeGuideArrow(upd({ state: "lost", H: null, hint: T(tx, ty), reason: "offscreen" }), anchor, mc)!;
      expect(Math.abs(Math.atan2(Math.sin(a.angle - ang), Math.cos(a.angle - ang)))).toBeLessThan(1e-9);
      expect(a.x).toBeGreaterThanOrEqual(ARROW_INSET_CSS - 1e-9);
      expect(a.x).toBeLessThanOrEqual(320 - ARROW_INSET_CSS + 1e-9);
      expect(a.y).toBeGreaterThanOrEqual(ARROW_INSET_CSS - 1e-9);
      expect(a.y).toBeLessThanOrEqual(240 - ARROW_INSET_CSS + 1e-9);
    }
    // 오른쪽 아래 멀리 → 오른쪽 아래 모서리, 목표를 향함
    const d = computeGuideArrow(upd({ state: "lost", H: null, hint: T(1000, 800), reason: "offscreen" }), anchor, mc)!;
    expect(d.x).toBeCloseTo(320 - ARROW_INSET_CSS, 9);
    expect(d.y).toBeCloseTo(240 - ARROW_INSET_CSS, 9);
    expect(d.angle).toBeCloseTo(Math.atan2(d.target!.y - d.y, d.target!.x - d.x), 9);
    expect(d.angle).toBeGreaterThan(0);
    expect(d.angle).toBeLessThan(Math.PI / 2);
  });

  it("cover crop: inside the frame but outside the element → arrow from H (source track), with hysteresis", () => {
    // 4:3 영상을 세로 폰 요소(390×844)에 cover → 영상 폭 1125.33, 좌우 367.67px씩 잘림
    const m = computeDisplayMapping(640, 480, 390, 844, "cover")!;
    expect(visibleRect(m)).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    // 핀을 frame x = 40으로 (프레임 안) → css x = m.x + 40.5·(1125.33/320) ≈ -225 → 안 보임
    const u = upd({ H: T(40 - 160, 0) });
    const a = computeGuideArrow(u, anchor, m)!;
    expect(a).not.toBeNull();
    expect(a.source).toBe("track");
    expect(a.x).toBeCloseTo(ARROW_INSET_CSS, 9);
    expect(a.angle).toBeCloseTo(Math.PI, 6);
    // 같은 자세도 contain이면 보인다 (프레임 전체가 화면에)
    expect(computeGuideArrow(u, anchor, computeDisplayMapping(640, 480, 390, 844, "contain")!)).toBeNull();
    // 가장자리 바로 안쪽(5px): 새로 띄우지는 않지만, 띄우고 있었으면 12px 안쪽까지 유지
    const sx = m.width / 320;
    const fxAt = (css: number) => (css - m.x) / sx - 0.5;
    const edge = upd({ H: T(fxAt(5) - 160, 0) });
    expect(computeGuideArrow(edge, anchor, m, { showing: false })).toBeNull();
    expect(computeGuideArrow(edge, anchor, m, { showing: true })).not.toBeNull();
    expect(computeGuideArrow(upd({ H: T(fxAt(20) - 160, 0) }), anchor, m, { showing: true })).toBeNull();
  });

  it("contain letterbox counts as not visible (visible = video rect)", () => {
    const m = computeDisplayMapping(640, 480, 390, 844, "contain")!;
    const V = visibleRect(m);
    expect(V.y).toBeCloseTo((844 - 292.5) / 2, 9);
    expect(V.height).toBeCloseTo(292.5, 9);
    const a = computeGuideArrow(upd({ state: "lost", H: null, hint: T(0, -400), reason: "offscreen" }), anchor, m)!;
    // 화살표는 영상 사각형 안쪽 위 가장자리 (레터박스가 아니라)
    expect(a.y).toBeCloseTo(V.y + ARROW_INSET_CSS, 9);
    expect(a.angle).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("per-side insets keep the arrow clear of UI chrome", () => {
    const a = computeGuideArrow(upd({ state: "lost", H: null, hint: T(0, 400), reason: "offscreen" }), anchor, mc, {
      inset: { bottom: 100 },
    })!;
    expect(a.y).toBeCloseTo(140, 9);
    expect(a.angle).toBeCloseTo(Math.PI / 2, 9);
  });

  it("anchor behind the camera / at infinity still gets a sensible direction", () => {
    // w = 1 − 0.004·x_ref: ref 중심(160) w=0.36 > 0, 기준점 x=300 → w = −0.2 (카메라 뒤, 오른쪽 방향)
    const H: Mat3 = [1, 0, 0, 0, 1, 0, -0.004, 0, 1];
    const a = computeGuideArrow(upd({ state: "lost", H: null, hint: H, reason: "offscreen" }), { x: 300, y: 120 }, mc)!;
    expect(a.target).toBeNull();
    expect(Math.cos(a.angle)).toBeGreaterThan(0.9); // 오른쪽
    expect(a.x).toBeCloseTo(320 - ARROW_INSET_CSS, 9);
    // H 전체 부호가 뒤집혀도 같은 답 (호모그래피는 스케일 임의)
    const neg = H.map((v) => -v);
    const b = computeGuideArrow(upd({ state: "lost", H: null, hint: neg, reason: "offscreen" }), { x: 300, y: 120 }, mc)!;
    expect(b.angle).toBeCloseTo(a.angle, 9);
    expect(b.x).toBeCloseTo(a.x, 9);
    // 추적 중 H라도 기준점이 카메라 뒤면 (그릴 수 없으니) 화살표
    expect(computeGuideArrow(upd({ H }), { x: 300, y: 120 }, mc)).not.toBeNull();
  });

  it("non-finite input → null", () => {
    expect(computeGuideArrow(upd({ H: [Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1] }), anchor, mc)).toBeNull();
    expect(computeGuideArrow(upd({}), { x: Number.NaN, y: 0 }, mc)).toBeNull();
  });
});

describe("GuideArrowState", () => {
  const ref = { width: 320, height: 240 };
  const mc = computeDisplayMapping(320, 240, 320, 240, "contain")!;
  const hintU: GuideUpdate = { state: "lost", H: null, hint: [1, 0, 400, 0, 1, 0, 0, 0, 1], reason: "offscreen", refSize: ref, frameSize: ref };
  const lostU: GuideUpdate = { state: "lost", H: null, hint: null, reason: "unverified", refSize: ref, frameSize: ref };
  const visU: GuideUpdate = { state: "tracking", H: I, hint: null, refSize: ref, frameSize: ref };
  const p = { x: 160, y: 120 };

  it("holds briefly across gaps, clears immediately when the pin is visible", () => {
    const g = new GuideArrowState(300);
    expect(g.next(hintU, p, mc, 0)).not.toBeNull();
    expect(g.next(lostU, p, mc, 100)).not.toBeNull(); // 공백 메움
    expect(g.showing()).toBe(true);
    expect(g.next(lostU, p, mc, 350)).toBeNull(); // 300ms 지남
    expect(g.next(hintU, p, mc, 400)).not.toBeNull();
    expect(g.next(visU, p, mc, 410)).toBeNull(); // 보이면 즉시
    g.next(hintU, p, mc, 500);
    g.reset();
    expect(g.showing()).toBe(false);
    expect(g.next(null, null, null, 510)).toBeNull();
  });
});

describe("renderGuideArrow", () => {
  function arrowRecorder() {
    const base = recorder();
    const tf: string[] = [];
    const ctx = Object.assign(base.ctx, {
      translate: (x: number, y: number) => tf.push(`t${x.toFixed(2)},${y.toFixed(2)}`),
      rotate: (a: number) => tf.push(`r${a.toFixed(3)}`),
      scale: (x: number) => tf.push(`s${x.toFixed(3)}`),
    }) as unknown as ArrowContext;
    return { ...base, ctx, tf };
  }

  it("draws dark + white outlines and a red fill, rotated toward the target, tip never past the clamp", () => {
    const r = arrowRecorder();
    const a: GuideArrow = { x: 300, y: 100, angle: Math.PI / 2, target: null, source: "hint" };
    renderGuideArrow(r.ctx, a, { timeMs: 0 });
    expect(r.paths.map((p) => [p.style, p.width])).toEqual([
      ["rgba(0,0,0,0.45)", 11],
      ["#FFFFFF", 6],
    ]);
    expect(r.ops.filter((o) => o.op === "fill").map((o) => o.style)).toEqual(["#FF3B30"]);
    expect(r.tf[0]).toBe("t300.00,100.00");
    expect(r.tf[1]).toBe(`r${(Math.PI / 2).toFixed(3)}`);
    // 맥동: t=0이면 8px 뒤, 반 주기(600ms)에 끝 = 클램프 위치
    expect(r.tf[2]).toBe("t-8.00,0.00");
    const r2 = arrowRecorder();
    renderGuideArrow(r2.ctx, a, { timeMs: 600 });
    expect(r2.tf[2]).toBe("t0.00,0.00");
    // 모양의 끝은 원점(+x 방향 최대)
    const xs = r.paths[0].points.map((p) => p.x);
    expect(Math.max(...xs)).toBe(0);
    expect(Math.min(...xs)).toBe(-ARROW_LENGTH_CSS);
  });

  it("skips invalid arrows and zero opacity", () => {
    const r = arrowRecorder();
    renderGuideArrow(r.ctx, { x: Number.NaN, y: 0, angle: 0, target: null, source: "hint" });
    renderGuideArrow(r.ctx, { x: 1, y: 1, angle: 0, target: null, source: "hint" }, { opacity: 0 });
    expect(r.paths.length + r.ops.length).toBe(0);
  });
});

describe("draw bounds (partial clears)", () => {
  const ref = { width: 320, height: 240 };
  const m: DisplayMapping = computeDisplayMapping(320, 240, 320, 240, "fill")!;
  it("cover everything renderAnnotations / renderGuideArrow touch", () => {
    const anns: Annotation[] = [
      { id: "p", kind: "pin", p: { x: 0.5, y: 0.5 } },
      { id: "s", kind: "stroke", points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.2 }] },
    ];
    for (const H of [I, [4, 0, -400, 0, 4, -300, 0, 0, 1], [3, 0, 0, 0, 3, 0, 0, 0.004, 1]] as Mat3[]) {
      const b = annotationBounds(anns, H, ref, frame, m)!;
      for (const t of [0, 400, 800, 1200, 1599]) {
        const r = recorder();
        renderAnnotations(r.ctx, anns, H, ref, frame, m, { timeMs: t });
        for (const path of r.paths) {
          for (const p of path.points) {
            const pad = path.width / 2;
            expect(p.x - pad).toBeGreaterThanOrEqual(b.x);
            expect(p.x + pad).toBeLessThanOrEqual(b.x + b.width);
            expect(p.y - pad).toBeGreaterThanOrEqual(b.y);
            expect(p.y + pad).toBeLessThanOrEqual(b.y + b.height);
          }
        }
      }
    }
    // 카메라 뒤로 가는 점이 있으면 모름(null) → 전체 지우기
    expect(annotationBounds(anns, [1, 0, 0, 0, 1, 0, -0.01, 0, 2], ref, frame, m)).toBeNull();
  });

  it("arrow bounds hold the rotated, pulsed, outlined shape", () => {
    for (let k = 0; k < 16; k++) {
      const a: GuideArrow = { x: 100, y: 200, angle: (k * Math.PI) / 8, target: null, source: "hint" };
      const b = guideArrowBounds(a);
      // 모양 꼭짓점을 회전·최대 맥동(크기 1.06, 밀기 0)으로
      for (const [sx, sy] of [
        [0, 0],
        [-28, 24],
        [-64, 10],
        [-64, -10],
        [-28, -24],
      ]) {
        const x = a.x + Math.cos(a.angle) * sx * 1.06 - Math.sin(a.angle) * sy * 1.06;
        const y = a.y + Math.sin(a.angle) * sx * 1.06 + Math.cos(a.angle) * sy * 1.06;
        expect(x - 6).toBeGreaterThanOrEqual(b.x);
        expect(x + 6).toBeLessThanOrEqual(b.x + b.width);
        expect(y - 6).toBeGreaterThanOrEqual(b.y);
        expect(y + 6).toBeLessThanOrEqual(b.y + b.height);
      }
    }
  });
});
