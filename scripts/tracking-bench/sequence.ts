// 시나리오 → 렌더 가능한 장면 + 처리 프레임 시각 + 기준 이미지 + 프레임별 정답(GT).
//
// 파이프라인 (README 런타임과 같은 순서):
//   고객 카메라(스트림 해상도, 8bit) ─┬─ 고객: 면적 평균 → 작업 해상도(긴 변 320) → 추적
//                                    └─ 엔지니어: [대역폭 축소] → JPEG(WebRTC 흉내) → 면적 평균 → 작업 해상도 → 추적
//   고객 쪽 기준 = 엔지니어 화면의 그 프레임 → 긴 변 640 → JPEG q80 (DataChannel 전송) → 작업 해상도
import type { GrayImage, Mat3, Point, Rect } from "../../src/lib/tracking/types";
import { clampRect, mul3 } from "../../src/lib/tracking/geometry";
import {
  HandJitter,
  type Intrinsics,
  type JitterSample,
  type Pose,
  handAffine,
  handSdf,
  intrinsics,
  invertOrThrow,
  planeToImage,
  poseFromView,
  project,
  streamToWork,
  TARGET_AFFINE,
  workDims,
} from "./camera";
import { fitLongSide, jpegRoundTripGray, jpegSimGray, scaleBy, toWorking } from "./imageops";
import { type CameraFrame, CameraRenderer, type HandSetup, type PhotoParams, type SceneSetup } from "./render";
import { hashString, smootherstep } from "./rng";
import type { Scenario, SceneCtx, Side } from "./scenarios";
import { TEXTURES, type TextureMeta, loadTexture, readTextureMeta } from "./textures";

export const CAMERA_FPS = 30;
export const DEFAULT_TRANSPORT = { quality: 75, scale: 1 };
/** 고객이 받는 기준 이미지: 긴 변 640, JPEG 품질 0.8 (README 프로토콜) */
export const REF_JPEG = { maxLong: 640, quality: 80 };
const DEFAULT_JITTER = { rotDeg: 0.3, transMm: 1.5 };

/** 파이프라인 전역 옵션 (CLI에서 바꿈) */
export const pipelineOptions = {
  /** 프레임마다 jpeg-js로 실제 인코드·디코드 (느림). 기본은 같은 손실을 내는 DCT 양자화 시뮬레이터 */
  exactJpeg: false,
  /** 모션 블러를 서브프레임 자세 평균으로 (느림). 기본은 표면별 운동 벡터 선 적분 */
  exactBlur: false,
};

/** 프레임 하나의 정답 */
export interface FrameGT {
  /** 처리 순번 */
  k: number;
  /** 카메라 프레임 시각 (초, 노출 중심) */
  t: number;
  /** 작업 해상도 */
  width: number;
  height: number;
  /** ref 작업 픽셀 → 이 프레임 작업 픽셀 (픽셀 중심 규약) */
  H: Mat3;
  /** 대상 평면 → 이 프레임 작업 픽셀 */
  planeToWork: Mat3;
  /** 핀 정답 위치 (롤링 셔터 반영). 카메라 뒤면 null */
  pin: Point | null;
  /** 핀이 프레임 안에 있음 */
  inFrame: boolean;
  /** 프레임 밖으로 벗어난 거리(px, 안이면 0) */
  offscreenBy: number;
  /** 손에 가려짐 */
  occluded: boolean;
  /** inFrame && !occluded */
  visible: boolean;
  /** ROI 격자점 중 화면 안에 보이는 비율 (0~1) */
  roiVisible: number;
}

