import type { GrayImage, Mat3, Point, Rect } from "../../types";
import { Rng } from "../rng";
import {
  exposure,
  gaussianBlur,
  intrinsics,
  makeTexture,
  orbitPose,
  projectWorld,
  renderCamera,
  unsharpMask,
  type Intrinsics,
  type Pose3,
  type ReliefScene,
} from "./synth";

// 강건성 시나리오 (테스트·실험 전용): 3D 카메라로 렌더한 시퀀스 + 프레임별 정답 핀.
// 벤치(scripts/tracking-bench)가 다루지 않는 것 — 렌즈 왜곡, 돌출(시차), ISP 샤프닝, 강한 모션 블러,
// 초점 흐림, 저조도 잡음, 노출 급변 — 을 겨냥한다. 라이브러리 코드는 import하지 않는다.
//
// 월드 단위 = 0.25mm (텍스처 1px). 카메라는 320×240 작업 해상도, 가로 화각 65°(f ≈ 251px), 거리 ~12~15cm.

export const RW = 320;
export const RH = 240;
/** 월드 단위당 mm */
export const MM_PER_UNIT = 0.25;

export interface RobustSeq {
  name: string;
  ref: GrayImage;
  roi: Rect;
  /** ref 픽셀 좌표의 핀 (= setReference anchor) */
  pinRef: Point;
  /** 엔지니어 쪽이면 단위행렬 */
  initialH?: Mat3;
  frames: GrayImage[];
  /** 프레임별 핀 정답 (카메라 뒤면 null) */
  pins: (Point | null)[];
  times: number[];
}

export interface RobustSpec {
  name: string;
  scene: ReliefScene;
  /** 핀 (월드, z = 돌출이면 −height) */
  pin: { x: number; y: number; z: number };
  /** 시각 t(프레임 번호, 실수 가능)의 카메라 자세 */
  pose: (t: number) => Pose3;
  n: number;
  /** 기준 프레임 시각 */
  refT?: number;
  /** 엔지니어 쪽(initialH = I) */
  engineer: boolean;
  k1?: number;
  /** 노출 시간 / 프레임 간격 (모션 블러, 0 = 없음) */
  exposureFrac?: number;
  /** 블러 서브 자세 수 */
  blurSamples?: number;
  supersample?: number;
  /** 프레임 후처리 (ISP·광학·노출). rng는 시퀀스 고정 */
  post?: (img: GrayImage, t: number, rng: Rng) => GrayImage;
  /** 기준 이미지 후처리 (다른 ISP·압축 등). t = refT */
  refPost?: (img: GrayImage, t: number, rng: Rng) => GrayImage;
  noise?: number;
  /** ROI 한 변 (기본 0.5·min(w,h), 벤치와 같음) */
  roiSize?: number;
  fps?: number;
  seed?: number;
}

const K: Intrinsics = intrinsics(RW, RH, 65);

export function robustIntrinsics(): Intrinsics {
  return K;
}

function blurPoses(spec: RobustSpec, t: number): Pose3[] {
  const e = spec.exposureFrac ?? 0;
  const ns = spec.blurSamples ?? 1;
  if (!(e > 0) || ns <= 1) return [spec.pose(t)];
  const out: Pose3[] = [];
  for (let i = 0; i < ns; i++) out.push(spec.pose(t + e * ((i + 0.5) / ns - 0.5)));
  return out;
}

