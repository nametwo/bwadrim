// 합성 시나리오 목록. README "품질 목표" 표의 범주를 모두 덮는다.
// 모든 궤적은 핀 기준 cm로 적는다 (dx,dy = 카메라가 바라보는 점의 핀 대비 위치, d = 거리).
import type { Point } from "../../src/lib/tracking/types";
import { type HandPose, type JitterSpec, type ViewFn, keyframes } from "./camera";
import type { IspSpec } from "./isp";
import type { LensSpec } from "./lens";
import type { PhotoParams, ShadowBlob } from "./render";
import { smootherstep } from "./rng";
import type { BackgroundId, TargetId, TextureDef, TextureMeta } from "./textures";

/** README 품질 목표 범주 (+ 벤치 자체 범주: stress, drift) */
export type Category = "jitter" | "motion" | "repetitive" | "lowtex" | "reentry" | "acquire" | "stress" | "drift";
export type Side = "engineer" | "customer";
/**
 * 시나리오 묶음. base = 기존 합성 영상 (게이트·비교 기준), realism = base의 실감 변형(렌즈 왜곡·입체·ISP·실제 코덱 등),
 * holdout = 과적합 확인용 (기본 실행·게이트에서 빠짐, --holdout으로만)
 */
export type Suite = "base" | "realism" | "holdout";

export interface SceneCtx {
  def: TextureDef;
  meta: TextureMeta;
  /** 핀 위치 (평면 단위) */
  pin: Point;
  /** cm → 평면 단위 */
  cm(v: number): number;
  /** 핀 기준 cm 오프셋 → 평면 좌표 */
  at(dxCm: number, dyCm: number): Point;
}

export interface HandSpec {
  heightMm: number;
  path: (ctx: SceneCtx) => (t: number) => HandPose | null;
}

export interface Scenario {
  id: string;
  category: Category;
  /** 한 줄 설명 */
  title: string;
  target: TargetId;
  background?: BackgroundId;
  /** 대상 텍스처 랜드마크 이름 */
  pin: string;
  /** 랜드마크 중심에서 핀까지 (mm) */
  pinOffsetMm?: [number, number];
  /** 카메라 스트림 해상도 [w, h] (기본 480x640 세로) */
  stream?: [number, number];
  side: Side;
  /** 전체 길이 (초) */
  duration: number;
  /** 기준 프레임 시각 (초, 30fps 격자로 맞춤) */
  refTime: number;
  /** 고객 쪽: 기준 프레임 촬영 → 고객이 앵커를 받기까지 (초, 기본 0.3) */
  latency?: number;
  /** 추적 처리 fps (기본 엔지니어 30, 고객 20) */
  fps?: number;
  view: (ctx: SceneCtx) => ViewFn;
  /** 손떨림 (기본: 엔지니어 쪽 영상도 고객 폰이 찍은 것이므로 약한 손떨림) */
  jitter?: JitterSpec | null;
  /** 손떨림 세기 시간 포락선 */
  jitterEnv?: (t: number) => number;
  exposureMs?: number;
  readoutMs?: number;
  light?: (t: number) => Partial<PhotoParams>;
  noise?: { shot: number; read: number };
  /** 엔지니어 쪽 영상 압축 (WebRTC 흉내). 기본 JPEG q75. null이면 압축 없음 */
  transport?: { quality: number; scale?: number } | null;
  hand?: HandSpec;
  shadow?: (ctx: SceneCtx) => (t: number) => ShadowBlob | null;
  /** 폰을 가로로 돌림: switchAt에 스트림이 가로로 바뀐다 */
  orientation?: { switchAt: number; rotateSec: number };
  /** 광택 광원 위치 (대상 중심 기준 mm) */
  glossLightMm?: [number, number, number];
  /** 조명 깜빡임 (롤링 셔터 띠) */
  flicker?: { hz: number; depth: number };
  /** false면 자동초점 흐림 없음 (기본: 거리 변화를 AF_LAG로 늦게 따라감) */
  autofocus?: boolean;
  seed?: number;
  /** 과적합 확인용 홀드아웃 (기본 실행·게이트에서 빠진다) */
  holdout?: boolean;
  /** 실감 효과 (realism 묶음·홀드아웃). 없으면 기존 합성 파이프라인 그대로 */
  realism?: RealismSpec;
  /** 실감 변형의 원본 시나리오 id (비교 표) */
  variantOf?: string;
}

/** 초점 헌팅 한 번: t초부터 dur초 동안 초점이 diopters(1/m)만큼 앞뒤로 흔들렸다 돌아옴 */
export interface AfHunt {
  t: number;
  dur: number;
  diopters: number;
}

/** 면광원 (형광등·창) — 대상 중심 기준 mm, dist = 대상 평면 앞 거리 */
export interface AreaLightSpec {
  x: number;
  y: number;
  dist: number;
  w: number;
  h: number;
  angle?: number;
  /** 수직 입사 때 가산 세기 (선형광, 흰색 = 1) */
  strength: number;
  /** 표면 거칠기에 따른 가장자리 흐림 (mm, 광원 평면에서) */
  blurMm: number;
}