export interface Sequence {
  scenario: Scenario;
  side: Side;
  fps: number;
  seed: number;
  refTime: number;
  /** 처리하는 카메라 프레임 시각들 */
  times: number[];
  ref: GrayImage;
  roi: Rect;
  /** ref 작업 픽셀 좌표의 핀 */
  pinRef: Point;
  pinPlane: Point;
  /** 엔지니어 쪽이면 단위행렬, 고객 쪽이면 undefined */
  initialH: Mat3 | undefined;
  refPlaneToWork: Mat3;
  gt: FrameGT[];
  ctx: SceneCtx;
  scene: SceneSetup;
  /** k번째 처리 프레임 (작업 해상도 그레이) */
  renderFrame(k: number): GrayImage;
  /** 원시 카메라 프레임 (스트림 해상도) */
  renderCamera(t: number, color?: boolean): CameraFrame;
  /** 시각 t의 스트림 크기 */
  streamAt(t: number): Intrinsics;
  /** 시각 t에서 대상 평면 → 스트림 픽셀(가장자리 규약) */
  planeToStream(t: number): Mat3;
  /** 시각 t의 핀 스트림 좌표 (롤링 셔터 반영, 가장자리 규약) */
  pinStream(t: number): Point | null;
  /** 스트림 좌표(가장자리 규약)가 손에 가려지는지 */
  occludedAt(t: number, p: Point): boolean;
  /** 엔지니어 쪽 영상 압축 품질 (압축 없으면 100) */
  qualityAt(t: number): number;
}

