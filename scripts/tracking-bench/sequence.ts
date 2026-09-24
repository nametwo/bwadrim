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
import { fitLongSide, jpegRoundTripGray, jpegSimGray, limitedToFull, scaleBy, toWorking, toWorkingLimited } from "./imageops";
import { IspPipeline, cameraIndex } from "./isp";
import { distort, lensFor, undistort } from "./lens";
import { type AreaLight, type CameraFrame, CameraRenderer, type HandSetup, type PhotoParams, type SceneSetup } from "./render";
import { type ReliefHit, buildReliefMap, heightAt, traceRelief } from "./relief";
import { BASE_RELIEF } from "./relief";
import { hashString, smootherstep } from "./rng";
import type { Scenario, SceneCtx, Side } from "./scenarios";
import { TEXTURES, type TextureMeta, loadTexture, readTextureMeta } from "./textures";
import { fitHomography } from "./dlt";
import { type CodecCapture, codecKey, codecRange, loadCodecCapture } from "./codec-cache";
import { BASE_SOURCES, REALISM_SOURCES, probeRealism, probeScene, sourceHash } from "./codehash";

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
  /** 기준 이미지 (처음 읽을 때 렌더 — 캐시된 것을 쓰려면 framecache.cachedRef) */
  ref: GrayImage;
  /** 캐시에서 읽은 기준 이미지를 넣는다 (크기가 맞을 때만, 이후 ref가 이것을 돌려준다) */
  provideRef(img: GrayImage): void;
  /** 기준 이미지를 이미 렌더했거나 받았는지 */
  hasRef(): boolean;
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
  /** 핀의 3D 높이 (평면 단위, 부조 윗면이면 +) — 실감 시나리오 */
  pinZ: number;
  /** 실제 코덱 캡처 (실감 codec 시나리오, 캐시에 있을 때) */
  codec: CodecCapture | null;
  /** 카메라 프레임 i(30fps)의 ISP 출력까지 (코덱 캡처 입력용, 스트림 해상도) */
  renderCameraIndex(i: number, color: boolean): CameraFrame;
  /** 코덱 캡처 키 (codec 시나리오만, 아니면 "") */
  codecKey: string;
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
  const real = sc.realism;
  let realStreamAt = streamAt;
  let realFocus = focusSigma;
  if (real?.af && sc.autofocus !== false) {
    // 초점 = 거리 역수를 AF_LAG로 늦게 따라감 + 헌팅. 흐림 σ ∝ |1/d − 1/d_f|, 호흡: 화각 배율 ∝ (1 + F/d_f)
    const hunts = real.af.hunts ?? [];
    const invFocus = (t: number) => {
      let num = 0;
      let den = 0;
      for (let i = 0; i < 16; i++) {
        const lag = ((i + 0.5) / 16) * 4 * AF_LAG;
        const w = Math.exp(-lag / AF_LAG);
        num += w * invDist(t - lag);
        den += w;
      }
      let f = num / den;
      for (const h of hunts) {
        const u = (t - h.t) / h.dur;
        if (u > 0 && u < 1) f += (h.diopters / 1000) * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * u);
      }
      return Math.max(0, f);
    };
    realFocus = (t: number) => {
      const K = streamAt(t);
      return DEFOCUS_PX_PER_DIOPTER_MM * (Math.max(K.width, K.height) / 640) * Math.abs(invDist(t) - invFocus(t));
    };
    if (real.af.breathing) {
      const ref = 1 + LENS_FOCAL_MM / BREATHING_REF_MM;
      realStreamAt = (t: number) => {
        const K = streamAt(t);
        return { ...K, f: (K.f * (1 + LENS_FOCAL_MM * invFocus(t))) / ref };
      };
    }
  }
  let area: AreaLight | undefined;
  if (real?.area) {
    const a = real.area;
    area = {
      x: def.width / 2 + a.x * upm,
      y: def.height / 2 + a.y * upm,
      dist: a.dist * upm,
      w: a.w * upm,
      h: a.h * upm,
      angle: a.angle ?? 0,
      strength: a.strength,
      blur: Math.max(1, a.blurMm * upm),
    };
  }
  const reliefBoxes = real?.relief ? (ctx.meta.relief ?? BASE_RELIEF[sc.target as keyof typeof BASE_RELIEF]?.() ?? []) : [];
  const relief =
    reliefBoxes.length > 0
      ? buildReliefMap(sc.target, reliefBoxes, def.width, def.height, upm, typeof real?.relief === "number" ? real.relief : 1)
      : undefined;
  return {
    target,
    bg,
    bgPlane: { z: (def.bgDepthMm ?? 0) * upm, affine: [sb, 0, ox, 0, sb, oy] },
    poseAt,
    streamAt: realStreamAt,
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
    focusSigma: realFocus,
    flicker: sc.flicker,
    lens: real?.lens,
    relief,
    area,
    ispTone: real?.isp?.tone,
  };
}