export function buildRobustSeq(spec: RobustSpec): RobustSeq {
  const rng = new Rng(spec.seed ?? 99);
  const k1 = spec.k1 ?? 0;
  const ss = spec.supersample ?? 2;
  const noise = spec.noise ?? 2;
  const refT = spec.refT ?? 0;
  const fps = spec.fps ?? 30;
  let ref = renderCamera(spec.scene, K, blurPoses(spec, refT), { supersample: ss, k1, noise, rng });
  if (spec.refPost) ref = spec.refPost(ref, refT, rng);
  const pinRef = projectWorld(K, spec.pose(refT), spec.pin, k1);
  if (!pinRef) throw new Error("pin behind reference camera");
  const s = spec.roiSize ?? 0.5 * Math.min(RW, RH);
  const roi = { x: pinRef.x - s / 2, y: pinRef.y - s / 2, width: s, height: s };
  const frames: GrayImage[] = [];
  const pins: (Point | null)[] = [];
  const times: number[] = [];
  for (let t = 0; t < spec.n; t++) {
    let f = renderCamera(spec.scene, K, blurPoses(spec, t), { supersample: blurPoses(spec, t).length > 1 ? 1 : ss, k1, noise, rng });
    if (spec.post) f = spec.post(f, t, rng);
    frames.push(f);
    pins.push(projectWorld(K, spec.pose(t), spec.pin, k1));
    times.push((t * 1000) / fps);
  }
  return {
    name: spec.name,
    ref,
    roi,
    pinRef,
    initialH: spec.engineer ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : undefined,
    frames,
    pins,
    times,
  };
}

// ───────────────────────── 장면 ─────────────────────────

let cachedPlanar: ReliefScene | null = null;
let cachedKeypad: ReliefScene | null = null;

/** 평면 대상 (바닥만): 죽은 잎 텍스처 1200×900 */
export function planarScene(): ReliefScene {
  if (!cachedPlanar) cachedPlanar = { base: makeTexture(1200, 900, 71, { contrast: 0.9 }), keys: [], height: 0 };
  return cachedPlanar;
}

/**
 * 키패드: 무늬가 약한 판(바닥) 위에 4×3 키가 돌출. 키 윗면에 글자 같은 작은 무늬.
 * height는 월드 단위 (0.25mm) — 8 = 2mm, 24 = 6mm.
 */
export function keypadScene(height: number): ReliefScene {
  if (!cachedKeypad) {
    const base = makeTexture(1200, 900, 72, { contrast: 0.45, bgAmplitude: 25, shapes: 500, maxSize: 30 });
    const top = makeTexture(1200, 900, 73, { contrast: 1, minSize: 3, maxSize: 14, shapes: 2600, bgAmplitude: 10, bgLevel: 150 });
    const keys: ReliefScene["keys"] = [];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 4; i++) keys.push({ x: 380 + i * 115, y: 330 + j * 95, width: 90, height: 72 });
    }
    cachedKeypad = { base, top, keys, height: 0, wall: 55 };
  }
  return { ...cachedKeypad, height };
}

/** 부드러운 궤적: 키프레임 선형 보간 + 사인 가감속 */
export function keyframes(ks: { t: number; v: number[] }[]): (t: number) => number[] {
  return (t: number) => {
    if (t <= ks[0].t) return ks[0].v;
    for (let i = 0; i + 1 < ks.length; i++) {
      const a = ks[i];
      const b = ks[i + 1];
      if (t <= b.t) {
        let u = (t - a.t) / (b.t - a.t);
        u = 0.5 - 0.5 * Math.cos(Math.PI * u);
        return a.v.map((x, k) => x + (b.v[k] - x) * u);
      }
    }
    return ks[ks.length - 1].v;
  };
}

/** (lookX, lookY, dist, yaw°, pitch°, roll°) 궤적 → 자세 */
export function orbitPath(ks: { t: number; v: number[] }[]): (t: number) => Pose3 {
  const f = keyframes(ks);
  const d = Math.PI / 180;
  return (t: number) => {
    const [x, y, dist, yaw, pitch, roll] = f(t);
    return orbitPose({ x, y }, dist, yaw * d, pitch * d, roll * d);
  };
}

// ───────────────────────── 후처리 조합 ─────────────────────────

