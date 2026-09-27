// ─────────────────────────────────────────────────────────────────────────────────────────────
// 홀드아웃 시나리오 — 추적기 과적합 확인용. 추적기를 튜닝하는 사람(에이전트)은 이 파일과 결과를 보지 말 것.
// 기본 실행·품질 게이트에서 빠지고 `npm run bench:tracking -- --holdout`으로만 돈다.
//
// 설계 원칙: 실제 A/S 통화처럼 (개발용 시나리오와 다른 기기·핀·궤적·시드), 모든 실감 효과를 켠다
// (렌즈 왜곡·입체·ISP·초점 호흡/헌팅·면광원 반사·사진 같은 텍스처·엔지니어 쪽 실제 WebRTC 코덱).
// 추적기를 통과시키거나 떨어뜨리려고 조정하지 않는다 — 궤적·세기는 실제 사용을 흉내 내 정했다.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import type { IspSpec } from "./isp";
import {
  type AreaLightSpec,
  J_MILD,
  J_STILL,
  J_STRONG,
  type RealismSpec,
  type Scenario,
  awayAndBack,
  handPath,
  path,
  still,
} from "./scenarios";

const ISP_A: IspSpec = { tone: { gamma: 1.06, s: 0.15, lift: 0.01 }, sharpen: { sigma: 0.9, amount: 0.7, threshold: 2 }, tnr: { alpha: 0.45, lo: 3, hi: 8, window: 5 } };
const ISP_B: IspSpec = { tone: { gamma: 1.12, s: 0.25, lift: 0.025 }, sharpen: { sigma: 1.2, amount: 1.2, threshold: 3 }, tnr: { alpha: 0.32, lo: 4, hi: 12, window: 6 } };
const ISP_C: IspSpec = { tone: { gamma: 1.0, s: 0.1, lift: 0.0 }, sharpen: { sigma: 1.5, amount: 1.6, threshold: 4 }, tnr: { alpha: 0.3, lo: 5, hi: 16, window: 6 } };

const TUBE = (x: number, y: number, dist: number, strength: number, angle = 0, blurMm = 30): AreaLightSpec => ({
  x,
  y,
  dist,
  w: 1100,
  h: 70,
  angle,
  strength,
  blurMm,
});
const WINDOW = (x: number, y: number, dist: number, strength: number): AreaLightSpec => ({ x, y, dist, w: 700, h: 900, angle: 4, strength, blurMm: 60 });

function R(over: RealismSpec): RealismSpec {
  return { relief: true, ...over, af: { breathing: true, ...(over.af ?? {}) } };
}