/**
 * 롤링 셔터를 반영한 평면 점의 스트림 좌표(가장자리 규약): 행 y는 t + (y/H - 0.5)·판독시간에 찍힌다.
 * 점이 찍힌 행과 그 행의 시각이 서로를 결정하므로 고정점 반복 (보통 2~3번이면 수렴).
 */
export function projectRS(scene: SceneSetup, t: number, p: Point, z = 0): Point | null {
  const K = scene.streamAt(t);
  const ro = scene.readoutMs / 1000;
  const L = scene.lens ? lensFor(scene.lens, K.width, K.height) : null;
  let tau = t;
  let q: Point | null = null;
  for (let i = 0; i < (L ? 8 : 5); i++) {
    q = project(planeToImage(K, scene.poseAt(tau), z, TARGET_AFFINE), p.x, p.y);
    if (q && L) q = distort(L, q.x, q.y);
    if (!q || ro === 0) return q;
    const next = t + (q.y / K.height - 0.5) * ro;
    if (Math.abs(next - tau) < 1e-7) break;
    tau = next;
  }
  return q;
}

/**
 * 센서 점(가장자리 규약) → 평면 Z=z 위의 점. 롤링 셔터: 센서 행이 곧 시각이라 반복 없이 정확하다.
 */
export function unprojectRS(scene: SceneSetup, t: number, s: Point, z = 0): Point | null {
  const K = scene.streamAt(t);
  const tau = t + (s.y / K.height - 0.5) * (scene.readoutMs / 1000);
  const q = scene.lens ? undistort(lensFor(scene.lens, K.width, K.height), s.x, s.y) : s;
  const Hm = planeToImage(K, scene.poseAt(tau), z, TARGET_AFFINE);
  const inv = invertOrThrow(Hm);
  return project(inv, q.x, q.y);
}

/**
 * 평면 점 (x, y, 높이 z=−h)이 부조에 가려지는지 (시각 t, 센서 점 s에서 본 첫 표면이 그 점이 아니면 가려짐).
 */