const metaCache = new Map<string, TextureMeta>();
function meta(id: keyof typeof TEXTURES): TextureMeta {
  let m = metaCache.get(id);
  if (!m) {
    const r = readTextureMeta(id);
    if (!r) throw new Error(`texture meta missing for ${id} — call ensureTextures() first`);
    m = r;
    metaCache.set(id, m);
  }
  return m;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function sceneContext(sc: Scenario): SceneCtx {
  const def = TEXTURES[sc.target];
  const m = meta(sc.target);
  const upm = 1 / def.mmPerPx;
  const lm = m.landmarks[sc.pin];
  if (!lm) throw new Error(`${sc.id}: landmark '${sc.pin}' not found on ${sc.target}`);
  const pin = {
    x: lm.x + (sc.pinOffsetMm?.[0] ?? 0) * upm,
    y: lm.y + (sc.pinOffsetMm?.[1] ?? 0) * upm,
  };
  const cm = (v: number) => v * 10 * upm;
  return { def, meta: m, pin, cm, at: (dx, dy) => ({ x: pin.x + cm(dx), y: pin.y + cm(dy) }) };
}

/** 시나리오 → 렌더러 장면 설정 */
export function buildScene(sc: Scenario, ctx: SceneCtx, color: boolean): SceneSetup {
  const def = ctx.def;
  const upm = 1 / def.mmPerPx;
  const seed = sc.seed ?? hashString(sc.id);
  const bgId = sc.background ?? def.background ?? "wall";
  const bgDef = TEXTURES[bgId];
  const target = loadTexture(sc.target, color);
  const bg = loadTexture(bgId, color);
  // 배경 평면: 대상 중심 근처에 배경 텍스처를 두되 시나리오마다 조금 다른 위치
  const sb = bgDef.mmPerPx / def.mmPerPx;
  const jx = ((seed & 0xff) / 255 - 0.5) * 0.3;
  const jy = (((seed >>> 8) & 0xff) / 255 - 0.5) * 0.3;
  const ox = def.width / 2 - sb * bgDef.width * (0.5 + jx);
  const oy = def.height / 2 - sb * bgDef.height * (0.5 + jy);
  const view = sc.view(ctx);
  const jit = sc.jitter === null ? null : new HandJitter(sc.jitter ?? DEFAULT_JITTER, upm, seed);
  const env = sc.jitterEnv;
  const stream = sc.stream ?? [480, 640];
  const ori = sc.orientation;
  const landscapeAt = (t: number) => !!ori && t >= ori.switchAt;
  const streamAt = (t: number): Intrinsics =>
    landscapeAt(t) ? intrinsics(stream[1], stream[0]) : intrinsics(stream[0], stream[1]);
  const rollExtra = (t: number) => {
    if (!ori) return 0;
    const phys = 90 * smootherstep((t - (ori.switchAt - ori.rotateSec)) / ori.rotateSec);
    return phys - (landscapeAt(t) ? 90 : 0);
  };
  const poseAt = (t: number): Pose => {
    const v = view(t);
    let j: JitterSample | null = jit ? jit.at(t) : null;
    if (j && env) {
      const e = env(t);
      j = { rx: j.rx * e, ry: j.ry * e, rz: j.rz * e, tx: j.tx * e, ty: j.ty * e, tz: j.tz * e };
    }
    const r = rollExtra(t);
    return poseFromView(r ? { ...v, roll: v.roll + r } : v, j);
  };
  const huntPhase = ((seed >>> 16) & 0xff) / 40;
  const photoAt = (t: number): PhotoParams => {
    const l = sc.light?.(t) ?? {};
    // 자동노출이 조금씩 흔들림 (±1.5%)
    const hunt = 1 + 0.015 * Math.sin((2 * Math.PI * t) / 3.7 + huntPhase);
    return {
      scene: l.scene ?? 1,
      gain: (l.gain ?? 1) * hunt,
      contrast: l.contrast ?? 1.05,
      brightness: l.brightness ?? 0,
    };
  };
  let hand: HandSetup | undefined;
  if (sc.hand) {
    const skin: [number, number, number] = [0.87, 0.67, 0.56];
    const luma = srgbToLinear(0.299 * skin[0] + 0.587 * skin[1] + 0.114 * skin[2]);
    hand = {
      heightUnits: sc.hand.heightMm * upm,
      unitsPerMm: upm,
      at: sc.hand.path(ctx),
      color: color ? [srgbToLinear(skin[0]), srgbToLinear(skin[1]), srgbToLinear(skin[2])] : [luma, luma, luma],
      shadow: 0.35,
    };
  }
  // 자동초점: 초점 거리(의 역수)가 실제 거리를 시상수 AF_LAG로 늦게 따라감 → 흐림 σ ∝ |1/d − 1/d_focus|
  const mmPer = def.mmPerPx;
  const invDist = (t: number) => 1 / Math.max(30, view(t).dist * mmPer);
  const focusSigma =
    sc.autofocus === false
      ? undefined
      : (t: number) => {
          let num = 0;
          let den = 0;
          for (let i = 0; i < 16; i++) {
            const lag = ((i + 0.5) / 16) * 4 * AF_LAG;
            const w = Math.exp(-lag / AF_LAG);
            num += w * invDist(t - lag);
            den += w;
          }
          const K = streamAt(t);
          return DEFOCUS_PX_PER_DIOPTER_MM * (Math.max(K.width, K.height) / 640) * Math.abs(invDist(t) - num / den);
        };
  const gl = def.gloss;
  const lp = sc.glossLightMm ?? [100, -500, -1500];
  const ld = [0.25, 0.45, 1];
  const ln = Math.hypot(ld[0], ld[1], ld[2]);
  return {
    target,
    bg,
    bgPlane: { z: (def.bgDepthMm ?? 0) * upm, affine: [sb, 0, ox, 0, sb, oy] },
    poseAt,
    streamAt,
    exposureMs: sc.exposureMs ?? 12,
    readoutMs: sc.readoutMs ?? 16,
    photoAt,
    noise: sc.noise ?? { shot: 0.0003, read: 0.002 },
    vignette: 0.28,
    opticalBlur: true,
    hand,
    gloss: gl
      ? {
          strength: gl.strength,
          sigma: gl.sigmaMm * upm,
          light: [def.width / 2 + lp[0] * upm, def.height / 2 + lp[1] * upm, lp[2] * upm],
        }
      : undefined,
    shadow: sc.shadow?.(ctx),
    lightDir: [ld[0] / ln, ld[1] / ln, ld[2] / ln],
    seed,
    focusSigma,
    flicker: sc.flicker,
  };
}

/**
 * 롤링 셔터를 반영한 평면 점의 스트림 좌표(가장자리 규약): 행 y는 t + (y/H - 0.5)·판독시간에 찍힌다.
 * 점이 찍힌 행과 그 행의 시각이 서로를 결정하므로 고정점 반복 (보통 2~3번이면 수렴).
 */
export function projectRS(scene: SceneSetup, t: number, p: Point): Point | null {
  const K = scene.streamAt(t);
  const ro = scene.readoutMs / 1000;
  let tau = t;
  let q: Point | null = null;
  for (let i = 0; i < 5; i++) {
    q = project(planeToImage(K, scene.poseAt(tau), 0, TARGET_AFFINE), p.x, p.y);
    if (!q || ro === 0) return q;
    const next = t + (q.y / K.height - 0.5) * ro;
    if (Math.abs(next - tau) < 1e-7) break;
    tau = next;
  }
  return q;
}

/** 처리 프레임 시각: 처리 클록(fps)이 돌 때마다 가장 최근 카메라 프레임(30fps)을 집는다 */
export function processTimes(sc: Scenario): { refTime: number; times: number[]; fps: number } {
  const refTime = Math.round(sc.refTime * CAMERA_FPS) / CAMERA_FPS;
  const fps = sc.fps ?? (sc.side === "engineer" ? 30 : 20);
  const t0 = sc.side === "engineer" ? refTime + 1 / CAMERA_FPS : refTime + (sc.latency ?? 0.3);
  const times: number[] = [];
  for (let k = 0; ; k++) {
    const tp = t0 + k / fps;
    if (tp > sc.duration + 1e-9) break;
    const tc = Math.floor(tp * CAMERA_FPS + 1e-6) / CAMERA_FPS;
    if (tc <= refTime + 1e-9) continue;
    if (times.length && tc <= times[times.length - 1] + 1e-9) continue;
    times.push(tc);
  }
  return { refTime, times, fps };
}

/**
 * 자동노출 목표 이득: 장면 평균 선형 휘도를 목표(AE_TARGET) 쪽으로 부분 보정 (폰 AE처럼 완전히는 아님).
 * 흰 벽은 조금 어둡게, 어두운 단말기·책상·어두운 방은 밝게(잡음도 함께 커짐).
 */
export const AE_TARGET = 0.24;
/** 자동노출 시상수 (초) — 밝은 곳↔어두운 곳을 훑을 때 밝기가 늦게 따라온다 */
export const AE_TAU = 0.45;
export function autoExposureGain(meanLinear: number): number {
  const g = Math.pow(AE_TARGET / Math.max(1e-3, meanLinear), 0.8);
  return Math.min(4, Math.max(0.3, g));
}
/** 자동초점 시상수 (초) */
export const AF_LAG = 0.45;
/** 초점 흐림 σ(640px 스트림 기준 px) / |1/d − 1/d_f| (1/mm) — 폰 메인 카메라(f≈4.2mm, f/1.8, 화소 ~10µm@640) 근사 */
export const DEFOCUS_PX_PER_DIOPTER_MM = 386;

/**
 * 엔지니어 쪽 영상 압축 품질: 프레임 사이 움직임이 크면 같은 비트레이트에서 화질이 떨어진다 (VP8/H.264 흉내).
 * q = base − 1.2·max(0, 움직임px − 3), 최소 18
 */
export function transportQuality(base: number, motionPx: number): number {
  return Math.round(Math.max(Math.min(base, 18), base - 1.2 * Math.max(0, motionPx - 3)));
}

export function buildSequence(sc: Scenario): Sequence {
  const ctx = sceneContext(sc);
  const scene = buildScene(sc, ctx, false);
  const blurMode = pipelineOptions.exactBlur ? "subframes" : "fast";
  const renderer = new CameraRenderer(scene, false, blurMode);
  let colorRenderer: CameraRenderer | null = null;
  const { refTime, times, fps } = processTimes(sc);
  // 동적 자동노출: 1/30초마다 측광 → 로그 이득을 시상수 AE_TAU로 따라감 (시작은 수렴 상태)
  {
    const dt = 1 / CAMERA_FPS;
    const n = Math.ceil((sc.duration + 0.2) / dt) + 1;
    const gains = new Float64Array(n);
    const a = 1 - Math.exp(-dt / AE_TAU);
    let lg = 0;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      const m = renderer.meterMean(t, 24, 32) * scene.photoAt(t).scene;
      const target = Math.log(autoExposureGain(m));
      lg = i === 0 ? target : lg + a * (target - lg);
      gains[i] = Math.exp(lg);
    }
    scene.ae = (t: number) => {
      const f = Math.min(n - 1, Math.max(0, t / dt));
      const i = Math.min(n - 2, Math.floor(f));
      return gains[i] + (gains[i + 1] - gains[i]) * (f - i);
    };
  }
  const transport = sc.transport === undefined ? DEFAULT_TRANSPORT : sc.transport;
  const side = sc.side;
  const pinPlane = ctx.pin;

  const planeToStream = (t: number) => planeToImage(scene.streamAt(t), scene.poseAt(t), 0, TARGET_AFFINE);

  /** 직전 카메라 프레임 대비 움직임 (스트림 px, 대상 평면 기준 최대) */
  const interframeMotion = (t: number): number => {
    const K = scene.streamAt(t);
    const H1 = planeToStream(t);
    const H0 = planeToImage(K, scene.poseAt(t - 1 / CAMERA_FPS), 0, TARGET_AFFINE);
    const inv = invertOrThrow(H1);
    let m = 0;
    for (const [x, y] of [
      [K.width / 2, K.height / 2],
      [0, 0],
      [K.width, 0],
      [0, K.height],
      [K.width, K.height],
    ]) {
      const q = project(inv, x, y);
      if (!q) continue;
      const a = project(H0, q.x, q.y);
      if (a) m = Math.max(m, Math.hypot(a.x - x, a.y - y));
    }
    return m;
  };
  const qualityAt = (t: number) => (transport ? transportQuality(transport.quality, interframeMotion(t)) : 100);
  /** 엔지니어 화면 = (축소) + JPEG 왕복 (움직임이 크면 품질↓) */
  const engineerView = (gray: Uint8Array, w: number, h: number, t: number) => {
    if (!transport) return { data: gray, width: w, height: h };
    const s = scaleBy(gray, w, h, transport.scale ?? 1);
    const codec = pipelineOptions.exactJpeg ? jpegRoundTripGray : jpegSimGray;
    return { data: codec(s.data, s.width, s.height, qualityAt(t)), width: s.width, height: s.height };
  };
  /** 영상 크기 사슬만 계산 (렌더 없이 GT용) */
  const engineerDims = (w: number, h: number): [number, number] => {
    const s = transport?.scale ?? 1;
    return s >= 1 ? [w, h] : [Math.max(16, Math.round(w * s)), Math.max(16, Math.round(h * s))];
  };
  const workDimsAt = (t: number, isRef: boolean): [number, number] => {
    const K = scene.streamAt(t);
    let [w, h] = [K.width, K.height];
    if (side === "engineer" || isRef) [w, h] = engineerDims(w, h);
    if (isRef && side === "customer") {
      const L = Math.max(w, h);
      if (L > REF_JPEG.maxLong) [w, h] = [Math.round((w * REF_JPEG.maxLong) / L), Math.round((h * REF_JPEG.maxLong) / L)];
    }
    return workDims(w, h);
  };
  const planeToWorkAt = (t: number, isRef: boolean): { M: Mat3; w: number; h: number } => {
    const K = scene.streamAt(t);
    const [ww, wh] = workDimsAt(t, isRef);
    return { M: mul3(streamToWork(K.width, K.height, ww, wh), planeToStream(t)), w: ww, h: wh };
  };

  const pinStream = (t: number): Point | null => projectRS(scene, t, pinPlane);
  const occludedAt = (t: number, p: Point): boolean => {
    const hand = scene.hand;
    if (!hand) return false;
    const hp = hand.at(t);
    if (!hp) return false;
    const Hh = planeToImage(scene.streamAt(t), scene.poseAt(t), -hand.heightUnits, handAffine(hp, hand.unitsPerMm));
    const inv = invertOrThrow(Hh);
    const q = project(inv, p.x, p.y);
    return !!q && handSdf(q.x, q.y) < 0;
  };
  const streamToWorkPt = (t: number, isRef: boolean, p: Point): Point => {
    const K = scene.streamAt(t);
    const [ww, wh] = workDimsAt(t, isRef);
    return { x: (p.x * ww) / K.width - 0.5, y: (p.y * wh) / K.height - 0.5 };
  };

  // 기준 이미지 — 처음 쓸 때 렌더 (캐시 확인·기준선 추적기는 필요 없음)
  const refP = planeToWorkAt(refTime, true);
  let refImg: GrayImage | null = null;
  const renderRef = (): GrayImage => {
    const refCam = renderer.render(refTime);
    const ev = engineerView(refCam.planes[0], refCam.width, refCam.height, refTime);
    let img: GrayImage;
    if (side === "engineer") {
      img = toWorking(ev.data, ev.width, ev.height);
    } else {
      const f = fitLongSide(ev.data, ev.width, ev.height, REF_JPEG.maxLong);
      const j = jpegRoundTripGray(f.data, f.width, f.height, REF_JPEG.quality);
      img = toWorking(j, f.width, f.height);
    }
    if (refP.w !== img.width || refP.h !== img.height) throw new Error(`${sc.id}: ref dims mismatch`);
    return img;
  };
  const pinRefS = pinStream(refTime);
  if (!pinRefS) throw new Error(`${sc.id}: pin behind camera at ref`);
  const pinRef = streamToWorkPt(refTime, true, pinRefS);
  if (pinRef.x < 0 || pinRef.y < 0 || pinRef.x > refP.w - 1 || pinRef.y > refP.h - 1) {
    throw new Error(`${sc.id}: pin not inside reference frame (${pinRef.x.toFixed(1)}, ${pinRef.y.toFixed(1)})`);
  }
  // ROI: 핀 중심, 한 변 0.5·min(w,h), 화면 안으로 자름
  const side2 = 0.5 * Math.min(refP.w, refP.h);
  const roi = clampRect({ x: pinRef.x - side2 / 2, y: pinRef.y - side2 / 2, width: side2, height: side2 }, refP.w, refP.h);
  const refInv = invertOrThrow(refP.M);

  // 프레임별 GT
  const G = 7;
  const gt: FrameGT[] = times.map((t, k) => {
    const P = planeToWorkAt(t, false);
    const H = mul3(P.M, refInv);
    const ps = pinStream(t);
    const pin = ps ? streamToWorkPt(t, false, ps) : null;
    let inFrame = false;
    let offscreenBy = Infinity;
    if (pin) {
      const dx = Math.max(-0.5 - pin.x, 0, pin.x - (P.w - 0.5));
      const dy = Math.max(-0.5 - pin.y, 0, pin.y - (P.h - 0.5));
      offscreenBy = Math.hypot(dx, dy);
      inFrame = offscreenBy === 0;
    }
    const occluded = !!ps && inFrame && occludedAt(t, ps);
    // ROI 가시 비율
    let vis = 0;
    const K = scene.streamAt(t);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const q = project(H, roi.x + ((i + 0.5) / G) * roi.width, roi.y + ((j + 0.5) / G) * roi.height);
        if (!q || q.x < -0.5 || q.y < -0.5 || q.x > P.w - 0.5 || q.y > P.h - 0.5) continue;
        if (scene.hand) {
          const s = { x: ((q.x + 0.5) * K.width) / P.w, y: ((q.y + 0.5) * K.height) / P.h };
          if (occludedAt(t, s)) continue;
        }
        vis++;
      }
    }
    return {
      k,
      t,
      width: P.w,
      height: P.h,
      H,
      planeToWork: P.M,
      pin,
      inFrame,
      offscreenBy,
      occluded,
      visible: inFrame && !occluded,
      roiVisible: vis / (G * G),
    };
  });

  return {
    scenario: sc,
    side,
    fps,
    seed: scene.seed,
    refTime,
    times,
    get ref(): GrayImage {
      if (!refImg) refImg = renderRef();
      return refImg;
    },
    roi,
    pinRef,
    pinPlane,
    initialH: side === "engineer" ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : undefined,
    refPlaneToWork: refP.M,
    gt,
    ctx,
    scene,
    renderFrame(k: number): GrayImage {
      const t = times[k];
      const cam = renderer.render(t);
      const g = cam.planes[0];
      let img: GrayImage;
      if (side === "engineer") {
        const ev = engineerView(g, cam.width, cam.height, t);
        img = toWorking(ev.data, ev.width, ev.height);
      } else {
        img = toWorking(g, cam.width, cam.height);
      }
      const want = gt[k];
      if (img.width !== want.width || img.height !== want.height) throw new Error(`${sc.id}: frame dims mismatch`);
      return img;
    },
    renderCamera(t: number, color = false): CameraFrame {
      if (!color) return renderer.render(t);
      if (!colorRenderer) {
        const cs = buildScene(sc, ctx, true);
        cs.ae = scene.ae;
        colorRenderer = new CameraRenderer(cs, true, blurMode);
      }
      return colorRenderer.render(t);
    },
    streamAt: scene.streamAt,
    planeToStream,
    pinStream,
    occludedAt,
    qualityAt,
  };
}