/** 실제 WebRTC 코덱 왕복 (Playwright Chromium 루프백) */
export interface CodecSpec {
  codec: "VP8" | "VP9" | "AV1";
  /** 최대 비트레이트 (kbps) */
  kbps: number;
  /** 인코더 해상도 축소 배율 (scaleResolutionDownBy, 기본 1) */
  scaleDown?: number;
  /** 기본 maintain-resolution (해상도 고정, 대신 프레임을 버림) */
  degradation?: "maintain-resolution" | "maintain-framerate" | "balanced";
}

/** 실감 효과 묶음 — 각 항목은 선택. 기본값(REALISM_DEFAULT)은 폰 메인 카메라 + 흔한 실내 조명 */
export interface RealismSpec {
  /** 렌즈 왜곡 (Brown–Conrady) */
  lens?: LensSpec;
  /** 입체 부조 (텍스처별 relief.ts). 숫자면 높이 배율 */
  relief?: boolean | number;
  /** ISP: 톤 곡선·TNR·샤프닝 */
  isp?: IspSpec;
  /** 초점 호흡(초점 거리에 따라 화각 ±1~2%) + 초점 헌팅 */
  af?: { breathing?: boolean; hunts?: AfHunt[] };
  /** 광택 표면에 비친 면광원 */
  area?: AreaLightSpec;
  /** 엔지니어 쪽 영상(고객 쪽이면 기준 이미지)을 실제 WebRTC 코덱으로 */
  codec?: CodecSpec;
}

export function suiteOf(sc: Scenario): Suite {
  return sc.holdout ? "holdout" : sc.realism ? "realism" : "base";
}

/** 궤적 키 (핀 기준 cm, 도) */
export interface K {
  t: number;
  dx?: number;
  dy?: number;
  d?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  ease?: "smooth" | "linear";
}

export function path(keys: K[]): (ctx: SceneCtx) => ViewFn {
  return (ctx) => {
    let last: Required<Omit<K, "t" | "ease">> = { dx: 0, dy: 0, d: 30, yaw: 0, pitch: 0, roll: 0 };
    return keyframes(
      keys.map((k) => {
        last = {
          dx: k.dx ?? last.dx,
          dy: k.dy ?? last.dy,
          d: k.d ?? last.d,
          yaw: k.yaw ?? last.yaw,
          pitch: k.pitch ?? last.pitch,
          roll: k.roll ?? last.roll,
        };
        const p = ctx.at(last.dx, last.dy);
        return { t: k.t, x: p.x, y: p.y, dist: ctx.cm(last.d), yaw: last.yaw, pitch: last.pitch, roll: last.roll, ease: k.ease };
      }),
    );
  };
}

/** 고정 시점 */
export function still(k: Omit<K, "t">): (ctx: SceneCtx) => ViewFn {
  return path([{ t: 0, ...k }]);
}

export const J_STILL: JitterSpec = { rotDeg: 0.05, transMm: 0.25, tremor: 0.25 };
export const J_MILD: JitterSpec = { rotDeg: 0.3, transMm: 1.5 };
export const J_STRONG: JitterSpec = { rotDeg: 1.0, transMm: 4, tremor: 0.55, tremorHz: [3.5, 9] };
export const J_SHAKE: JitterSpec = { rotDeg: 2.2, transMm: 7, driftHz: [2.5, 6], tremor: 0.3 };

/** 부드러운 계단: t0~t1 사이에 a→b */
export function ramp(t: number, t0: number, t1: number, a: number, b: number): number {
  return a + (b - a) * smootherstep((t - t0) / (t1 - t0));
}

/** 손 경로: 키 (핀 기준 cm) 보간, 화면 밖이면 null */
export function handPath(keys: { t: number; dx: number; dy: number; angle: number }[]): (ctx: SceneCtx) => (t: number) => HandPose | null {
  return (ctx) => (t) => {
    if (t < keys[0].t || t > keys[keys.length - 1].t) return null;
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const s = smootherstep((t - a.t) / Math.max(1e-6, b.t - a.t));
    const p = ctx.at(a.dx + (b.dx - a.dx) * s, a.dy + (b.dy - a.dy) * s);
    return { x: p.x, y: p.y, angle: a.angle + (b.angle - a.angle) * s };
  };
}

// 화면 밖 → 복귀 궤적 (핀 기준 cm): 멀리 갔다가 돌아오기 n번
export function awayAndBack(base: Omit<K, "t">, legs: { t: number; away: [number, number]; hold: number; move: number }[]): K[] {
  const keys: K[] = [{ t: 0, ...base }];
  for (const l of legs) {
    keys.push({ t: l.t, dx: base.dx, dy: base.dy });
    keys.push({ t: l.t + l.move, dx: (base.dx ?? 0) + l.away[0], dy: (base.dy ?? 0) + l.away[1] });
    keys.push({ t: l.t + l.move + l.hold, dx: (base.dx ?? 0) + l.away[0], dy: (base.dy ?? 0) + l.away[1] });
    keys.push({ t: l.t + 2 * l.move + l.hold, dx: base.dx, dy: base.dy });
  }
  return keys;
}

