import { describe, expect, it } from "vitest";
import * as jpeg from "jpeg-js";
import type { GrayImage, Mat3, Point, Rect, TrackerConfig, TrackResult } from "./types";
import { IDENTITY, applyH, invert3, mul3 } from "./geometry";
import { DEFAULT_TRACKER_CONFIG, PlanarTracker } from "./tracker";
import { Rng } from "./cv/rng";
import { camHomography, makeFlat, makePortRow, makeTexture, renderView } from "./cv/testing/synth";

// 합성 시퀀스: 평면(월드) 텍스처를 알려진 호모그래피로 렌더 → 정답 H = V_t · V_ref⁻¹

const W = 320;
const H = 240;

interface Seq {
  frames: GrayImage[];
  views: Mat3[];
}

function makeSeq(world: GrayImage, n: number, view: (t: number) => Mat3, noise = 2, seed = 1): Seq {
  const rng = new Rng(seed);
  const views: Mat3[] = [];
  const frames: GrayImage[] = [];
  for (let t = 0; t < n; t++) {
    const V = view(t);
    views.push(V);
    frames.push(renderView(world, V, W, H, { noise, rng }));
  }
  return { frames, views };
}

function pinError(res: TrackResult, seq: Seq, refIdx: number, t: number, pin: Point): number {
  const gt = applyH(mul3(seq.views[t], invert3(seq.views[refIdx])!), pin)!;
  const est = res.H ? applyH(res.H, pin) : null;
  return est ? Math.hypot(est.x - gt.x, est.y - gt.y) : Infinity;
}

const shown = (r: TrackResult) => r.state === "tracking" || r.state === "weak";

