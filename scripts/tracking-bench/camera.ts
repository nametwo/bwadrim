// 핀홀 카메라 + 평면 장면 모델. 정답(GT) 호모그래피는 전부 여기서 해석적으로 나온다.
//
// 월드 좌표: 대상 평면이 Z=0, X=오른쪽(텍스처 u), Y=아래(텍스처 v). 단위 = 대상 텍스처 픽셀("평면 단위").
// 카메라 좌표: x=오른쪽, y=아래, z=앞(보는 방향). 카메라는 Z<0 쪽에서 +Z 방향으로 평면을 본다.
// 이미지 좌표: "가장자리 규약" — 픽셀 i는 [i, i+1)을 덮고 중심은 i+0.5.
//   (작업 해상도 GT는 트래커 관례에 맞춰 "중심 규약"(픽셀 i 중심 = i)으로 바꿔 내보낸다: streamToWork)

import type { Mat3, Point } from "../../src/lib/tracking/types";
import { invert3, mul3 } from "../../src/lib/tracking/geometry";
import { SmoothNoise, clamp, lerp, smootherstep } from "./rng";

export type Vec3 = [number, number, number];

/** 폰 메인 카메라 화각(긴 변 기준) */
export const HFOV_DEG = 65;
/** 런타임 작업 해상도: 긴 변 픽셀 */
export const WORK_LONG_SIDE = 320;

const DEG = Math.PI / 180;