export function hiddenByRelief(scene: SceneSetup, t: number, s: Point, p: Point, z: number): boolean {
  const R = scene.relief;
  if (!R) return false;
  const K = scene.streamAt(t);
  const tau = t + (s.y / K.height - 0.5) * (scene.readoutMs / 1000);
  const q = scene.lens ? undistort(lensFor(scene.lens, K.width, K.height), s.x, s.y) : s;
  const pose = scene.poseAt(tau);
  const d = [(q.x - K.cx) / K.f, (q.y - K.cy) / K.f, 1];
  const Rm = pose.R; // 월드→카메라, 광선 = Rᵀ·d
  const dx = Rm[0] * d[0] + Rm[3] * d[1] + Rm[6] * d[2];
  const dy = Rm[1] * d[0] + Rm[4] * d[1] + Rm[7] * d[2];
  const dz = Rm[2] * d[0] + Rm[5] * d[1] + Rm[8] * d[2];
  const hit: ReliefHit = { u: 0, v: 0, z: 0, wall: false };
  if (!traceRelief(R, pose.C[0], pose.C[1], pose.C[2], dx, dy, dz, hit)) return false;
  return hit.wall || Math.abs(hit.z - z) > 0.3 * Math.max(1, R.hMax / 6) || Math.hypot(hit.u - p.x, hit.v - p.y) > 3;
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
/** 초점 호흡: 상 거리 v ≈ f·(1 + f/d_f) → 화각 배율 (1 + F/d_f). 폰 메인 카메라 실제 초점거리(mm) */
export const LENS_FOCAL_MM = 4.2;
/** 호흡 배율 1이 되는 초점 거리 (mm) — 기본 화각(65°)은 이 거리에 초점이 맞았을 때 */
export const BREATHING_REF_MM = 250;

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
  const real = sc.realism;
  const nominal = processTimes(sc);
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
  // 실제 코덱: 원본(ISP까지) 프레임 지문 → 캡처 키 → 캐시에 있으면 그 디코드 결과를 쓴다
  let codecKeyStr = "";
  let codec: CodecCapture | null = null;
  if (real?.codec) {
    codecKeyStr = codecKey(codecSourceFingerprint(sc, scene), real.codec);
    codec = loadCodecCapture(sc.id, codecKeyStr);
  }
  const transport = real?.codec ? null : sc.transport === undefined ? DEFAULT_TRANSPORT : sc.transport;
  const side = sc.side;
  // 엔지니어 쪽 코덱: 처리 프레임 = 실제로 디코드되어 화면에 나온 프레임, 기준 = 탭 순간 화면의 (마지막으로 받은) 프레임
  let refTime = nominal.refTime;
  let times = nominal.times;
  const fps = nominal.fps;
  if (codec) {
    const refIdx = Math.round(refTime * CAMERA_FPS);
    const got = codec.indices;
    const r = [...got].reverse().find((i) => i <= refIdx);
    if (r !== undefined) refTime = r / CAMERA_FPS;
    if (side === "engineer") times = got.filter((i) => i > r! && i / CAMERA_FPS <= sc.duration + 1e-9).map((i) => i / CAMERA_FPS);
    else times = processTimes({ ...sc, refTime }).times;
  }
  const pinPlane = ctx.pin;
  // 부조: 핀은 그 자리 윗면(또는 바닥)에 있다
  const pinZ = scene.relief ? -heightAt(scene.relief, pinPlane.x, pinPlane.y) : 0;
  const lensOn = !!scene.lens;

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
    const codecFn = pipelineOptions.exactJpeg ? jpegRoundTripGray : jpegSimGray;
    return { data: codecFn(s.data, s.width, s.height, qualityAt(t)), width: s.width, height: s.height };
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

  const pinStream = (t: number): Point | null => projectRS(scene, t, pinPlane, pinZ);
  const occludedAt = (t: number, p: Point): boolean => {
    const hand = scene.hand;
    if (!hand) return false;
    const hp = hand.at(t);
    if (!hp) return false;
    const K = scene.streamAt(t);
    const q = lensOn ? undistort(lensFor(scene.lens!, K.width, K.height), p.x, p.y) : p;
    const Hh = planeToImage(K, scene.poseAt(t), -hand.heightUnits, handAffine(hp, hand.unitsPerMm));
    const inv = invertOrThrow(Hh);
    const r = project(inv, q.x, q.y);
    return !!r && handSdf(r.x, r.y) < 0;
  };
  const streamToWorkPt = (t: number, isRef: boolean, p: Point): Point => {
    const K = scene.streamAt(t);
    const [ww, wh] = workDimsAt(t, isRef);
    return { x: (p.x * ww) / K.width - 0.5, y: (p.y * wh) / K.height - 0.5 };
  };
  const workToStreamPt = (t: number, isRef: boolean, p: Point): Point => {
    const K = scene.streamAt(t);
    const [ww, wh] = workDimsAt(t, isRef);
    return { x: ((p.x + 0.5) * K.width) / ww, y: ((p.y + 0.5) * K.height) / wh };
  };

  // ISP (TNR·샤프닝): 카메라 프레임 번호 단위. 없으면 렌더 그대로
  const ispSpec = real?.isp && (real.isp.tnr || real.isp.sharpen) ? real.isp : null;
  const isp = ispSpec ? new IspPipeline(ispSpec, (i) => renderer.render(i / CAMERA_FPS)) : null;
  let colorIsp: IspPipeline | null = null;
  const getColorRenderer = (): CameraRenderer => {
    if (!colorRenderer) {
      const cs = buildScene(sc, ctx, true);
      cs.ae = scene.ae;
      colorRenderer = new CameraRenderer(cs, true, blurMode);
    }
    return colorRenderer;
  };
  const cameraGray = (t: number): CameraFrame => (isp ? isp.frame(cameraIndex(t, CAMERA_FPS)) : renderer.render(t));
  const renderCameraIndex = (i: number, color: boolean): CameraFrame => {
    if (!color) return isp ? isp.frame(i) : renderer.render(i / CAMERA_FPS);
    const cr = getColorRenderer();
    if (!ispSpec) return cr.render(i / CAMERA_FPS);
    if (!colorIsp) colorIsp = new IspPipeline(ispSpec, (j) => cr.render(j / CAMERA_FPS));
    return colorIsp.frame(i);
  };
  const codecFrame = (t: number): GrayImage => {
    const i = Math.round(t * CAMERA_FPS);
    const f = codec?.frame(i);
    if (!f) throw new Error(`${sc.id}: 코덱 캡처에 프레임 ${i}가 없습니다 (npm run bench:tracking -- --scenario=${sc.id}로 캡처)`);
    return f;
  };

  // 기준 이미지 — 처음 쓸 때 렌더 (캐시 확인·기준선 추적기는 필요 없음)
  const refP = planeToWorkAt(refTime, true);
  let refImg: GrayImage | null = null;
  const renderRef = (): GrayImage => {
    let ev: { data: Uint8Array; width: number; height: number };
    // 코덱 캡처는 디코더 Y 평면(16~235). 엔지니어 추적은 런타임처럼 리샘플과 범위 변환을 한 번에,
    // 고객에게 보내는 기준 이미지는 캔버스(YUV→RGB, 전체 범위)에서 만들어지므로 먼저 전체 범위로.
    let limited = false;
    if (real?.codec) {
      const f = codecFrame(refTime);
      limited = side === "engineer";
      ev = { data: limited ? (f.data as Uint8Array) : limitedToFull(f.data as Uint8Array), width: f.width, height: f.height };
    } else {
      const refCam = cameraGray(refTime);
      ev = engineerView(refCam.planes[0], refCam.width, refCam.height, refTime);
    }
    let img: GrayImage;
    if (side === "engineer") {
      img = limited ? toWorkingLimited(ev.data, ev.width, ev.height) : toWorking(ev.data, ev.width, ev.height);
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

  // 렌즈 왜곡이 있으면 ref→프레임이 호모그래피가 아니다: ROI 격자(대상 평면 Z=0)를 정확한 모델로 옮겨
  // 가장 잘 맞는 H를 정답 H로 (핀은 따로 정확히). 롤링 셔터도 점마다 정확히.
  const G = 7;
  const GF = 9;
  let roiPlane: (Point | null)[] | null = null;
  let fitPlane: { ref: Point; plane: Point }[] | null = null;
  if (lensOn) {
    roiPlane = [];
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const w = { x: roi.x + ((i + 0.5) / G) * roi.width, y: roi.y + ((j + 0.5) / G) * roi.height };
        roiPlane.push(unprojectRS(scene, refTime, workToStreamPt(refTime, true, w), 0));
      }
    }
    fitPlane = [];
    for (let j = 0; j < GF; j++) {
      for (let i = 0; i < GF; i++) {
        const w = { x: roi.x + (i / (GF - 1)) * roi.width, y: roi.y + (j / (GF - 1)) * roi.height };
        const pl = unprojectRS(scene, refTime, workToStreamPt(refTime, true, w), 0);
        if (pl) fitPlane.push({ ref: w, plane: pl });
      }
    }
  }

  // 프레임별 GT
  const gt: FrameGT[] = times.map((t, k) => {
    const P = planeToWorkAt(t, false);
    let H = mul3(P.M, refInv);
    if (fitPlane) {
      const src: Point[] = [];
      const dst: Point[] = [];
      for (const f of fitPlane) {
        const s = projectRS(scene, t, f.plane, 0);
        if (!s) continue;
        src.push(f.ref);
        dst.push(streamToWorkPt(t, false, s));
      }
      const Hf = src.length >= 8 ? fitHomography(src, dst) : null;
      if (Hf) H = Hf;
    }
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
    const occluded =
      !!ps && inFrame && (occludedAt(t, ps) || (!!scene.relief && hiddenByRelief(scene, t, ps, pinPlane, pinZ)));
    // ROI 가시 비율
    let vis = 0;
    const K = scene.streamAt(t);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        let q: Point | null;
        if (roiPlane) {
          const pl = roiPlane[j * G + i];
          const s = pl ? projectRS(scene, t, pl, 0) : null;
          q = s ? streamToWorkPt(t, false, s) : null;
        } else {
          q = project(H, roi.x + ((i + 0.5) / G) * roi.width, roi.y + ((j + 0.5) / G) * roi.height);
        }
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
    provideRef(img: GrayImage): void {
      if (img.width === refP.w && img.height === refP.h && img.data.length === refP.w * refP.h) refImg = img;
    },
    hasRef: () => refImg !== null,
    roi,
    pinRef,
    pinPlane,
    pinZ,
    initialH: side === "engineer" ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : undefined,
    refPlaneToWork: refP.M,
    gt,
    ctx,
    scene,
    codec,
    codecKey: codecKeyStr,
    renderFrame(k: number): GrayImage {
      const t = times[k];
      let img: GrayImage;
      if (side === "engineer" && real?.codec) {
        const f = codecFrame(t);
        img = toWorkingLimited(f.data as Uint8Array, f.width, f.height);
      } else {
        const cam = cameraGray(t);
        const g = cam.planes[0];
        if (side === "engineer") {
          const ev = engineerView(g, cam.width, cam.height, t);
          img = toWorking(ev.data, ev.width, ev.height);
        } else {
          img = toWorking(g, cam.width, cam.height);
        }
      }
      const want = gt[k];
      if (img.width !== want.width || img.height !== want.height) throw new Error(`${sc.id}: frame dims mismatch`);
      return img;
    },
    renderCamera(t: number, color = false): CameraFrame {
      if (real) return renderCameraIndex(cameraIndex(t, CAMERA_FPS), color);
      if (!color) return renderer.render(t);
      return getColorRenderer().render(t);
    },
    renderCameraIndex,
    streamAt: scene.streamAt,
    planeToStream,
    pinStream,
    occludedAt,
    qualityAt,
  };
}

/** 코덱 캡처 원본(엔지니어에게 가는 고객 카메라 영상, ISP 포함)의 지문 — 앞 구간부터 끝까지 30fps */
function codecSourceFingerprint(sc: Scenario, scene: SceneSetup): string {
  const parts: (string | number)[] = [
    sourceHash([...BASE_SOURCES, ...REALISM_SOURCES]),
    sc.id,
    sc.target,
    sc.pin,
    JSON.stringify({ ...sc.realism, codec: undefined }),
    scene.exposureMs,
    scene.readoutMs,
    JSON.stringify(scene.noise),
    scene.seed,
    JSON.stringify(scene.flicker ?? null),
    readTextureMeta(sc.target)?.hash ?? "?",
    readTextureMeta(sc.background ?? TEXTURES[sc.target].background ?? "wall")?.hash ?? "?",
  ];
  const [i0, i1] = codecRange(sc, CAMERA_FPS);
  for (let i = i0; i <= i1; i++) {
    probeScene(scene, i / CAMERA_FPS, parts, 100);
    probeRealism(scene, i / CAMERA_FPS, parts);
  }
  return hashString(parts.join(",")).toString(16).padStart(8, "0");
}