describe("PlanarTracker", () => {
  const world = makeTexture(900, 700, 11);
  // 월드 중앙 부근을 배율 ~0.6으로 보며 이동·회전·확대·원근
  const view = (t: number): Mat3 =>
    camHomography({
      cx: 450,
      cy: 350,
      tx: -450 + 160 + 30 * Math.sin(t * 0.09),
      ty: -350 + 120 + 18 * Math.sin(t * 0.11),
      rot: 0.45 * Math.sin(t * 0.05),
      scale: 0.6 * (1 + 0.3 * Math.sin(t * 0.06)),
      px: 0.0005 * Math.sin(t * 0.04),
      py: 0.0004 * Math.cos(t * 0.07),
    });
  const seq = makeSeq(world, 90, view);
  const roi: Rect = { x: 110, y: 70, width: 100, height: 100 };
  const pin = { x: 160, y: 120 };

  it("defaults satisfy the TrackerConfig contract", () => {
    const c: TrackerConfig = DEFAULT_TRACKER_CONFIG;
    expect(c.minWeakInliers).toBeLessThan(c.minInliers);
    expect(c.pyramidLevels).toBeGreaterThanOrEqual(3);
    // 잘못된 값은 무시하고 기본값 유지
    const t = new PlanarTracker({ seed: 7, minInliers: Number.NaN, maxTrackedPoints: 64, snapPoints: 3 as unknown as boolean });
    expect(t.config.seed).toBe(7);
    expect(t.config.minInliers).toBe(DEFAULT_TRACKER_CONFIG.minInliers);
    expect(t.config.maxTrackedPoints).toBe(64);
    expect(t.config.snapPoints).toBe(true);
  });

  it("engineer side (initialH = I): tracks translation + rotation + scale + perspective with pin error < 2px", () => {
    const tr = new PlanarTracker();
    const info = tr.setReference(seq.frames[0], roi, IDENTITY);
    expect(info.trackable).toBe(true);
    expect(info.features).toBeGreaterThanOrEqual(40);
    expect(tr.hasReference()).toBe(true);
    const errs: number[] = [];
    for (let t = 1; t < seq.frames.length; t++) {
      const r = tr.process(seq.frames[t], t * 50);
      expect(r.state).toBe("tracking");
      const e = pinError(r, seq, 0, t, pin);
      expect(e).toBeLessThan(2);
      errs.push(e);
      expect(r.confidence).toBeGreaterThan(0.5);
      expect(r.inliers).toBeGreaterThanOrEqual(DEFAULT_TRACKER_CONFIG.minInliers);
      expect(r.timings.total).toBeGreaterThan(0);
      expect(r.timings.lk).toBeGreaterThanOrEqual(0);
    }
    errs.sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(0.3);
  });

  it("customer side: acquires a reference taken 10 frames earlier within a few frames", () => {
    const tr = new PlanarTracker();
    tr.setReference(seq.frames[0], roi);
    let first = -1;
    for (let t = 10; t < 40; t++) {
      const r = tr.process(seq.frames[t], t * 50);
      if (first < 0) {
        if (r.state === "searching") {
          expect(r.H).toBeNull();
          expect(r.redetected).toBe(true);
          continue;
        }
        first = t;
        expect(r.redetected).toBe(true);
      }
      expect(r.state === "tracking" || r.state === "weak").toBe(true);
      expect(pinError(r, seq, 0, t, pin)).toBeLessThan(2);
    }
    expect(first).toBeGreaterThanOrEqual(10);
    expect(first).toBeLessThanOrEqual(12);
  });

  it("customer side: acquires across 1.5× scale and 30° rotation", () => {
    const V0 = camHomography({ cx: 450, cy: 350, tx: -290, ty: -230, scale: 0.6 });
    const V1 = camHomography({ cx: 450, cy: 350, tx: -290, ty: -230, scale: 0.9, rot: Math.PI / 6 });
    const s2 = makeSeq(world, 2, (t) => (t === 0 ? V0 : V1), 2, 5);
    const tr = new PlanarTracker();
    tr.setReference(s2.frames[0], roi);
    const r = tr.process(s2.frames[1], 0);
    expect(r.state).toBe("tracking");
    expect(pinError(r, s2, 0, 1, pin)).toBeLessThan(2);
  });

  it("customer side: acquires from a JPEG-compressed reference (640px, q80 → working resolution)", () => {
    // 엔지니어 프레임을 2배(640×480)로 렌더 → JPEG q80 → 디코드 → 2×2 평균으로 320×240 (README 흐름)
    const Vbig = mul3([2, 0, 0.5, 0, 2, 0.5, 0, 0, 1], seq.views[0]);
    const big = renderView(world, Vbig, 640, 480, { noise: 2, rng: new Rng(21) });
    const rgba = new Uint8Array(640 * 480 * 4);
    for (let i = 0; i < 640 * 480; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = big.data[i];
      rgba[i * 4 + 3] = 255;
    }
    const dec = jpeg.decode(jpeg.encode({ data: rgba, width: 640, height: 480 }, 80).data, { useTArray: true });
    const ref: GrayImage = { width: W, height: H, data: new Uint8Array(W * H) };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let acc = 0;
        for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) acc += dec.data[((2 * y + yy) * 640 + 2 * x + xx) * 4];
        ref.data[y * W + x] = Math.round(acc / 4);
      }
    }
    const tr = new PlanarTracker();
    tr.setReference(ref, roi);
    // 고객 폰은 지연(~0.3s)만큼 이미 움직였다: 6프레임 뒤부터
    let first = -1;
    for (let t = 6; t < 20; t++) {
      const r = tr.process(seq.frames[t], t * 50);
      if (!shown(r)) continue;
      if (first < 0) first = t;
      expect(pinError(r, seq, 0, t, pin)).toBeLessThan(2);
    }
    expect(first).toBeGreaterThanOrEqual(6);
    expect(first).toBeLessThanOrEqual(8);
  });

  it("survives a strong lighting change (gain/bias) without wrong pins", () => {
    const n = 30;
    const light = (t: number) => (t < 10 ? { gain: 1, bias: 0 } : t < 20 ? { gain: 0.55, bias: 35 } : { gain: 1.3, bias: -25 });
    const rng = new Rng(31);
    const views = Array.from({ length: n }, (_, t) => seq.views[t]);
    const frames = views.map((V, t) => renderView(world, V, W, H, { noise: 2, rng, ...light(t) }));
    const s6 = { frames, views };
    const tr = new PlanarTracker();
    tr.setReference(frames[0], roi, IDENTITY);
    let shownN = 0;
    for (let t = 1; t < n; t++) {
      const r = tr.process(frames[t], t * 50);
      if (!shown(r)) continue;
      shownN++;
      expect(pinError(r, s6, 0, t, pin)).toBeLessThan(2);
    }
    expect(shownN).toBeGreaterThanOrEqual(n - 3);
  });

  it("partial occlusion (flat blob over a third of the ROI) never shows a wrong pin", () => {
    const n = 30;
    const rng = new Rng(41);
    const frames = seq.frames.slice(0, n).map((f, t) => {
      const g: GrayImage = { width: W, height: H, data: f.data.slice() };
      if (t >= 8 && t < 22) {
        // 손가락처럼: 핀 오른쪽 위를 덮는 밝은 덩어리 (핀 자체는 보임)
        const p = applyH(mul3(seq.views[t], invert3(seq.views[0])!), pin)!;
        for (let y = Math.max(0, Math.round(p.y - 60)); y < Math.min(H, Math.round(p.y + 5)); y++) {
          for (let x = Math.max(0, Math.round(p.x + 8)); x < Math.min(W, Math.round(p.x + 70)); x++) {
            g.data[y * W + x] = 215 + Math.round(rng.gauss() * 2);
          }
        }
      }
      return g;
    });
    const s7 = { frames, views: seq.views.slice(0, n) };
    const tr = new PlanarTracker();
    tr.setReference(frames[0], roi, IDENTITY);
    let shownN = 0;
    for (let t = 1; t < n; t++) {
      const r = tr.process(frames[t], t * 50);
      if (!shown(r)) continue;
      shownN++;
      expect(pinError(r, s7, 0, t, pin)).toBeLessThan(3);
    }
    expect(shownN).toBeGreaterThan(n / 2);
  });

  it("recovers after the target leaves the frame and comes back", () => {
    // 0~9 제자리, 10~24 오른쪽으로 크게 벗어남, 25~ 되돌아옴
    const away = (t: number) => (t < 10 ? 0 : t < 25 ? 600 : 0);
    const s3 = makeSeq(world, 35, (t) => camHomography({ cx: 450, cy: 350, tx: -290 + away(t), ty: -230, scale: 0.6 }), 2, 9);
    const tr = new PlanarTracker();
    tr.setReference(s3.frames[0], roi, IDENTITY);
    const states: string[] = [];
    for (let t = 1; t < 35; t++) {
      const r = tr.process(s3.frames[t], t * 50);
      states.push(r.state);
      if (t >= 10 && t < 25) expect(shown(r)).toBe(false);
      if (shown(r)) expect(pinError(r, s3, 0, t, pin)).toBeLessThan(2);
    }
    expect(states[states.length - 1]).toBe("tracking");
    // 복귀 첫 프레임(25)부터 다시 찾는다
    expect(states[25 - 1]).toBe("tracking");
    expect(states.slice(9, 24).every((s) => s === "lost")).toBe(true);
  });

  it("pin (anchor) leaving the frame → reported lost while tracking continues, shown again on return", () => {
    // 핀이 오른쪽 가장자리 밖으로 25px 나갔다가 돌아옴 (ROI 절반은 계속 보임)
    const shift = (t: number) => (t < 5 ? 0 : t < 12 ? -((t - 4) * 25) : t < 20 ? -175 : -175 + (t - 19) * 25);
    const s4 = makeSeq(world, 28, (t) => camHomography({ cx: 450, cy: 350, tx: -290 + 165 + shift(t), ty: -230, scale: 0.6 }), 2, 12);
    const tr = new PlanarTracker({ reanchorInterval: 0 });
    tr.setReference(s4.frames[0], roi, IDENTITY);
    let lostWhileOut = 0;
    for (let t = 1; t < 28; t++) {
      const r = tr.process(s4.frames[t], t * 50);
      const gt = applyH(mul3(s4.views[t], invert3(s4.views[0])!), pin)!;
      const inFrame = gt.x >= -0.5 && gt.x <= W - 0.5;
      if (!inFrame) {
        expect(shown(r)).toBe(false);
        expect(r.H).toBeNull();
        if (r.state === "lost") lostWhileOut++;
        // 내부적으로는 계속 추적 중
        expect(tr.getState() === "tracking" || tr.getState() === "weak").toBe(true);
        // 내부 추적이 (ROI 대부분이 화면 밖이라 인라이어가 적어 weak여도) 검증을 통과했으면 그 H가 hint —
        // 방향 화살표 전용이고, 위치도 수 px 안으로 맞는다
        expect(r.reason).toBe("offscreen");
        expect(r.hint).not.toBeNull();
        const h = applyH(r.hint!, pin)!;
        expect(Math.hypot(h.x - gt.x, h.y - gt.y)).toBeLessThan(3);
      } else {
        expect(shown(r)).toBe(true);
        expect(pinError(r, s4, 0, t, pin)).toBeLessThan(2);
      }
    }
    expect(lostWhileOut).toBeGreaterThan(3);
  });

  it("anchor near the ROI edge leaves the frame → lost/offscreen with a hint that points at the pin", () => {
    // 앵커(주석 기준점)가 ROI 오른쪽 끝 → 화면 밖으로 나가도 ROI 대부분은 보여 내부 추적이 강하다
    const anchor = { x: 205, y: 120 };
    const shift = (t: number) => (t < 4 ? 0 : t < 12 ? (t - 3) * 18 : t < 18 ? 144 : 144 - (t - 17) * 18);
    const s8 = makeSeq(world, 26, (t) => camHomography({ cx: 450, cy: 350, tx: -290 + shift(t), ty: -230, scale: 0.6 }), 2, 21);
    const tr = new PlanarTracker();
    const info = tr.setReference(s8.frames[0], roi, IDENTITY, anchor);
    expect(info.trackable).toBe(true);
    expect(info.reason).toBeUndefined();
    let hints = 0;
    for (let t = 1; t < 26; t++) {
      const r = tr.process(s8.frames[t], t * 50);
      const gt = applyH(mul3(s8.views[t], invert3(s8.views[0])!), anchor)!;
      const m = DEFAULT_TRACKER_CONFIG.offscreenMargin;
      const onScreen = gt.x >= -m && gt.x <= W - 1 + m;
      if (onScreen) {
        expect(shown(r)).toBe(true);
        expect(r.hint).toBeNull();
        expect(r.reason).toBeUndefined();
        expect(pinError(r, s8, 0, t, anchor)).toBeLessThan(2);
      } else {
        expect(r.state).toBe("lost");
        expect(r.H).toBeNull();
        expect(r.reason).toBe("offscreen");
        expect(r.hint).not.toBeNull();
        const h = applyH(r.hint!, anchor)!;
        expect(h.x).toBeGreaterThan(W - 1);
        expect(Math.hypot(h.x - gt.x, h.y - gt.y)).toBeLessThan(2);
        hints++;
      }
    }
    expect(hints).toBeGreaterThanOrEqual(8);
  });

  it("no hint when it is disabled or the anchor is too far; reason stays unverified", () => {
    const anchor = { x: 205, y: 120 };
    const s9 = makeSeq(world, 8, (t) => camHomography({ cx: 450, cy: 350, tx: -290 + (t < 2 ? 0 : 150), ty: -230, scale: 0.6 }), 2, 22);
    const tr = new PlanarTracker({ hintMaxDiag: 0 });
    tr.setReference(s9.frames[0], roi, IDENTITY, anchor);
    for (let t = 2; t < 8; t++) {
      const r = tr.process(s9.frames[t], t * 50);
      expect(r.state).toBe("lost");
      expect(r.hint).toBeNull();
      expect(r.reason).toBe("unverified");
      expect(tr.getState()).toBe("tracking");
    }
  });

  it("reasons: invalid_frame, untrackable, unverified; tracking has no reason", () => {
    const tr = new PlanarTracker();
    expect(tr.process(seq.frames[1], 0).reason).toBeUndefined(); // 기준 없음
    tr.setReference(seq.frames[0], roi, IDENTITY);
    const ok = tr.process(seq.frames[1], 50);
    expect(ok.state).toBe("tracking");
    expect(ok.reason).toBeUndefined();
    expect(ok.hint).toBeNull();
    const bad = tr.process({ width: 4, height: 4, data: new Uint8Array(16) }, 100);
    expect(bad.state).toBe("lost");
    expect(bad.reason).toBe("invalid_frame");
    // 대상이 사라짐 (무늬 없는 화면) → 검증된 위치 없음
    const blank = makeFlat(W, H, 8, 1);
    const lost = tr.process(blank, 150);
    expect(lost.state).toBe("lost");
    expect(lost.reason).toBe("unverified");
    // 고객 쪽: 아직 못 찾음 → searching + unverified
    const cu = new PlanarTracker();
    cu.setReference(seq.frames[0], roi);
    const s0 = cu.process(blank, 0);
    expect(s0.state).toBe("searching");
    expect(s0.reason).toBe("unverified");
    // 추적 불가 기준
    const flat = new PlanarTracker();
    const info = flat.setReference(blank, roi);
    expect(info.trackable).toBe(false);
    expect(info.reason).toBe("low_texture");
    const u = flat.process(seq.frames[1], 0);
    expect(u.state).toBe("searching");
    expect(u.reason).toBe("untrackable");
  });

  /** 무늬 없는 사각 패널(월드 360..560 × 280..430) + 작은 로고 두 획 */
  function drawPanel(img: GrayImage, fill: number) {
    for (let y = 280; y < 430; y++) for (let x = 360; x < 560; x++) img.data[y * img.width + x] = fill;
    for (let k = 0; k < 2; k++) {
      const x0 = 440 + k * 16;
      for (let y = 342; y < 360; y++) for (let x = x0; x < x0 + 4; x++) img.data[y * img.width + x] = 70;
      for (let y = 349; y < 353; y++) for (let x = x0; x < x0 + 11; x++) img.data[y * img.width + x] = 70;
    }
  }
  const panelView = (t: number, k = 1) =>
    camHomography({
      cx: 450,
      cy: 350,
      tx: -290 + k * 60 * Math.sin(t * 0.08),
      ty: -230 + k * 20 * Math.sin(t * 0.05),
      scale: 0.6,
      rot: 0.1 * Math.sin(t * 0.06),
    });
  const logoWorld = { x: 452, y: 351 };

  it("pin on a textureless patch (only a faint mark) → trackable = false even if the context is textured", () => {
    const w = makeTexture(900, 700, 23);
    drawPanel(w, 180);
    const s5 = makeSeq(w, 6, (t) => panelView(t), 1.5, 13);
    const p0 = applyH(s5.views[0], logoWorld)!;
    const tr = new PlanarTracker();
    const info = tr.setReference(s5.frames[0], { x: p0.x - 30, y: p0.y - 30, width: 60, height: 60 }, IDENTITY);
    expect(info.trackable).toBe(false);
    expect(info.reason).toBe("pin_blank");
    expect(tr.getReferenceDiagnostics()!.pinCorners).toBeLessThan(5);
    for (let t = 1; t < 6; t++) {
      const r = tr.process(s5.frames[t], t * 50);
      expect(shown(r)).toBe(false);
      expect(r.reason).toBe("untrackable");
    }
  });

  it("anchor (not the ROI centre) decides pin_blank: textured ROI but the annotation sits on the blank panel", () => {
    const w = makeTexture(900, 700, 23);
    // 무늬 없는 넓은 판 (월드 300..600 × 250..500 → 화면 약 180×150px)
    for (let y = 250; y < 500; y++) for (let x = 300; x < 600; x++) w.data[y * w.width + x] = 180;
    const s5 = makeSeq(w, 2, (t) => panelView(t), 1.5, 13);
    // 판 한가운데 주석, ROI는 판 왼쪽 위 바깥의 무늬 많은 배경 쪽 (앵커를 조금 걸침)
    const a = applyH(s5.views[0], { x: 450, y: 375 })!;
    const texturedRoi: Rect = { x: a.x - 150, y: a.y - 125, width: 110, height: 90 };
    const withAnchor = new PlanarTracker().setReference(s5.frames[0], texturedRoi, IDENTITY, a);
    expect(withAnchor.trackable).toBe(false);
    expect(withAnchor.reason).toBe("pin_blank");
    // 같은 ROI, 앵커 없음(= ROI 중심, 무늬 많은 곳) → 추적 가능
    const centre = new PlanarTracker().setReference(s5.frames[0], texturedRoi, IDENTITY);
    expect(centre.trackable).toBe(true);
  });

  it("small tap ROI → expands for features, still tracks accurately (pin-area gate passes)", () => {
    const tr = new PlanarTracker();
    const tiny: Rect = { x: pin.x - 12, y: pin.y - 12, width: 24, height: 24 };
    const info = tr.setReference(seq.frames[0], tiny, IDENTITY);
    expect(info.trackable).toBe(true);
    expect(info.roi.width).toBeGreaterThan(40); // 최소 크기 + 확장
    const errs: number[] = [];
    for (let t = 1; t < 60; t++) {
      const r = tr.process(seq.frames[t], t * 50);
      expect(shown(r)).toBe(true);
      const e = pinError(r, seq, 0, t, pin);
      expect(e).toBeLessThan(2);
      errs.push(e);
    }
    errs.sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(0.5);
  });

  it("expanded ROI over a different plane (parallax) never shows a pin > 8px off", () => {
    // 앞 평면: 무늬 없는 패널 + 작은 로고 (핀), 뒤 평면: 무늬 많은 배경. 앞이 더 크게 움직인다(시차)
    const panel = makeFlat(900, 700, 21, 1);
    drawPanel(panel, 175);
    const bg = makeTexture(900, 700, 23);
    const rng = new Rng(8);
    const frames: GrayImage[] = [];
    const views: Mat3[] = [];
    for (let t = 0; t < 50; t++) {
      const a = renderView(panel, panelView(t), W, H, { noise: 1.5, rng });
      // 배경은 이동이 40%만 (멀리 있음)
      const b = renderView(bg, panelView(t, 0.4), W, H, { noise: 1.5, rng });
      const inv = invert3(panelView(t))!;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const q = applyH(inv, { x, y })!;
          if (!(q.x >= 360 && q.x < 560 && q.y >= 280 && q.y < 430)) a.data[y * W + x] = b.data[y * W + x];
        }
      }
      frames.push(a);
      views.push(panelView(t));
    }
    const p0 = applyH(views[0], logoWorld)!;
    const tr = new PlanarTracker();
    tr.setReference(frames[0], { x: p0.x - 30, y: p0.y - 30, width: 60, height: 60 }, IDENTITY);
    for (let t = 1; t < 50; t++) {
      const r = tr.process(frames[t], t * 50);
      if (!shown(r)) continue;
      const gt = applyH(mul3(views[t], invert3(views[0])!), p0)!;
      const est = applyH(r.H!, p0)!;
      expect(Math.hypot(est.x - gt.x, est.y - gt.y)).toBeLessThan(8);
    }
  });

  it("low-texture reference → trackable = false and never shows a pin", () => {
    const flat = makeFlat(W, H, 3, 1.5);
    const tr = new PlanarTracker();
    const info = tr.setReference(flat, { x: 110, y: 70, width: 100, height: 100 });
    expect(info.trackable).toBe(false);
    expect(info.features).toBeLessThan(DEFAULT_TRACKER_CONFIG.minReferenceFeatures);
    // ROI는 넓혀 봤어야 한다 (전체 화면까지)
    expect(info.roi.width).toBe(W);
    expect(info.roi.height).toBe(H);
    // 그래도 돌리면 표시하지 않는다
    const rng = new Rng(4);
    const tr2 = new PlanarTracker();
    tr2.setReference(flat, { x: 110, y: 70, width: 100, height: 100 }, IDENTITY);
    for (let t = 0; t < 10; t++) {
      const f = makeFlat(W, H, 3, 1.5);
      for (let i = 0; i < f.data.length; i++) f.data[i] = Math.max(0, Math.min(255, f.data[i] + Math.round(rng.gauss())));
      const r = tr2.process(f, t * 50);
      if (t > 0) expect(shown(r)).toBe(false);
    }
  });

  describe("repetitive pattern (identical ports)", () => {
    const PERIOD = 40;
    // 월드 좌표에서 포트 줄 (13개, 라벨 없음) — 배율 1로 프레임에 8개쯤 보인다
    const rowWorld = makePortRow(640, 240, { period: PERIOD, count: 13, uniqueLabel: false, seed: 3 });
    const rowView = (dx: number, extra: Partial<Parameters<typeof camHomography>[0]> = {}) =>
      camHomography({ cx: 320, cy: 120, tx: -160 + dx, ty: 0, ...extra });
    const portRoi: Rect = { x: 136, y: 76, width: 48, height: 48 };
    const portPin = { x: 160, y: 108 };

    it("identical ports only: ambiguous → customer cannot search (untrackable), engineer tracks but cannot re-find", () => {
      const ref = renderView(rowWorld, rowView(0), W, H, { noise: 1.5, rng: new Rng(1) });
      const cust = new PlanarTracker();
      const ci = cust.setReference(ref, portRoi);
      expect(ci.reason).toBe("ambiguous");
      expect(ci.trackable).toBe(false);
      const r0 = cust.process(ref, 0);
      expect(r0.state).toBe("searching");
      expect(r0.reason).toBe("untrackable");
      const eng = new PlanarTracker();
      const ei = eng.setReference(ref, portRoi, IDENTITY);
      expect(ei.reason).toBe("ambiguous");
      expect(ei.trackable).toBe(true);
      expect(eng.process(renderView(rowWorld, rowView(3), W, H, { noise: 1.5, rng: new Rng(5) }), 50).state).toBe("tracking");
      // 놓치면(무늬 없는 화면) 다시 찾을 방법이 없다 → untrackable (새로 찍어야 함)
      const gone = eng.process(makeFlat(W, H, 2, 1), 100);
      expect(gone.state).toBe("lost");
      expect(gone.reason).toBe("untrackable");
    });

    it("customer search never locks onto a neighbouring copy", () => {
      const tr = new PlanarTracker();
      const ref = renderView(rowWorld, rowView(0), W, H, { noise: 1.5, rng: new Rng(1) });
      tr.setReference(ref, portRoi);
      // 현재 화면: 정확히 한 주기·두 주기 옆으로 밀린 뷰 (진짜 포트는 보이지만 옆 복제본이 같은 자리에)
      for (const dx of [PERIOD, -PERIOD, 2 * PERIOD, PERIOD / 2, 3 * PERIOD]) {
        const V0 = rowView(0);
        const V1 = rowView(dx);
        const cur = renderView(rowWorld, V1, W, H, { noise: 1.5, rng: new Rng(2) });
        for (let k = 0; k < 3; k++) {
          const r = tr.process(cur, k * 50);
          if (shown(r)) {
            const gt = applyH(mul3(V1, invert3(V0)!), portPin)!;
            const est = applyH(r.H!, portPin)!;
            expect(Math.hypot(est.x - gt.x, est.y - gt.y)).toBeLessThan(8);
          }
        }
      }
    });

    it("customer search: target out of view but copies visible → never shown", () => {
      const tr = new PlanarTracker();
      const ref = renderView(rowWorld, rowView(0), W, H, { noise: 1.5, rng: new Rng(1) });
      tr.setReference(ref, portRoi);
      // 확대해서 오른쪽 끝 포트들만 보이게 (핀 포트는 화면 밖)
      for (const dx of [200, 240, -200]) {
        const V1 = rowView(dx, { scale: 1.3 });
        const cur = renderView(rowWorld, V1, W, H, { noise: 1.5, rng: new Rng(3) });
        const gt = applyH(mul3(V1, invert3(rowView(0))!), portPin)!;
        expect(gt.x < 0 || gt.x > W).toBe(true);
        for (let k = 0; k < 3; k++) expect(shown(tr.process(cur, k * 50))).toBe(false);
      }
    });

    it("engineer tracking while panning fast along the row does not slip to a neighbour", () => {
      const tr = new PlanarTracker();
      const n = 40;
      const dxAt = (t: number) => 70 * Math.sin((t / n) * Math.PI * 2); // 최대 ±70px, 프레임당 최대 ~11px
      const s = makeSeq(rowWorld, n, (t) => rowView(dxAt(t)), 1.5, 4);
      tr.setReference(s.frames[0], portRoi, IDENTITY);
      let shownCount = 0;
      for (let t = 1; t < n; t++) {
        const r = tr.process(s.frames[t], t * 50);
        if (!shown(r)) continue;
        shownCount++;
        expect(pinError(r, s, 0, t, portPin)).toBeLessThan(8);
      }
      expect(shownCount).toBeGreaterThan(n / 2);
    });
  });

  it("frame size change (device rotation) → re-detects instead of reusing the old pose", () => {
    const tr = new PlanarTracker();
    tr.setReference(seq.frames[0], roi, IDENTITY);
    for (let t = 1; t < 5; t++) expect(tr.process(seq.frames[t], t * 50).state).toBe("tracking");
    // 세로 프레임 (240×320): 같은 평면을 90° 돌려 본 영상
    const Vp = mul3([0, -1, 239, 1, 0, 0, 0, 0, 1], seq.views[5]);
    const portrait = renderView(world, Vp, 240, 320, { noise: 2, rng: new Rng(7) });
    const r = tr.process(portrait, 300);
    if (shown(r)) {
      const gt = applyH(mul3(Vp, invert3(seq.views[0])!), pin)!;
      const est = applyH(r.H!, pin)!;
      expect(Math.hypot(est.x - gt.x, est.y - gt.y)).toBeLessThan(2);
      expect(r.redetected).toBe(true);
    } else {
      expect(r.state).toBe("lost");
    }
    // 다음 프레임에는 확실히 다시 잡는다
    const r2 = tr.process(portrait, 350);
    expect(r2.state).toBe("tracking");
  });

  it("is deterministic for the same inputs and seed", () => {
    const run = () => {
      const tr = new PlanarTracker({ seed: 99 });
      tr.setReference(seq.frames[0], roi);
      const out: (number[] | null)[] = [];
      for (let t = 5; t < 25; t++) {
        const r = tr.process(seq.frames[t], t * 50);
        out.push(r.H ? r.H.map((v) => Math.round(v * 1e9) / 1e9) : null);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("handles missing/invalid input without throwing", () => {
    const tr = new PlanarTracker();
    expect(tr.hasReference()).toBe(false);
    const r0 = tr.process(seq.frames[0], 0);
    expect(r0.state).toBe("lost");
    expect(r0.H).toBeNull();
    const bad = tr.setReference({ width: 10, height: 10, data: new Uint8Array(3) }, roi);
    expect(bad.trackable).toBe(false);
    expect(tr.hasReference()).toBe(false);
    const nanRoi = tr.setReference(seq.frames[0], { x: NaN, y: 0, width: 10, height: 10 });
    expect(nanRoi.trackable).toBe(false);
    tr.setReference(seq.frames[0], roi, [NaN, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(tr.getState()).toBe("searching");
    const r1 = tr.process({ width: 5, height: 5, data: new Uint8Array(25) }, 0);
    expect(r1.H).toBeNull();
    tr.clearReference();
    expect(tr.hasReference()).toBe(false);
    // ROI가 프레임 밖으로 걸쳐도 안쪽으로 맞춘다
    const info = tr.setReference(seq.frames[0], { x: 290, y: -20, width: 80, height: 60 });
    expect(info.roi.x + info.roi.width).toBeLessThanOrEqual(W);
    expect(info.roi.y).toBeGreaterThanOrEqual(0);
  });
});

describe("PlanarTracker offscreen direction hint (dead reckoning)", () => {
  // 넓은 월드: 대상(ROI)이 화면 밖으로 완전히 나가도 화면에는 다른 무늬가 보인다 (벽·주변 기기)
  const world2 = makeTexture(1700, 700, 23);
  const roi2: Rect = { x: 110, y: 70, width: 100, height: 100 };
  const anchor = { x: 160, y: 120 };
  const ease = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
  // 엔지니어 30fps: 0.27초 제자리 → 0.73초에 520px 오른쪽으로 → 1.3초 머묾 → 0.73초에 돌아옴 → 머묾
  const shift = (t: number) => (t < 8 ? 0 : t < 30 ? 520 * ease((t - 8) / 22) : t < 70 ? 520 : 520 * (1 - ease((t - 70) / 22)));
  const view2 = (t: number): Mat3 =>
    camHomography({
      cx: 450,
      cy: 350,
      tx: -290 - shift(t),
      ty: -230 + 5 * Math.sin(t * 0.3),
      rot: 0.03 * Math.sin(t * 0.2),
      scale: 0.6 * (1 + 0.04 * Math.sin(t * 0.15)),
    });
  const N = 100;
  const dt = 1000 / 30;
  const seq2 = makeSeq(world2, N, view2, 2, 31);
  const gtAnchor = (t: number) => applyH(mul3(seq2.views[t], invert3(seq2.views[0])!), anchor)!;
  const m = DEFAULT_TRACKER_CONFIG.offscreenMargin;
  const isOut = (p: Point) => p.x < -m || p.y < -m || p.x > W - 1 + m || p.y > H - 1 + m;
  const angle = (a: Point, b: Point) => {
    const cx = (W - 1) / 2;
    const cy = (H - 1) / 2;
    let d = Math.abs(Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    if (d > Math.PI) d = 2 * Math.PI - d;
    return (d * 180) / Math.PI;
  };
  const q = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor((v.length - 1) * p))];

  it("anchor leaves with the whole ROI → hint from dead reckoning on ≥80% of offscreen frames, arrow within 15°/35°", () => {
    const tr = new PlanarTracker();
    expect(tr.setReference(seq2.frames[0], roi2, IDENTITY, anchor).trackable).toBe(true);
    let off = 0;
    let hints = 0;
    let internalLost = 0;
    const angles: number[] = [];
    let backAt = -1;
    let reacquired = -1;
    for (let t = 1; t < N; t++) {
      const r = tr.process(seq2.frames[t], t * dt);
      const g = gtAnchor(t);
      // 계약: hint는 lost + offscreen에서만, reason=offscreen이면 hint가 있다
      expect(r.reason === "offscreen").toBe(r.hint !== null);
      if (r.hint) expect(r.state).toBe("lost");
      if (shown(r)) expect(pinError(r, seq2, 0, t, anchor)).toBeLessThan(2);
      if (isOut(g)) {
        off++;
        expect(shown(r)).toBe(false);
        expect(r.H).toBeNull();
        const internal = tr.getState();
        if (internal === "lost") internalLost++;
        if (r.hint) {
          hints++;
          angles.push(angle(applyH(r.hint, anchor)!, g));
        }
      } else {
        // 화면 안인데 표시하지 못하면(재검출 전) 화살표도 없다
        if (!shown(r) && t > 40) {
          expect(r.hint).toBeNull();
          expect(r.reason).not.toBe("offscreen");
        }
        if (t > 40 && backAt < 0) backAt = t;
        if (backAt >= 0 && reacquired < 0 && shown(r)) reacquired = t;
      }
    }
    expect(off).toBeGreaterThan(45);
    // ROI까지 화면 밖이라 내부 추적도 끊긴 프레임이 대부분 — 예전에는 여기서 hint가 없었다
    expect(internalLost).toBeGreaterThan(off / 2);
    expect(hints / off).toBeGreaterThanOrEqual(0.8);
    expect(q(angles, 0.5)).toBeLessThanOrEqual(15);
    expect(q(angles, 0.95)).toBeLessThanOrEqual(35);
    // 돌아오면 재검출로 다시 tracking (추측 항법은 관여하지 않는다)
    expect(reacquired).toBeGreaterThan(0);
    expect(reacquired - backAt).toBeLessThanOrEqual(10);
  });

  it("dead reckoning never changes state / H: identical to hintDeadReckon=false except for hint and reason", () => {
    const a = new PlanarTracker();
    const b = new PlanarTracker({ hintDeadReckon: false });
    a.setReference(seq2.frames[0], roi2, IDENTITY, anchor);
    b.setReference(seq2.frames[0], roi2, IDENTITY, anchor);
    let extra = 0;
    for (let t = 1; t < N; t++) {
      const ra = a.process(seq2.frames[t], t * dt);
      const rb = b.process(seq2.frames[t], t * dt);
      expect(ra.state).toBe(rb.state);
      expect(ra.H).toEqual(rb.H);
      expect(ra.inliers).toBe(rb.inliers);
      expect(ra.redetected).toBe(rb.redetected);
      if (rb.hint) expect(ra.hint).toEqual(rb.hint);
      if (ra.hint && !rb.hint) extra++;
      // 추측 항법 비용은 검증된 자세가 없는 프레임에서만 든다
      if (shown(ra)) expect(ra.timings.hint).toBeUndefined();
    }
    expect(extra).toBeGreaterThan(20);
  });

  it("stops instead of guessing after an unmatchable frame (violent shake), until re-verified", () => {
    const junk = renderView(makeTexture(900, 700, 77), camHomography({ cx: 450, cy: 350, tx: -290, ty: -230, scale: 0.6 }), W, H, { noise: 2 });
    const tr = new PlanarTracker();
    tr.setReference(seq2.frames[0], roi2, IDENTITY, anchor);
    let before = 0;
    for (let t = 1; t < N; t++) {
      const frame = t === 45 ? junk : seq2.frames[t];
      const r = tr.process(frame, t * dt);
      if (t < 45 && r.hint) before++;
      // 흔들린 뒤로는 다시 검증될 때까지 화살표 없음 (끊긴 사슬을 추측으로 잇지 않는다)
      if (t >= 45 && t < 70) expect(r.hint).toBeNull();
    }
    expect(before).toBeGreaterThan(10);
  });

  it("expires after hintMaxAgeMs since the last verified pose", () => {
    const tr = new PlanarTracker({ hintMaxAgeMs: 800 });
    tr.setReference(seq2.frames[0], roi2, IDENTITY, anchor);
    let lastVerified = 0;
    let drHints = 0;
    for (let t = 1; t < 70; t++) {
      const ts = t * dt;
      const r = tr.process(seq2.frames[t], ts);
      const internal = tr.getState();
      if (internal === "tracking" || internal === "weak") lastVerified = ts;
      else if (r.hint) {
        drHints++;
        expect(ts - lastVerified).toBeLessThanOrEqual(800);
      }
    }
    expect(drHints).toBeGreaterThan(5);
  });

  it("no hint when tracking is lost in the middle of the frame (occlusion), nor when disabled", () => {
    const blank = makeFlat(W, H, 3, 1);
    const tr = new PlanarTracker();
    tr.setReference(seq2.frames[0], roi2, IDENTITY, anchor);
    for (let t = 1; t < 6; t++) expect(shown(tr.process(seq2.frames[t], t * dt))).toBe(true);
    for (let t = 6; t < 12; t++) {
      const r = tr.process(blank, t * dt);
      expect(r.state).toBe("lost");
      expect(r.hint).toBeNull();
      expect(r.reason).toBe("unverified");
      // 앵커가 화면 한가운데 있었으므로 추측 항법을 시작하지도 않는다 (CPU 0)
      expect(r.timings.hint).toBeUndefined();
    }

    const off = new PlanarTracker({ hintDeadReckon: false });
    off.setReference(seq2.frames[0], roi2, IDENTITY, anchor);
    for (let t = 1; t < 70; t++) {
      const r = off.process(seq2.frames[t], t * dt);
      const internal = off.getState();
      if (internal === "lost") expect(r.hint).toBeNull();
    }
  });
});