export function rotX(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
export function transpose3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
export function mulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export interface Intrinsics {
  width: number;
  height: number;
  f: number;
  cx: number;
  cy: number;
}

/** 초점거리는 긴 변 화각으로 정한다 (세로/가로 모드 모두 같은 렌즈) */
export function intrinsics(width: number, height: number, hfovDeg = HFOV_DEG): Intrinsics {
  const L = Math.max(width, height);
  const f = L / 2 / Math.tan((hfovDeg * DEG) / 2);
  return { width, height, f, cx: width / 2, cy: height / 2 };
}

/** 카메라 자세. R: 월드→카메라 회전, C: 월드 좌표의 카메라 중심 */
export interface Pose {
  R: Mat3;
  C: Vec3;
}

/**
 * "궤도" 방식 시점 파라미터: 평면 위 한 점(x,y)을 거리 dist에서 바라본다.
 * yaw(수직축), pitch(수평축)는 평면 법선에서 기운 각, roll은 광축 회전(도).
 */
export interface ViewParams {
  x: number;
  y: number;
  dist: number;
  yaw: number;
  pitch: number;
  roll: number;
}

/** 손떨림 샘플: 카메라 축 기준 회전(도)과 이동(평면 단위) */
export interface JitterSample {
  rx: number;
  ry: number;
  rz: number;
  tx: number;
  ty: number;
  tz: number;
}

export function poseFromView(v: ViewParams, j?: JitterSample | null): Pose {
  let Rwc = mul3(mul3(rotY(v.yaw), rotX(v.pitch)), rotZ(v.roll));
  let C: Vec3 = [v.x - v.dist * Rwc[2], v.y - v.dist * Rwc[5], -v.dist * Rwc[8]];
  if (j) {
    const tw = mulVec(Rwc, [j.tx, j.ty, j.tz]);
    C = [C[0] + tw[0], C[1] + tw[1], C[2] + tw[2]];
    Rwc = mul3(Rwc, mul3(mul3(rotX(j.rx), rotY(j.ry)), rotZ(j.rz)));
  }
  return { R: transpose3(Rwc), C };
}

/**
 * 평면 Z=z 위의 2D 좌표계(아핀 A: 로컬 (a,b) → 월드 (X,Y) = [A0 A1 A2; A3 A4 A5]·(a,b,1)) → 이미지 픽셀(가장자리 규약).
 * H = K [R·a1  R·a2  R·(o - C)]
 */
export function planeToImage(K: Intrinsics, pose: Pose, z: number, A: readonly number[]): Mat3 {
  const R = pose.R;
  const c1 = mulVec(R, [A[0], A[3], 0]);
  const c2 = mulVec(R, [A[1], A[4], 0]);
  const c3 = mulVec(R, [A[2] - pose.C[0], A[5] - pose.C[1], z - pose.C[2]]);
  const { f, cx, cy } = K;
  return [
    f * c1[0] + cx * c1[2],
    f * c2[0] + cx * c2[2],
    f * c3[0] + cx * c3[2],
    f * c1[1] + cy * c1[2],
    f * c2[1] + cy * c2[2],
    f * c3[1] + cy * c3[2],
    c1[2],
    c2[2],
    c3[2],
  ];
}

/** 대상 평면(Z=0, 평면 단위 = 텍스처 픽셀) → 이미지 */
export const TARGET_AFFINE: readonly number[] = [1, 0, 0, 0, 1, 0];

/** 이미지 스트림 해상도 → 런타임 작업 해상도 (긴 변 320, 짧은 변 반올림) */
export function workDims(w: number, h: number, longSide = WORK_LONG_SIDE): [number, number] {
  const s = longSide / Math.max(w, h);
  if (s >= 1) return [w, h];
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/**
 * 스트림 픽셀(가장자리 규약) → 작업 해상도 픽셀(중심 규약).
 * 면적 평균 축소는 가장자리 좌표를 정확히 비율대로 옮기므로 x_w = x_s·(ww/sw) - 0.5.
 */
export function streamToWork(sw: number, sh: number, ww: number, wh: number): Mat3 {
  return [ww / sw, 0, -0.5, 0, wh / sh, -0.5, 0, 0, 1];
}

/** 동차 좌표 변환 (카메라 뒤면 null) */
export function project(H: Mat3, x: number, y: number): Point | null {
  const w = H[6] * x + H[7] * y + H[8];
  if (!(w > 1e-9)) return null;
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

/** 스케일이 다른 동차 행렬끼리 보간할 수 있게 프로베니우스 정규화 (부호는 ref와 같은 방향) */
export function normalizeFrob(m: Mat3, ref?: Mat3): Mat3 {
  let s = 0;
  for (let i = 0; i < 9; i++) s += m[i] * m[i];
  let k = 1 / Math.sqrt(s);
  if (ref) {
    let d = 0;
    for (let i = 0; i < 9; i++) d += m[i] * ref[i];
    if (d < 0) k = -k;
  }
  return m.map((v) => v * k);
}

export function invertOrThrow(m: Mat3): Mat3 {
  const r = invert3(m);
  if (!r) throw new Error("singular homography");
  return r;
}

// ───────────────────────── 궤적 ─────────────────────────

export interface ViewKey {
  t: number;
  x?: number;
  y?: number;
  dist?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  /** 이전 키 → 이 키 구간의 보간 방식 (기본 smooth) */
  ease?: "smooth" | "linear";
}

export type ViewFn = (t: number) => ViewParams;

/** 키프레임 궤적. 빠진 값은 이전 키에서 이어받는다. 첫 키는 모든 값을 가져야 한다 */
export function keyframes(keys: ViewKey[]): ViewFn {
  if (keys.length === 0) throw new Error("keyframes: empty");
  const resolved: (ViewParams & { t: number; ease: "smooth" | "linear" })[] = [];
  let prev: ViewParams | null = null;
  for (const k of keys) {
    const base: ViewParams = prev ?? { x: NaN, y: NaN, dist: NaN, yaw: 0, pitch: 0, roll: 0 };
    const v: ViewParams = {
      x: k.x ?? base.x,
      y: k.y ?? base.y,
      dist: k.dist ?? base.dist,
      yaw: k.yaw ?? base.yaw,
      pitch: k.pitch ?? base.pitch,
      roll: k.roll ?? base.roll,
    };
    if (!Number.isFinite(v.x + v.y + v.dist)) throw new Error("keyframes: first key needs x, y, dist");
    resolved.push({ ...v, t: k.t, ease: k.ease ?? "smooth" });
    prev = v;
  }
  resolved.sort((a, b) => a.t - b.t);
  return (t: number): ViewParams => {
    if (t <= resolved[0].t) return resolved[0];
    const last = resolved[resolved.length - 1];
    if (t >= last.t) return last;
    let i = 0;
    while (i < resolved.length - 2 && t > resolved[i + 1].t) i++;
    const a = resolved[i];
    const b = resolved[i + 1];
    const u = (t - a.t) / Math.max(1e-9, b.t - a.t);
    const s = b.ease === "linear" ? u : smootherstep(u);
    return {
      x: lerp(a.x, b.x, s),
      y: lerp(a.y, b.y, s),
      dist: lerp(a.dist, b.dist, s),
      yaw: lerp(a.yaw, b.yaw, s),
      pitch: lerp(a.pitch, b.pitch, s),
      roll: lerp(a.roll, b.roll, s),
    };
  };
}

/**
 * 손떨림/흔들기 명세. RMS 기준.
 * 느린 흔들림(driftHz 대역) + 생리적 떨림(tremorHz 대역, rotDeg·tremor 비율).
 */
export interface JitterSpec {
  /** 회전 RMS(도, 축당) */
  rotDeg: number;
  /** 이동 RMS(mm, 축당) */
  transMm: number;
  driftHz?: [number, number];
  /** 떨림 대역 세기 (rotDeg 대비) */
  tremor?: number;
  tremorHz?: [number, number];
}

export class HandJitter {
  private readonly ch: SmoothNoise[] = [];
  private readonly tr: SmoothNoise[] = [];
  constructor(
    private readonly spec: JitterSpec,
    private readonly unitsPerMm: number,
    seed: number,
  ) {
    const [d0, d1] = spec.driftHz ?? [0.15, 1.6];
    const [t0, t1] = spec.tremorHz ?? [4, 11];
    for (let i = 0; i < 6; i++) {
      this.ch.push(new SmoothNoise(seed * 31 + i * 7919 + 1, d0, d1, 6));
      this.tr.push(new SmoothNoise(seed * 17 + i * 104729 + 3, t0, t1, 5));
    }
  }
  at(t: number): JitterSample {
    const r = this.spec.rotDeg;
    const m = this.spec.transMm * this.unitsPerMm;
    const k = this.spec.tremor ?? 0.35;
    const v = (i: number) => this.ch[i].at(t) + k * this.tr[i].at(t);
    return {
      rx: r * v(0),
      ry: r * v(1),
      rz: 0.5 * r * v(2), // 광축 회전은 덜 흔들린다
      tx: m * v(3),
      ty: m * v(4),
      tz: 0.7 * m * v(5),
    };
  }
}

// ───────────────────────── 가리는 손(비평면 가림) ─────────────────────────

/**
 * 손 자세: 검지 끝 위치(월드 X,Y, 평면 단위)와 방향(도). angle=0이면 팔이 +Y(화면 아래)에서 들어온다.
 * 손 평면은 대상 평면과 평행, 높이 heightMm 만큼 카메라 쪽(Z<0)에 떠 있다.
 */
export interface HandPose {
  x: number;
  y: number;
  angle: number;
}

/** 손 로컬 좌표(mm, 검지 끝이 원점, +y가 손목 쪽) → 월드 평면 아핀 */
export function handAffine(p: HandPose, unitsPerMm: number): number[] {
  const c = Math.cos(p.angle * DEG) * unitsPerMm;
  const s = Math.sin(p.angle * DEG) * unitsPerMm;
  return [c, -s, p.x, s, c, p.y];
}

function capsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  let h = (pax * bax + pay * bay) / (bax * bax + bay * bay);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function roundBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const inside = Math.min(Math.max(qx, qy), 0);
  return Math.sqrt(ox * ox + oy * oy) + inside - r;
}

/**
 * 가리키는 손(오른손, 검지만 편 모양)의 부호 거리(mm). 음수 = 손 안.
 * 팔뚝까지 이어져 있어 화면 가장자리 밖에서 들어오는 모양이 된다.
 */
export function handSdf(x: number, y: number): number {
  let d = capsule(x, y, 0, 8, 0, 78, 8.5); // 검지
  d = Math.min(d, roundBox(x, y, -24, 118, 42, 40, 20)); // 손바닥
  d = Math.min(d, capsule(x, y, -14, 86, -16, 98, 9.5)); // 접은 중지
  d = Math.min(d, capsule(x, y, -32, 90, -34, 102, 9)); // 약지
  d = Math.min(d, capsule(x, y, -50, 96, -51, 108, 8)); // 새끼
  d = Math.min(d, capsule(x, y, 14, 132, 24, 92, 10)); // 엄지
  d = Math.min(d, capsule(x, y, -24, 150, -30, 620, 33)); // 손목·팔뚝
  return d;
}

/** 손 로컬 좌표의 보수적 경계 (mm) — 화면 bbox 계산용 */
export const HAND_BOUNDS = { x0: -80, x1: 40, y0: -5, y1: 660 };

/** 손톱 영역 (검지 끝) — 밝게 칠한다 */
export function nailSdf(x: number, y: number): number {
  const dx = x / 5.5;
  const dy = (y - 15) / 8;
  return (Math.sqrt(dx * dx + dy * dy) - 1) * 5.5;
}

// ───────────────────────── 정반사(광택) ─────────────────────────

/** 광원 L, 카메라 C일 때 평면 Z=0 위 정반사 지점 (평면 좌표). 없으면 null */
export function specularPoint(L: Vec3, C: Vec3): Point | null {
  // L의 거울상 L' = (Lx, Ly, -Lz). C→L' 직선이 Z=0과 만나는 점
  const Lz = -L[2];
  const den = Lz - C[2];
  if (Math.abs(den) < 1e-9) return null;
  const s = -C[2] / den;
  if (!(s > 0 && s < 1)) return null;
  return { x: C[0] + s * (L[0] - C[0]), y: C[1] + s * (L[1] - C[1]) };
}

/** 부드러운 원형 이동 경로 등 편의 */
export function circlePath(cx: number, cy: number, r: number, hz: number, phase = 0) {
  return (t: number): Point => ({
    x: cx + r * Math.cos(2 * Math.PI * hz * t + phase),
    y: cy + r * Math.sin(2 * Math.PI * hz * t + phase),
  });
}

export { clamp };