export const post = {
  sharpen:
    (amount: number, sigma: number) =>
    (img: GrayImage): GrayImage =>
      unsharpMask(img, amount, sigma),
  defocus:
    (sigmaAt: (t: number) => number) =>
    (img: GrayImage, t: number): GrayImage =>
      gaussianBlur(img, sigmaAt(t)),
  /** 저조도: 센서에 gain만큼만 빛 → 잡음 → 8비트 양자화 → 디지털 이득 1/gain (잡음·계단 증폭) */
  lowLight:
    (gain: number, readNoise: number) =>
    (img: GrayImage, _t: number, rng: Rng): GrayImage =>
      exposure(exposure(img, gain, 0, readNoise, rng), 1 / gain, 0, 0, rng),
  /** 자동노출 급변: 프레임 구간마다 이득이 바뀜 (포화 포함) */
  exposureJumps:
    (gains: number[], every: number) =>
    (img: GrayImage, t: number, rng: Rng): GrayImage =>
      exposure(img, gains[Math.floor(t / every) % gains.length], 0, 0, rng),
};

// ───────────────────────── 시나리오 목록 (테스트·실험 공용) ─────────────────────────

export interface RobustCase {
  spec: RobustSpec;
  /** 핀이 보이는 프레임 중 올바르게 표시해야 하는 최소 비율 */
  minRate: number;
}

const tri = (t: number, a: number, b: number) => Math.max(0, 1 - Math.abs(t - (a + b) / 2) / ((b - a) / 2));
const DEG = Math.PI / 180;