export const HOLDOUT_SCENARIOS: Scenario[] = [
  // ───── 손떨림 ─────
  {
    id: "holdout/jitter/thermo-mode",
    category: "jitter",
    title: "벽의 온도조절기 모드 버튼을 비춘 채 손떨림 (엔지니어, VP8 450k)",
    target: "thermo",
    pin: "btnMode",
    side: "engineer",
    duration: 5,
    refTime: 0.4,
    view: still({ dx: 1.5, dy: -2, d: 22, yaw: 12, pitch: -9, roll: 4 }),
    jitter: J_MILD,
    seed: 70101,
    holdout: true,
    realism: R({ lens: { k1: -0.07, k2: 0.02 }, isp: ISP_A, area: TUBE(-20, -200, 900, 0.4, -5), codec: { codec: "VP8", kbps: 450 } }),
  },
  {
    id: "holdout/jitter/metal-serial",
    category: "jitter",
    title: "금속 명판 제조번호를 가까이(13cm) 비춤, 초점 헌팅 + 금속 반사 (엔지니어, VP9 350k)",
    target: "metalplate",
    pin: "serial",
    pinOffsetMm: [-9, 0],
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: still({ dx: -0.5, dy: -0.5, d: 13, yaw: -8, pitch: 6, roll: -2 }),
    jitter: J_MILD,
    seed: 70102,
    holdout: true,
    realism: R({
      lens: { k1: -0.1, k2: 0.03, p1: 0.001 },
      isp: ISP_B,
      area: TUBE(10, -60, 700, 0.8, 8, 20),
      af: { hunts: [{ t: 2.1, dur: 0.55, diopters: 6 }] },
      codec: { codec: "VP9", kbps: 350 },
    }),
  },
  // ───── 이동·확대·기울임 ─────
  {
    id: "holdout/motion/ont-lan2-approach",
    category: "motion",
    title: "광모뎀 뒷면 LAN2에 다가가며 비스듬히 (엔지니어, VP8 400k, 초점 헌팅)",
    target: "ont",
    pin: "lan2",
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: 4, dy: -1, d: 32, yaw: -15, pitch: 10, roll: 0 },
      { t: 0.6 },
      { t: 3.8, dx: 0.6, dy: -0.2, d: 17, yaw: 12, pitch: 16, roll: -6 },
    ]),
    jitter: J_MILD,
    seed: 70103,
    holdout: true,
    realism: R({ lens: { k1: -0.09, k2: 0.02 }, isp: ISP_A, area: TUBE(30, -150, 1000, 0.3, 6), af: { hunts: [{ t: 2.3, dur: 0.5, diopters: 5 }] }, codec: { codec: "VP8", kbps: 400 } }),
  },
  {
    id: "holdout/motion/washer-knob-pan",
    category: "motion",
    title: "세탁기 다이얼에서 표시창 쪽으로 훑었다 돌아옴 (엔지니어, VP8 600k)",
    target: "washer",
    pin: "knob",
    side: "engineer",
    duration: 5.5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: 1, dy: -1, d: 36, yaw: 6, pitch: -10 },
      { t: 0.5 },
      { t: 2.6, dx: 8, dy: -2, yaw: -14, pitch: -6 },
      { t: 3.2 },
      { t: 5.2, dx: 0, dy: 0, d: 30, yaw: 4, pitch: -12 },
    ]),
    jitter: J_MILD,
    seed: 70104,
    holdout: true,
    realism: R({ lens: { k1: -0.06 }, isp: ISP_B, area: TUBE(-60, -220, 1100, 0.45, -8), codec: { codec: "VP8", kbps: 600 } }),
  },
  {
    id: "holdout/motion/handheld-screen-ok",
    category: "motion",
    title: "계산대 위 휴대 단말기 화면 '승인 요청' — 위에서 돌리며 기울임, 화면 반사 (엔지니어, VP9 500k)",
    target: "handheld",
    pin: "screenOk",
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: -1, dy: 2, d: 26, yaw: 4, pitch: 14, roll: 0 },
      { t: 0.6 },
      { t: 3.4, dx: 0.5, dy: 1.5, d: 23, yaw: -18, pitch: 28, roll: 32 },
      { t: 5, roll: 26 },
    ]),
    jitter: J_MILD,
    seed: 70105,
    holdout: true,
    realism: R({ lens: { k1: -0.11, k2: 0.03 }, isp: ISP_A, area: TUBE(0, -40, 1400, 0.6, 20, 25), codec: { codec: "VP9", kbps: 500 } }),
  },
  {
    id: "holdout/motion/thermo-customer",
    category: "motion",
    title: "고객 쪽: 온도조절기 ▲ 버튼을 찾은 뒤 다가가며 비틀기 (기준은 VP8 500k 화면)",
    target: "thermo",
    pin: "btnUp",
    side: "customer",
    duration: 5,
    refTime: 0.4,
    latency: 0.35,
    view: path([
      { t: 0, dx: -1, dy: -3, d: 28, yaw: -6, pitch: -8, roll: 3 },
      { t: 1.4 },
      { t: 4.4, dx: -0.3, dy: -0.6, d: 17, yaw: 14, pitch: -14, roll: -18 },
    ]),
    jitter: J_MILD,
    seed: 70106,
    holdout: true,
    realism: R({ lens: { k1: -0.08, k2: 0.02 }, isp: ISP_B, area: TUBE(-20, -200, 900, 0.4, -5), af: { hunts: [{ t: 2.8, dur: 0.6, diopters: 5 }] }, codec: { codec: "VP8", kbps: 500 } }),
  },
  // ───── 반복 패턴 ─────
  {
    id: "holdout/repetitive/panel2-br10-pan",
    category: "repetitive",
    title: "분전반 아래 줄 똑같은 파란 차단기 4번째(br10)를 기울여 훑기 (엔지니어, VP8 450k)",
    target: "panel2",
    pin: "br10",
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: 0.5, dy: -2, d: 40, yaw: 5, pitch: 8 },
      { t: 0.5 },
      { t: 2.6, dx: -9, yaw: 22 },
      { t: 4.8, dx: 7, yaw: -12, d: 36 },
    ]),
    jitter: J_MILD,
    seed: 70107,
    holdout: true,
    realism: R({ lens: { k1: -0.1, k2: 0.02 }, isp: ISP_A, area: TUBE(0, -300, 1100, 0.15, 3, 50), codec: { codec: "VP8", kbps: 450 } }),
  },
  // ───── 무늬 없음 ─────
  {
    id: "holdout/lowtex/appliance-glare",
    category: "lowtex",
    title: "광택 흰 가전 문 빈 곳 + 창문 반사가 크게 지나감 (엔지니어, JPEG 흉내)",
    target: "appliance",
    pin: "blank",
    pinOffsetMm: [-60, 45],
    side: "engineer",
    duration: 4.5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: 1, dy: -2, d: 38, yaw: -4, pitch: 10 },
      { t: 0.5 },
      { t: 4.2, dx: -4, dy: 1, d: 34, yaw: 18, pitch: 4 },
    ]),
    jitter: J_MILD,
    seed: 70108,
    holdout: true,
    realism: R({ lens: { k1: -0.07 }, isp: ISP_C, area: WINDOW(-150, -120, 1200, 1.1) }),
  },
  // ───── 화면 밖 → 복귀 ─────
  {
    id: "holdout/reentry/ont-customer",
    category: "reentry",
    title: "고객 쪽: 광모뎀 LAN3을 찾은 뒤 케이블 쪽(아래)을 봤다가 돌아옴 ×2 (기준 VP8 400k)",
    target: "ont",
    pin: "lan3",
    side: "customer",
    duration: 8,
    refTime: 0.4,
    latency: 0.45,
    view: path(
      awayAndBack({ dx: -0.5, dy: -1, d: 24, yaw: 6, pitch: 12 }, [
        { t: 1.5, away: [2, 24], hold: 1.2, move: 0.7 },
        { t: 5.0, away: [-22, 6], hold: 0.9, move: 0.6 },
      ]),
    ),
    jitter: J_MILD,
    seed: 70109,
    holdout: true,
    realism: R({ lens: { k1: -0.09, k2: 0.02 }, isp: ISP_A, area: TUBE(30, -150, 1000, 0.3, 6), codec: { codec: "VP8", kbps: 400 } }),
  },
  {
    id: "holdout/reentry/washer",
    category: "reentry",
    title: "세탁기 동작 버튼 — 옆 세제통을 봤다가 다른 각도로 복귀 ×2 (엔지니어, VP8 500k)",
    target: "washer",
    pin: "btnStart",
    side: "engineer",
    duration: 7.5,
    refTime: 0.3,
    view: path([
      { t: 0, dx: -1.5, dy: 0, d: 30, yaw: -8, pitch: -8, roll: 0 },
      { t: 0.9 },
      { t: 1.6, dx: 24, dy: -3 },
      { t: 2.7 },
      { t: 3.4, dx: -1, dy: 0.5, d: 26, yaw: 10, roll: 8 },
      { t: 4.4 },
      { t: 5.0, dx: -2, dy: -22, pitch: -24 },
      { t: 5.9 },
      { t: 6.6, dx: -1, dy: 0, d: 32, yaw: -4, pitch: -6, roll: -4 },
    ]),
    jitter: J_MILD,
    seed: 70110,
    holdout: true,
    realism: R({ lens: { k1: -0.08 }, isp: ISP_A, area: TUBE(-60, -220, 1100, 0.45, -8), codec: { codec: "VP8", kbps: 500 } }),
  },
  // ───── 고객 최초 탐색 ─────
  {
    id: "holdout/acquire/ont-lan3",
    category: "acquire",
    title: "고객 쪽 최초 탐색: 광모뎀 노란 LAN3 (옆 포트와 똑같음, 기준 VP8 350k)",
    target: "ont",
    pin: "lan3",
    side: "customer",
    duration: 3,
    refTime: 0.4,
    latency: 0.4,
    view: path([
      { t: 0, dx: -1, dy: -0.5, d: 23, yaw: -9, pitch: 14 },
      { t: 3, dx: -0.5, dy: 0, d: 22, yaw: -5 },
    ]),
    jitter: J_MILD,
    seed: 70111,
    holdout: true,
    realism: R({ lens: { k1: -0.09, k2: 0.02 }, isp: ISP_A, area: TUBE(30, -150, 1000, 0.3, 6), codec: { codec: "VP8", kbps: 350 } }),
  },
  {
    id: "holdout/acquire/handheld-key5",
    category: "acquire",
    title: "고객 쪽 최초 탐색: 휴대 단말기 5번 고무 키, 위에서 비스듬히 (기준 VP8 500k)",
    target: "handheld",
    pin: "key5",
    side: "customer",
    duration: 3,
    refTime: 0.4,
    latency: 0.3,
    view: path([
      { t: 0, dx: 1, dy: -2, d: 24, yaw: 8, pitch: 18, roll: 10 },
      { t: 3, dx: 1.5, dy: -1.5, d: 23, roll: 14 },
    ]),
    jitter: J_MILD,
    seed: 70112,
    holdout: true,
    realism: R({ lens: { k1: -0.11, k2: 0.03 }, isp: ISP_B, area: TUBE(0, -40, 1400, 0.6, 20, 25), codec: { codec: "VP8", kbps: 500 } }),
  },
  {
    id: "holdout/acquire/panel2-elbtest-dark",
    category: "acquire",
    title: "고객 쪽 최초 탐색: 어두운 다용도실 분전반 누전 TEST 버튼 (저대역 VP8 300k ÷2 기준)",
    target: "panel2",
    pin: "elbTest",
    side: "customer",
    duration: 3,
    refTime: 0.4,
    latency: 0.5,
    fps: 15,
    view: path([
      { t: 0, dx: 2, dy: -1, d: 34, yaw: 10, pitch: 6 },
      { t: 3, dx: 2.5, dy: -0.5, d: 33 },
    ]),
    jitter: J_MILD,
    exposureMs: 33,
    light: () => ({ scene: 0.25 }),
    seed: 70113,
    holdout: true,
    realism: R({ lens: { k1: -0.1 }, isp: ISP_C, codec: { codec: "VP8", kbps: 300, scaleDown: 2 } }),
  },
  {
    id: "holdout/acquire/metal-date",
    category: "acquire",
    title: "고객 쪽 최초 탐색: 금속 명판 제조년월 (14cm, 금속 반사, 기준 VP9 400k)",
    target: "metalplate",
    pin: "date",
    pinOffsetMm: [-12, 0],
    side: "customer",
    duration: 3,
    refTime: 0.4,
    latency: 0.35,
    view: path([
      { t: 0, dx: 0.5, dy: -1, d: 15, yaw: 10, pitch: -6 },
      { t: 3, dx: 1, dy: -0.5, d: 14, yaw: 7 },
    ]),
    jitter: J_MILD,
    seed: 70114,
    holdout: true,
    realism: R({ lens: { k1: -0.08, k2: 0.02 }, isp: ISP_B, area: TUBE(10, -60, 700, 0.8, 8, 20), codec: { codec: "VP9", kbps: 400 } }),
  },
  // ───── 스트레스 ─────
  {
    id: "holdout/stress/washer-finger",
    category: "stress",
    title: "고객이 핀 찍힌 탈수 버튼을 손가락으로 누름 (엔지니어, VP8 500k)",
    target: "washer",
    pin: "btnSpin",
    side: "engineer",
    duration: 5,
    refTime: 0.3,
    view: still({ dx: 0.5, dy: -1.5, d: 30, yaw: -6, pitch: -10 }),
    jitter: J_STRONG,
    seed: 70115,
    holdout: true,
    hand: {
      heightMm: 35,
      path: handPath([
        // 손끝이 버튼 너머(위)에 오고 손가락 마디가 버튼을 덮는다 (누르는 자세)
        { t: 0.7, dx: -4, dy: 34, angle: 15 },
        { t: 1.8, dx: -0.4, dy: 1.0, angle: 10 },
        { t: 2.4, dx: 0, dy: -1.3, angle: 8 },
        { t: 3.3, dx: 0.1, dy: -1.1, angle: 9 },
        { t: 4.6, dx: -5, dy: 34, angle: 18 },
      ]),
    },
    realism: R({ lens: { k1: -0.07 }, isp: ISP_B, area: TUBE(-60, -220, 1100, 0.45, -8), codec: { codec: "VP8", kbps: 500 } }),
  },
  // ───── 드리프트 ─────
  {
    id: "holdout/drift/thermo-30s",
    category: "drift",
    title: "온도조절기를 30초 동안 천천히 둘러봄 (엔지니어, JPEG 흉내)",
    target: "thermo",
    pin: "btnDown",
    side: "engineer",
    duration: 30,
    refTime: 0.3,
    view: (ctx) => {
      const P = (a: number, f: number, ph: number) => (t: number) => a * Math.sin(2 * Math.PI * f * t + ph);
      const dx = P(2.5, 0.043, 1.2);
      const dy = P(2.0, 0.057, 0.4);
      const dd = P(4, 0.031, 2.2);
      const yaw = P(16, 0.037, 0.9);
      const pitch = P(12, 0.049, 2.5);
      const roll = P(10, 0.026, 1.7);
      const env = (t: number) => Math.min(1, t / 3) ** 2 * (3 - 2 * Math.min(1, t / 3));
      return (t: number) => {
        const e = env(t);
        const p = ctx.at(e * dx(t) + 0.5, e * dy(t) - 1.5);
        return { x: p.x, y: p.y, dist: ctx.cm(24 + e * dd(t)), yaw: e * yaw(t), pitch: -6 + e * pitch(t), roll: e * roll(t) };
      };
    },
    jitter: J_STILL,
    seed: 70116,
    holdout: true,
    realism: R({ lens: { k1: -0.08, k2: 0.02 }, isp: ISP_A, area: TUBE(-20, -200, 900, 0.4, -5) }),
  },
];