export const SCENARIOS: Scenario[] = [
  // ───────────── 손떨림 (README: 추적률 ≥95%, 오차 중앙값 ≤2px, 틀린 표시 ≤0.5%) ─────────────
  {
    id: "jitter/still/boiler",
    category: "jitter",
    title: "거의 고정 (폰을 받쳐 든 상태), 보일러 온수 버튼",
    target: "boiler",
    pin: "btnWater",
    side: "engineer",
    duration: 4,
    refTime: 0.2,
    view: still({ dx: 0, dy: -2, d: 25, yaw: 5, pitch: -8, roll: 2 }),
    jitter: J_STILL,
  },
  {
    id: "jitter/mild/pos",
    category: "jitter",
    title: "보통 손떨림, 단말기 5번 키",
    target: "pos",
    pin: "key5",
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: still({ dx: 1, dy: -1.5, d: 26, yaw: -6, pitch: 10, roll: -3 }),
    jitter: J_MILD,
  },
  {
    id: "jitter/mild/nameplate-land",
    category: "jitter",
    title: "보통 손떨림, 가로 화면(640x480), 명판 제조번호",
    target: "nameplate",
    pin: "serial",
    stream: [640, 480],
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: still({ dx: 1.5, dy: -0.5, d: 15, yaw: 8, pitch: -5, roll: 1 }),
    jitter: J_MILD,
  },
  {
    id: "jitter/strong/router",
    category: "jitter",
    title: "심한 손떨림, 공유기 LAN 3번 (옆 포트와 똑같이 생김)",
    target: "router",
    pin: "lan3",
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: still({ dx: -1, dy: 0.5, d: 22, yaw: -10, pitch: 12, roll: 0 }),
    jitter: J_STRONG,
  },
  {
    id: "jitter/strong/breaker",
    category: "jitter",
    title: "심한 손떨림, 분전반 5번 차단기",
    target: "breaker",
    pin: "br5",
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: still({ dx: 1, dy: 2, d: 36, yaw: 6, pitch: -4, roll: -2 }),
    jitter: J_STRONG,
  },

  {
    id: "jitter/edge-pin/router",
    category: "jitter",
    title: "화면 가장자리 가까이 찍은 핀 (ROI가 잘림), 공유기 WAN",
    target: "router",
    pin: "wan",
    side: "engineer",
    duration: 4,
    refTime: 0.2,
    // 핀이 화면 왼쪽 가장자리 근처 (작업 해상도 ~35px)
    view: still({ dx: 8, dy: -0.5, d: 23, yaw: -4, pitch: 8 }),
    jitter: J_MILD,
  },

  // ───────────── 이동·확대·기울임 (README: 추적률 ≥85%, 오차 중앙값 ≤3px, 틀린 표시 ≤1%) ─────────────
  {
    id: "motion/pan/boiler",
    category: "motion",
    title: "천천히 가로 이동 (패널을 훑음), 보일러 난방 버튼",
    target: "boiler",
    pin: "btnHeat",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: -5, dy: -1, d: 26, yaw: 4, pitch: -6 },
      { t: 0.4, dx: -5 },
      { t: 4.6, dx: 6, dy: 1, yaw: -4, ease: "linear" },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/pan/nameplate",
    category: "motion",
    title: "천천히 세로 이동, 명판 모델명",
    target: "nameplate",
    pin: "model",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 1.5, dy: -2.5, d: 15, yaw: -5, pitch: 6 },
      { t: 0.4, dy: -2.5 },
      { t: 4.4, dy: 3.5, dx: 2.5, ease: "linear" },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/zoom-in/pos",
    category: "motion",
    title: "2배 다가가기, 단말기 확인 키",
    target: "pos",
    pin: "keyOk",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: -2, dy: -1, d: 34, yaw: 6, pitch: 8 },
      { t: 0.6 },
      { t: 3.6, dx: -0.5, dy: -0.3, d: 17 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/zoom-in/router",
    category: "motion",
    title: "2배 다가가기, 공유기 WAN 포트",
    target: "router",
    pin: "wan",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 2, dy: -1.5, d: 30, yaw: -8, pitch: 10 },
      { t: 0.5 },
      { t: 3.5, dx: 0.5, dy: -0.3, d: 15 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/zoom-out/boiler",
    category: "motion",
    title: "멀어지기 (18cm → 40cm), 보일러 전원 버튼",
    target: "boiler",
    pin: "btnPower",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 0.5, dy: -1, d: 18, yaw: 3, pitch: -4 },
      { t: 0.5 },
      { t: 3.8, dx: 3, dy: -2, d: 40 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/tilt45/router",
    category: "motion",
    title: "옆으로 45° 기울이기, 공유기 DC 잭",
    target: "router",
    pin: "dc",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 1, dy: -1, d: 24, yaw: 0, pitch: 8 },
      { t: 0.5 },
      { t: 3.0, yaw: 45 },
      { t: 3.8 },
      { t: 4.8, yaw: 20 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/tilt60/boiler",
    category: "motion",
    title: "아래에서 올려보며 60° 기울이기, 보일러 현재온도",
    target: "boiler",
    pin: "lcdTemp",
    side: "engineer",
    duration: 5.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 0, dy: 1, d: 25, yaw: 3, pitch: 0 },
      { t: 0.5 },
      { t: 3.3, pitch: 60, yaw: 8 },
      { t: 4.1 },
      { t: 5.3, pitch: 25 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/roll90/pos",
    category: "motion",
    title: "화면 안에서 90° 돌리기, 단말기 8번 키",
    target: "pos",
    pin: "key8",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 0.5, dy: -1, d: 25, yaw: -4, pitch: 6, roll: 0 },
      { t: 0.5 },
      { t: 3.2, roll: 90 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/roll45/nameplate",
    category: "motion",
    title: "45° 돌렸다 돌아오기, 명판 전압",
    target: "nameplate",
    pin: "voltage",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 2, dy: 0, d: 16, yaw: 5, pitch: -3, roll: 0 },
      { t: 0.5 },
      { t: 2.4, roll: -45 },
      { t: 3.0 },
      { t: 4.6, roll: -5 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/hd720/boiler",
    category: "motion",
    title: "HD 스트림(720x1280) → 작업 180x320, 이동+확대, 보일러 ▲",
    target: "boiler",
    pin: "btnUp",
    stream: [720, 1280],
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: -3, dy: 0, d: 28, yaw: -8, pitch: 4 },
      { t: 0.4 },
      { t: 4.2, dx: -1, dy: 1.5, d: 20, yaw: 5, roll: 10 },
    ]),
    jitter: J_MILD,
  },

  {
    id: "motion/pan-customer/router",
    category: "motion",
    title: "고객 쪽 (20fps, 압축 없음): 찾은 뒤 옆으로 훑고 기울이기, 공유기 LAN 1번",
    target: "router",
    pin: "lan1",
    side: "customer",
    duration: 5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: 0, dy: -0.5, d: 22, yaw: 0, pitch: 8 },
      { t: 1.2 },
      { t: 3.2, dx: -4, yaw: 20 },
      { t: 4.8, dx: 2, yaw: -8, d: 19 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "motion/zoom-customer/boiler",
    category: "motion",
    title: "고객 쪽 (20fps): 찾은 뒤 다가가며 돌리기, 보일러 온수",
    target: "boiler",
    pin: "btnWater",
    side: "customer",
    duration: 5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: 0.5, dy: -1.5, d: 30, yaw: 5, pitch: 6, roll: 0 },
      { t: 1.2 },
      { t: 4.5, dx: 0.2, dy: -0.4, d: 17, roll: 35, yaw: -6 },
    ]),
    jitter: J_MILD,
  },

  // ───────────── 반복 패턴 (README: 틀린 표시 ≤1%) ─────────────
  {
    id: "repetitive/router-lan3/pan",
    category: "repetitive",
    title: "LAN 포트 4개 위를 가로로 훑기 (핀: LAN 3번)",
    target: "router",
    pin: "lan3",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 0, dy: -0.5, d: 20, yaw: 12, pitch: 8 },
      { t: 0.4 },
      { t: 2.4, dx: -4.5, yaw: 18 },
      { t: 4.6, dx: 3.5, yaw: 5 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "repetitive/breaker5/pan-tilt",
    category: "repetitive",
    title: "똑같은 차단기 줄을 기울여 훑기 (핀: 5번)",
    target: "breaker",
    pin: "br5",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 0, dy: 1, d: 34, yaw: 0, pitch: -5 },
      { t: 0.4 },
      { t: 2.5, dx: 9, yaw: 25 },
      { t: 4.6, dx: -7, yaw: -10 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "repetitive/breaker5/zoom",
    category: "repetitive",
    title: "차단기에 바짝 다가가기 (ROI 안에 똑같은 차단기 2~3개뿐)",
    target: "breaker",
    pin: "br5",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 1, dy: 0, d: 40, yaw: 5, pitch: 5 },
      { t: 0.4 },
      { t: 3.6, dx: 0.3, dy: -0.5, d: 16, yaw: 10 },
    ]),
    jitter: J_MILD,
  },

  // ───────────── 무늬 없음 (README: trackable=false 또는 lost 허용, 틀린 표시 ≤1%) ─────────────
  {
    id: "lowtex/appliance/still",
    category: "lowtex",
    title: "광택 흰 패널 (작은 로고만), 손떨림",
    target: "appliance",
    pin: "blank",
    side: "engineer",
    duration: 4,
    refTime: 0.2,
    view: still({ dx: -1, dy: -2, d: 35, yaw: 5, pitch: 8 }),
    jitter: J_MILD,
  },
  {
    id: "lowtex/appliance/move",
    category: "lowtex",
    title: "광택 흰 패널 + 움직이는 반사광, 이동·기울임",
    target: "appliance",
    pin: "blank",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 0, dy: -3, d: 35, yaw: 0, pitch: 5 },
      { t: 0.4 },
      { t: 2.6, dx: 6, yaw: 25, d: 30 },
      { t: 4.8, dx: -4, yaw: -10, d: 38 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "lowtex/appliance/customer",
    category: "lowtex",
    title: "광택 흰 패널, 고객 쪽 최초 탐색 (찾으면 안 되는 쪽에 가까움)",
    target: "appliance",
    pin: "blank",
    side: "customer",
    duration: 3,
    refTime: 0.4,
    view: path([
      { t: 0, dx: -1, dy: -2, d: 34, yaw: 3, pitch: 6 },
      { t: 3, dx: 1, dy: -1, d: 32, yaw: 8 },
    ]),
    jitter: J_MILD,
  },

  // ───────────── 화면 밖 → 복귀 (README: 복귀 10프레임 내 재검출 ≥80%, 틀린 표시 ≤1%) ─────────────
  {
    id: "reentry/pos",
    category: "reentry",
    title: "옆으로 벗어났다 돌아오기 ×2, 단말기 5번 키",
    target: "pos",
    pin: "key5",
    side: "engineer",
    duration: 8,
    refTime: 0.2,
    view: path(
      awayAndBack({ dx: 0.5, dy: -1, d: 25, yaw: 4, pitch: 6 }, [
        { t: 0.8, away: [24, 3], hold: 1.0, move: 0.6 },
        { t: 4.4, away: [-4, 26], hold: 1.2, move: 0.7 },
      ]),
    ),
    jitter: J_MILD,
  },
  {
    id: "reentry/breaker",
    category: "reentry",
    title: "벗어났다 돌아오기 ×2, 똑같은 차단기 (핀: 5번)",
    target: "breaker",
    pin: "br5",
    side: "engineer",
    duration: 8,
    refTime: 0.2,
    view: path(
      awayAndBack({ dx: 0, dy: 1, d: 36, yaw: 4, pitch: -3 }, [
        { t: 0.8, away: [0, -38], hold: 1.0, move: 0.6 },
        { t: 4.4, away: [40, 0], hold: 1.0, move: 0.7 },
      ]),
    ),
    jitter: J_MILD,
  },
  {
    id: "reentry/boiler-customer",
    category: "reentry",
    title: "고객 쪽: 찾은 뒤 벗어났다 돌아오기 ×2, 보일러 예약 버튼",
    target: "boiler",
    pin: "btnResv",
    side: "customer",
    duration: 8,
    refTime: 0.3,
    view: path(
      awayAndBack({ dx: -1, dy: -1.5, d: 25, yaw: -5, pitch: 5 }, [
        { t: 1.6, away: [-26, 0], hold: 1.0, move: 0.6 },
        { t: 4.8, away: [0, 26], hold: 1.0, move: 0.6 },
      ]),
    ),
    jitter: J_MILD,
  },
  {
    id: "reentry/router-newview",
    category: "reentry",
    title: "벗어났다가 다른 거리·각도로 돌아오기, 공유기 WAN",
    target: "router",
    pin: "wan",
    side: "engineer",
    duration: 6,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 0.5, dy: -0.5, d: 24, yaw: -5, pitch: 8, roll: 0 },
      { t: 0.8 },
      { t: 1.5, dx: 26, dy: -4 },
      { t: 2.8, dx: 26, dy: -4, d: 17, yaw: 15, roll: 12 },
      { t: 3.5, dx: 1, dy: 0 },
    ]),
    jitter: J_MILD,
  },

  {
    id: "reentry/nameplate-customer",
    category: "reentry",
    title: "고객 쪽: 명판에서 벗어났다 돌아오기 ×2 (두 번째는 기울어진 채로)",
    target: "nameplate",
    pin: "serial",
    side: "customer",
    duration: 7.5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: 1, dy: -0.5, d: 15, yaw: 4, pitch: -4 },
      { t: 1.4 },
      { t: 2.0, dx: 1, dy: 16 },
      { t: 3.0 },
      { t: 3.6, dx: 1.5, dy: -0.5 },
      { t: 4.6 },
      { t: 5.2, dx: -16, dy: 0, yaw: 20 },
      { t: 6.0 },
      { t: 6.6, dx: 0.5, dy: -0.2, yaw: 18, roll: 10 },
    ]),
    jitter: J_MILD,
  },

  // ───────────── 고객 최초 탐색 (README: 5프레임 내 ≥90%, 틀린 표시 ≤1%) ─────────────
  {
    id: "acquire/pos",
    category: "acquire",
    title: "고객 쪽 최초 탐색, 단말기 취소 키",
    target: "pos",
    pin: "keyCancel",
    side: "customer",
    duration: 2.7,
    refTime: 0.4,
    view: path([
      { t: 0, dx: -1, dy: -1, d: 26, yaw: 5, pitch: 8 },
      { t: 2.7, dx: -0.5, dy: -0.5, d: 25, yaw: 3 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "acquire/router-lan3",
    category: "acquire",
    title: "고객 쪽 최초 탐색, 공유기 LAN 3번 (옆 포트로 착각 금지)",
    target: "router",
    pin: "lan3",
    side: "customer",
    duration: 2.7,
    refTime: 0.4,
    view: path([
      { t: 0, dx: -1.5, dy: -0.5, d: 21, yaw: 8, pitch: 10 },
      { t: 2.7, dx: -1, dy: 0, d: 22, yaw: 12 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "acquire/boiler",
    category: "acquire",
    title: "고객 쪽 최초 탐색, 보일러 외출 버튼",
    target: "boiler",
    pin: "btnAway",
    side: "customer",
    duration: 2.7,
    refTime: 0.4,
    view: path([
      { t: 0, dx: -2, dy: -2, d: 24, yaw: -4, pitch: 6 },
      { t: 2.7, dx: -1.5, dy: -2.5, d: 23 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "acquire/breaker5",
    category: "acquire",
    title: "고객 쪽 최초 탐색, 5번 차단기 (반복 패턴)",
    target: "breaker",
    pin: "br5",
    side: "customer",
    duration: 2.7,
    refTime: 0.4,
    view: path([
      { t: 0, dx: 1, dy: 1, d: 34, yaw: 6, pitch: -4 },
      { t: 2.7, dx: 2, dy: 0.5, d: 33 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "acquire/nameplate",
    category: "acquire",
    title: "고객 쪽 최초 탐색, 명판 제조년월 (작은 글씨)",
    target: "nameplate",
    pin: "date",
    side: "customer",
    duration: 2.7,
    refTime: 0.4,
    view: path([
      { t: 0, dx: 1, dy: -1, d: 15, yaw: 4, pitch: -6 },
      { t: 2.7, dx: 1.5, dy: -0.5, d: 14 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "acquire/pos-moved",
    category: "acquire",
    title: "고객 쪽: 앵커 도착 전 폰을 20° 돌리고 다가감",
    target: "pos",
    pin: "key2",
    side: "customer",
    duration: 2.9,
    refTime: 0.4,
    latency: 0.45,
    view: path([
      { t: 0, dx: 0, dy: 0, d: 27, yaw: 0, pitch: 8, roll: 0 },
      { t: 0.45 },
      { t: 0.85, dx: 1, dy: 1, d: 21, yaw: 10, pitch: 12, roll: 20 },
      { t: 2.9, dx: 1.3, dy: 1.2, roll: 22 },
    ]),
    jitter: J_MILD,
  },
  {
    id: "acquire/boiler-lowlight",
    category: "acquire",
    title: "고객 쪽: 어두운 보일러실 (노출 이득↑, 잡음↑), 보일러 ▼",
    target: "boiler",
    pin: "btnDown",
    side: "customer",
    duration: 2.7,
    refTime: 0.4,
    view: path([
      { t: 0, dx: 2, dy: -2, d: 26, yaw: 6, pitch: -4 },
      { t: 2.7, dx: 2.5, dy: -1.5 },
    ]),
    jitter: J_MILD,
    exposureMs: 30,
    light: () => ({ scene: 0.3 }),
  },
  {
    id: "acquire/router-land",
    category: "acquire",
    title: "고객 쪽: 가로 화면(640x480), 공유기 USB",
    target: "router",
    pin: "usb",
    stream: [640, 480],
    side: "customer",
    duration: 2.7,
    refTime: 0.4,
    view: path([
      { t: 0, dx: 1, dy: -0.5, d: 20, yaw: -6, pitch: 12 },
      { t: 2.7, dx: 0.5, dy: -1 },
    ]),
    jitter: J_MILD,
  },

  // ───────────── 스트레스 (README 표 밖: 틀린 표시 ≤1%만 목표, 나머지는 참고 수치) ─────────────
  {
    id: "stress/shake/boiler",
    category: "stress",
    title: "빠르게 흔들기 (모션 블러·롤링 셔터), 보일러 난방",
    target: "boiler",
    pin: "btnHeat",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: still({ dx: 0.5, dy: -1.5, d: 26, yaw: 4, pitch: 6 }),
    jitter: J_SHAKE,
    jitterEnv: (t) => 0.12 + 0.88 * (ramp(t, 0.9, 1.3, 0, 1) - ramp(t, 3.0, 3.4, 0, 1)),
    exposureMs: 16,
    readoutMs: 24,
  },
  {
    id: "stress/shake/pos",
    category: "stress",
    title: "빠르게 흔들기, 단말기 3번 키",
    target: "pos",
    pin: "key3",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: still({ dx: -1, dy: -1, d: 25, yaw: -3, pitch: 9 }),
    jitter: J_SHAKE,
    jitterEnv: (t) => 0.12 + 0.88 * (ramp(t, 0.9, 1.3, 0, 1) - ramp(t, 3.0, 3.4, 0, 1)),
    exposureMs: 20,
    readoutMs: 24,
  },
  {
    id: "stress/blurry-ref/pos",
    category: "stress",
    title: "움직이는 중에 탭 → 흐린 기준 프레임, 이후 멈춤, 단말기 9번 키",
    target: "pos",
    pin: "key9",
    side: "engineer",
    duration: 4,
    refTime: 0.5,
    view: path([
      { t: 0, dx: -6, dy: 2, d: 26, yaw: -10, pitch: 6 },
      { t: 1.0, dx: 1, dy: -1, yaw: 4, ease: "linear" },
      { t: 1.5, dx: 1.5, dy: -1.2, yaw: 5 },
    ]),
    jitter: J_MILD,
    exposureMs: 25,
  },
  {
    id: "stress/light-dim/boiler",
    category: "stress",
    title: "조명이 꺼졌다 켜짐 (자동노출이 늦게 따라감)",
    target: "boiler",
    pin: "btnResv",
    side: "engineer",
    duration: 5.5,
    refTime: 0.2,
    view: still({ dx: -1, dy: -1, d: 25, yaw: -6, pitch: 5 }),
    jitter: J_MILD,
    // 조명이 30%로 → 자동노출(시상수 0.45초)이 늦게 따라와 잠깐 어두웠다가 잡음 많은 밝기로, 켜지면 잠깐 과노출
    // 어두울 때 ISP 톤 곡선도 바뀜 (대비↓, 밝기↑)
    light: (t) => {
      const dark = t < 1.5 ? 0 : t < 3.6 ? ramp(t, 1.5, 2.2, 0, 1) : ramp(t, 3.6, 4.4, 1, 0);
      return {
        scene: t < 1.5 ? 1 : t < 3.6 ? ramp(t, 1.5, 1.6, 1, 0.3) : ramp(t, 3.6, 3.7, 0.3, 1),
        contrast: 1.05 - 0.2 * dark,
        brightness: 0.04 * dark,
      };
    },
  },
  {
    id: "stress/flicker/breaker",
    category: "stress",
    title: "형광등 깜빡임 (120Hz, 롤링 셔터 가로 띠가 흐름) + 천천히 이동",
    target: "breaker",
    pin: "br3",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 1, dy: 1, d: 34, yaw: 4, pitch: -6 },
      { t: 4.4, dx: -3, dy: 0, d: 30, yaw: -6 },
    ]),
    jitter: J_MILD,
    exposureMs: 10,
    readoutMs: 28,
    flicker: { hz: 120, depth: 0.9 },
  },
  {
    id: "stress/shadow/nameplate",
    category: "stress",
    title: "몸 그림자가 명판 위를 지나감",
    target: "nameplate",
    pin: "power",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: still({ dx: 1, dy: 0, d: 16, yaw: 4, pitch: 4 }),
    jitter: J_MILD,
    shadow: (ctx) => (t) => {
      const x = ctx.at(ramp(t, 0.8, 4.4, -16, 16), 0).x;
      return { x, y: ctx.pin.y + ctx.cm(1), rx: ctx.cm(6), ry: ctx.cm(14), depth: 0.55, soft: ctx.cm(2.5) };
    },
  },
  {
    id: "stress/hand/router",
    category: "stress",
    title: "손가락이 LAN 3번을 가리키다 가림 (비평면 가림)",
    target: "router",
    pin: "lan3",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: still({ dx: 0, dy: -1, d: 22, yaw: 5, pitch: 10 }),
    jitter: J_MILD,
    hand: {
      heightMm: 45,
      path: handPath([
        { t: 0.6, dx: 3, dy: 30, angle: -20 },
        { t: 1.5, dx: 1.2, dy: 2.2, angle: -15 },
        { t: 2.1, dx: 0.4, dy: 1.2, angle: -12 },
        { t: 2.7, dx: 0.1, dy: -0.8, angle: -10 },
        { t: 3.4, dx: 0.3, dy: -0.5, angle: -12 },
        { t: 4.4, dx: 4, dy: 30, angle: -25 },
      ]),
    },
  },
  {
    id: "stress/hand/pos",
    category: "stress",
    title: "손가락으로 5번 키를 누름 (핀 위를 덮음)",
    target: "pos",
    pin: "key5",
    side: "engineer",
    duration: 5,
    refTime: 0.2,
    view: still({ dx: 0.5, dy: -1.5, d: 26, yaw: -4, pitch: 8 }),
    jitter: J_MILD,
    hand: {
      heightMm: 30,
      path: handPath([
        { t: 0.6, dx: -3, dy: 32, angle: 12 },
        { t: 1.7, dx: -0.3, dy: 1.5, angle: 10 },
        { t: 2.3, dx: 0, dy: -0.2, angle: 8 },
        { t: 3.3, dx: 0.1, dy: 0, angle: 8 },
        { t: 4.5, dx: -4, dy: 32, angle: 15 },
      ]),
    },
  },
  {
    id: "stress/orientation/boiler",
    category: "stress",
    title: "폰을 가로로 돌림 (스트림 480x640 → 640x480, 프레임 크기 바뀜)",
    target: "boiler",
    pin: "btnHeat",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: still({ dx: 0, dy: -1, d: 26, yaw: 3, pitch: 5 }),
    jitter: J_MILD,
    orientation: { switchAt: 2.2, rotateSec: 0.7 },
  },
  {
    id: "stress/compressed/router",
    category: "stress",
    title: "엔지니어 쪽 심한 압축 (JPEG q30, 360x480) + 이동, 공유기 전원",
    target: "router",
    pin: "power",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: 1, dy: -1, d: 23, yaw: -6, pitch: 8 },
      { t: 0.4 },
      { t: 4.2, dx: -2, dy: 0, d: 19, yaw: 6 },
    ]),
    jitter: J_MILD,
    transport: { quality: 30, scale: 0.75 },
  },
  {
    id: "stress/compressed/boiler",
    category: "stress",
    title: "엔지니어 쪽 아주 심한 압축 (JPEG q22, 240x320 저대역) + 이동",
    target: "boiler",
    pin: "btnWater",
    side: "engineer",
    duration: 4.5,
    refTime: 0.2,
    view: path([
      { t: 0, dx: -1, dy: -1.5, d: 25, yaw: 5, pitch: 6 },
      { t: 0.4 },
      { t: 4.2, dx: 2, dy: -0.5, d: 22, yaw: -5, roll: 8 },
    ]),
    jitter: J_MILD,
    transport: { quality: 22, scale: 0.5 },
  },

  // ───────────── 긴 시퀀스 드리프트 ─────────────
  {
    id: "drift/60s/boiler",
    category: "drift",
    title: "60초 동안 천천히 둘러보기 (드리프트)",
    target: "boiler",
    pin: "btnHeat",
    side: "engineer",
    duration: 60,
    refTime: 0.2,
    view: (ctx) => {
      // 느린 사인 합성: 이동 ±4cm, 거리 20~32cm, 기울임 ±20°, 회전 ±15°
      const P = (a: number, f: number, ph: number) => (t: number) => a * Math.sin(2 * Math.PI * f * t + ph);
      const dx = P(3.5, 0.031, 0.2);
      const dx2 = P(1.2, 0.083, 1.1);
      const dy = P(2.5, 0.041, 2.0);
      const dd = P(5, 0.023, 0.7);
      const yaw = P(18, 0.027, 0.3);
      const pitch = P(15, 0.036, 1.7);
      const roll = P(12, 0.019, 2.9);
      const env = (t: number) => smootherstep(t / 3); // 처음 3초는 천천히 시작
      return (t: number) => {
        const e = env(t);
        const p = ctx.at(e * (dx(t) + dx2(t)) - 0.5, e * dy(t) - 1);
        return { x: p.x, y: p.y, dist: ctx.cm(26 + e * dd(t)), yaw: e * yaw(t), pitch: 4 + e * pitch(t), roll: e * roll(t) };
      };
    },
    jitter: J_MILD,
  },
];

/**
 * 품질 게이트(gate.test.ts)용 대표 부분집합 — README 표의 범주를 모두 덮되 프레임 수를 줄였다 (~1400장).
 * duration만 줄인 사본이라 전체 벤치와 캐시를 공유하지 않는다.
 */
export const GATE_SUBSET: { id: string; duration?: number }[] = [
  { id: "jitter/mild/pos", duration: 3.5 },
  { id: "jitter/strong/router", duration: 3.5 },
  { id: "motion/zoom-in/pos" },
  { id: "motion/tilt45/router" },
  { id: "repetitive/router-lan3/pan" },
  { id: "repetitive/breaker5/zoom", duration: 4 },
  { id: "lowtex/appliance/still", duration: 2.5 },
  { id: "reentry/pos" },
  { id: "reentry/boiler-customer" },
  { id: "acquire/pos" },
  { id: "acquire/router-lan3" },
  { id: "acquire/boiler" },
  { id: "acquire/breaker5" },
  { id: "acquire/pos-moved" },
  { id: "acquire/boiler-lowlight" },
];

export function gateScenarios(): Scenario[] {
  return GATE_SUBSET.map(({ id, duration }) => {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) throw new Error(`gate scenario missing: ${id}`);
    return duration ? { ...sc, duration } : sc;
  });
}

export function findScenarios(filter?: string): Scenario[] {
  if (!filter) return SCENARIOS;
  const parts = filter.split(",").map((s) => s.trim()).filter(Boolean);
  return SCENARIOS.filter((s) => parts.some((p) => s.id.includes(p) || s.category === p));
}