/** 강건성 시나리오 (틀린 표시 0이 목표, minRate는 "숨기기만 해서 통과"를 막는 하한) */
export function robustCases(): RobustCase[] {
  const P = planarScene();
  const pin0 = { x: 600, y: 450, z: 0 };
  const cases: RobustCase[] = [];
  const add = (minRate: number, spec: RobustSpec) => cases.push({ minRate, spec });
  // ── 렌즈 왜곡: 핀이 중앙 → 모서리로 (왜곡이 가장 큰 곳), 기울임 동반
  add(0.95, {
    name: "lens barrel k1=-0.15, pin sweeps to the corner (engineer)",
    scene: P, pin: pin0, engineer: true, k1: -0.15, n: 50,
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 25, v: [840, 610, 520, 15, -10, 5] }, { t: 50, v: [380, 300, 500, -15, 10, -5] }]),
  });
  add(0.95, {
    name: "lens pincushion k1=+0.1 (engineer)",
    scene: P, pin: pin0, engineer: true, k1: 0.1, n: 50,
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 25, v: [840, 610, 520, 15, -10, 5] }, { t: 50, v: [380, 300, 500, -15, 10, -5] }]),
  });
  add(0.9, {
    name: "lens barrel k1=-0.15, customer finds the pin near the corner",
    scene: P, pin: pin0, engineer: false, k1: -0.15, n: 26,
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 5, v: [860, 640, 520, 12, -8, 8] }, { t: 26, v: [880, 650, 500, 15, -10, 10] }]),
  });
  // ── 돌출(시차): 4×3 키가 2~6mm 튀어나온 키패드
  add(0.95, {
    name: "keys 2mm, pin on a key top, ±25° (engineer)",
    scene: keypadScene(8), pin: { x: 540, y: 461, z: -8 }, engineer: true, n: 50,
    pose: orbitPath([{ t: 0, v: [560, 460, 480, -25, 0, 0] }, { t: 25, v: [560, 460, 480, 25, 15, 0] }, { t: 50, v: [600, 480, 460, 20, -20, 10] }]),
  });
  add(0.95, {
    name: "keys 6mm, pin on a key top, ±40° (engineer)",
    scene: keypadScene(24), pin: { x: 540, y: 461, z: -24 }, engineer: true, n: 50,
    pose: orbitPath([{ t: 0, v: [560, 460, 460, -40, 0, 0] }, { t: 25, v: [560, 460, 460, 40, 20, 0] }, { t: 50, v: [600, 480, 440, -30, -25, 10] }]),
  });
  add(0.9, {
    name: "keys 2mm, pin on the base between keys, ±25° (engineer)",
    scene: keypadScene(8), pin: { x: 597, y: 461, z: 0 }, engineer: true, n: 50,
    pose: orbitPath([{ t: 0, v: [600, 460, 480, -25, 10, 0] }, { t: 25, v: [600, 460, 480, 25, -15, 0] }, { t: 50, v: [600, 480, 460, -20, 20, 10] }]),
  });
  // 6mm 틈: 기준과 반대쪽으로 기울면 시차가 8px를 넘는다 → 그 구간은 숨겨야 한다
  add(0.3, {
    name: "keys 6mm, pin on the base between keys, ±25° (engineer; parallax > 8px must hide)",
    scene: keypadScene(24), pin: { x: 597, y: 461, z: 0 }, engineer: true, n: 50,
    pose: orbitPath([{ t: 0, v: [600, 460, 480, -25, 10, 0] }, { t: 25, v: [600, 460, 480, 25, -15, 0] }, { t: 50, v: [600, 480, 460, -20, 20, 10] }]),
  });
  add(0.9, {
    name: "keys 2mm, pin on a key top (customer)",
    scene: keypadScene(8), pin: { x: 655, y: 366, z: -8 }, engineer: false, n: 30,
    pose: orbitPath([{ t: 0, v: [650, 380, 480, 0, 0, 0] }, { t: 6, v: [650, 380, 470, 28, 10, 0] }, { t: 30, v: [620, 400, 470, -28, -12, 5] }]),
  });
  add(0.5, {
    name: "keys 6mm, pin on a key top, customer 28° off the reference view",
    scene: keypadScene(24), pin: { x: 655, y: 366, z: -24 }, engineer: false, n: 36,
    pose: orbitPath([{ t: 0, v: [650, 380, 480, 0, 0, 0] }, { t: 6, v: [650, 380, 470, 28, 10, 0] }, { t: 36, v: [620, 400, 470, -28, -12, 5] }]),
  });
  // ── ISP 샤프닝 후광 (+잡음), 기준은 다른 ISP
  add(0.95, {
    name: "ISP sharpening x3 halos + noise (engineer)",
    scene: P, pin: pin0, engineer: true, n: 40,
    post: (img, t, rng) => post.lowLight(0.5, 2)(post.sharpen(3, 1.5)(img), t, rng),
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 20, v: [700, 500, 450, 10, 10, 20] }, { t: 40, v: [520, 420, 560, -10, -5, -10] }]),
  });
  add(0.9, {
    name: "ISP sharpening, reference from another ISP (customer)",
    scene: P, pin: pin0, engineer: false, n: 30, post: post.sharpen(1.5, 1.2), refPost: post.sharpen(0.4, 0.8),
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 30, v: [680, 500, 450, 15, 10, 20] }]),
  });
  // ── 모션 블러 (노출 중 자세 평균)
  add(0.95, {
    name: "motion blur shake ~15px (engineer)",
    scene: P, pin: pin0, engineer: true, n: 50, exposureFrac: 0.7, blurSamples: 9,
    pose: (t) => {
      const a = t < 4 ? 0 : 1;
      return orbitPose(
        { x: 600 + a * 130 * Math.sin((2 * Math.PI * (t - 4)) / 18), y: 450 + a * 50 * Math.sin((2 * Math.PI * (t - 4)) / 11) },
        520, a * 6 * Math.sin(t / 3) * DEG, 0, a * 4 * Math.sin(t / 5) * DEG,
      );
    },
  });
  add(0.15, {
    name: "severe shake, blur up to ~30px (engineer; mostly hidden)",
    scene: P, pin: pin0, engineer: true, n: 50, exposureFrac: 0.8, blurSamples: 11,
    pose: (t) => {
      const a = t < 4 ? 0 : 1;
      return orbitPose(
        { x: 600 + a * 160 * Math.sin((2 * Math.PI * (t - 4)) / 10), y: 450 + a * 70 * Math.sin((2 * Math.PI * (t - 4)) / 7) },
        520, a * 10 * Math.sin(t / 2) * DEG, a * 6 * Math.sin(t / 1.7) * DEG, a * 8 * Math.sin(t / 2.5) * DEG,
      );
    },
  });
  add(0.1, {
    name: "severe shake (customer)",
    scene: P, pin: pin0, engineer: false, n: 36, exposureFrac: 0.8, blurSamples: 11,
    pose: (t) =>
      orbitPose(
        { x: 600 + 120 * Math.sin((2 * Math.PI * t) / 9), y: 450 + 60 * Math.sin((2 * Math.PI * t) / 7) },
        520, 8 * Math.sin(t / 2) * DEG, 0, 6 * Math.sin(t / 2.5) * DEG,
      ),
  });
  // ── 초점 흐림 (자동초점 헤맴)
  add(0.95, {
    name: "defocus hunting up to sigma 5px (engineer)",
    scene: P, pin: pin0, engineer: true, n: 44, post: post.defocus((t) => 5 * tri(t, 4, 40)),
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 44, v: [650, 480, 400, 10, 5, 10] }]),
  });
  add(0.9, {
    name: "defocused frames vs sharp reference (customer)",
    scene: P, pin: pin0, engineer: false, n: 26, post: post.defocus((t) => 2.5 - t / 12),
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 26, v: [620, 460, 420, 10, 5, 10] }]),
  });
  // ── 저조도: 센서 이득 1/10 → 잡음 σ≈20·양자화 계단, 긴 노출 블러
  add(0.95, {
    name: "low light (noise sigma ~20, exposure blur) (engineer)",
    scene: P, pin: pin0, engineer: true, n: 40, post: post.lowLight(0.1, 2), exposureFrac: 0.9, blurSamples: 5,
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 20, v: [650, 470, 480, 8, 5, 10] }, { t: 40, v: [560, 430, 540, -8, -5, -5] }]),
  });
  add(0.9, {
    name: "low light reference and frames (customer)",
    scene: P, pin: pin0, engineer: false, n: 26, post: post.lowLight(0.1, 2), refPost: post.lowLight(0.1, 2),
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 26, v: [640, 470, 480, 10, 5, 10] }]),
  });
  // ── 노출 급변 (자동노출 헤맴·포화)
  add(0.6, {
    name: "exposure jumps x0.15..x3.2 with clipping (engineer)",
    scene: P, pin: pin0, engineer: true, n: 42, post: post.exposureJumps([1, 0.25, 3.2, 1, 0.15, 2.2], 5),
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 21, v: [650, 470, 480, 8, 5, 10] }, { t: 42, v: [560, 430, 540, -8, -5, -5] }]),
  });
  add(0.9, {
    name: "exposure jumps (customer)",
    scene: P, pin: pin0, engineer: false, n: 26, post: post.exposureJumps([2.4, 0.4, 1.6], 5),
    pose: orbitPath([{ t: 0, v: [600, 450, 520, 0, 0, 0] }, { t: 26, v: [640, 470, 480, 10, 5, 10] }]),
  });
  return cases;
}

/**
 * 알려진 한계 (테스트에서 통과를 요구하지 않음, 문서·실험용): 핀이 6mm 돌출부 사이 틈(바닥)에 있고
 * 시점이 기준 대비 60~80° 바뀌면 틈 주변도 키 윗면이 지배해 광도 검증이 시차를 못 잡는다.
 */
export function robustLimitCases(): RobustCase[] {
  const S = keypadScene(24);
  return [
    {
      minRate: 0,
      spec: {
        name: "LIMIT keys 6mm, pin in the gap, ±35° (engineer)",
        scene: S, pin: { x: 597, y: 461, z: 0 }, engineer: true, n: 60,
        pose: orbitPath([{ t: 0, v: [600, 460, 460, -35, 0, 0] }, { t: 30, v: [600, 460, 460, 35, 10, 0] }, { t: 60, v: [600, 470, 450, 30, -20, 5] }]),
      },
    },
    {
      minRate: 0,
      spec: {
        name: "LIMIT keys 6mm, pin in the gap, 70° off the reference (customer)",
        scene: S, pin: { x: 597, y: 461, z: 0 }, engineer: false, n: 40,
        pose: orbitPath([{ t: 0, v: [600, 460, 460, -35, 0, 0] }, { t: 6, v: [600, 460, 460, 35, 10, 0] }, { t: 40, v: [600, 470, 450, 30, -20, 5] }]),
      },
    },
  ];
}
