// 실감(realism) 묶음: base 시나리오와 같은 궤적·대상에 폰 카메라다운 효과를 켠 변형 (id = "real/<원본 id>").
// 원본과 나란히 비교할 수 있게 궤적·핀·시드는 그대로 두고 효과만 더한다 (--compare-variants 표).
//   렌즈 왜곡(k1 −0.05…−0.12) · 입체 부조(키·버튼 돌출, 포트 함몰) · ISP(톤 곡선·TNR 번짐·샤프닝 테)
//   · 초점 호흡·헌팅 · 면광원 정반사 · (엔지니어 쪽 일부) 실제 WebRTC 코덱(VP8/VP9) · (고객 쪽 일부) 코덱 기준 이미지
import type { IspSpec } from "./isp";
import type { AreaLightSpec, RealismSpec, Scenario } from "./scenarios";
import { SCENARIOS } from "./scenarios";
import type { TargetId } from "./textures";

/** 흔한 폰 ISP: 약한 S커브, 중간 샤프닝, 움직임 적응 TNR */
export const ISP_TYPICAL: IspSpec = {
  tone: { gamma: 1.08, s: 0.18, lift: 0.015 },
  sharpen: { sigma: 1.0, amount: 0.8, threshold: 2 },
  tnr: { alpha: 0.4, lo: 3, hi: 9, window: 5 },
};
/** 강한 ISP (저가 폰·어두운 곳): 센 샤프닝, 강한 TNR(잔상), 높은 대비 */
export const ISP_STRONG: IspSpec = {
  tone: { gamma: 1.15, s: 0.28, lift: 0.03 },
  sharpen: { sigma: 1.3, amount: 1.4, threshold: 3 },
  tnr: { alpha: 0.28, lo: 4, hi: 14, window: 6 },
};

/** 대상별 천장 조명(형광등) 반사 — 광택 정도에 따라 세기 */
export const AREA_LIGHT: Partial<Record<TargetId, AreaLightSpec>> = {
  pos: { x: 20, y: -60, dist: 1300, w: 1100, h: 70, angle: 12, strength: 0.55, blurMm: 30 },
  boiler: { x: -40, y: -220, dist: 900, w: 1000, h: 90, angle: -6, strength: 0.45, blurMm: 25 },
  router: { x: 30, y: -180, dist: 1000, w: 900, h: 80, angle: 8, strength: 0.12, blurMm: 60 },
  breaker: { x: 0, y: -250, dist: 1100, w: 1200, h: 80, angle: 3, strength: 0.18, blurMm: 50 },
  appliance: { x: 60, y: -200, dist: 1000, w: 900, h: 110, angle: 10, strength: 0.9, blurMm: 20 },
  nameplate: { x: -30, y: -120, dist: 800, w: 700, h: 60, angle: -12, strength: 0.35, blurMm: 25 },
};

export function realism(target: TargetId, over: Partial<RealismSpec> = {}): RealismSpec {
  return {
    lens: { k1: -0.08, k2: 0.02, p1: 0.0006, p2: -0.0004 },
    relief: true,
    isp: ISP_TYPICAL,
    af: { breathing: true },
    area: AREA_LIGHT[target],
    ...over,
  };
}

const VP8 = (kbps: number, scaleDown?: number) => ({ codec: "VP8" as const, kbps, ...(scaleDown ? { scaleDown } : {}) });

function variant(id: string, over: Partial<RealismSpec> = {}, extra: Partial<Scenario> = {}): Scenario {
  const base = SCENARIOS.find((s) => s.id === id);
  if (!base) throw new Error(`realism variant: base ${id} missing`);
  const r = realism(base.target, over);
  const tag = r.codec ? ` [${r.codec.codec} ${r.codec.kbps}k${r.codec.scaleDown ? ` ÷${r.codec.scaleDown}` : ""}]` : "";
  return { ...base, ...extra, id: `real/${id}`, variantOf: id, title: `${base.title} + 실감${tag}`, realism: r };
}

export const REALISM_SCENARIOS: Scenario[] = [
  // 손떨림
  variant("jitter/mild/pos"),
  variant("jitter/strong/router", { lens: { k1: -0.11, k2: 0.03 }, isp: ISP_STRONG }),
  // 이동·확대·기울임
  variant("motion/pan/boiler", { codec: VP8(500) }),
  variant("motion/zoom-in/pos", { codec: VP8(600), af: { breathing: true, hunts: [{ t: 1.6, dur: 0.5, diopters: 5 }] } }),
  variant("motion/tilt45/router", { lens: { k1: -0.06 } }),
  variant("motion/tilt60/boiler", { lens: { k1: -0.1, k2: 0.02 } }),
  variant("motion/roll90/pos", { codec: { codec: "VP9", kbps: 400 } }),
  variant("motion/zoom-customer/boiler", {
    codec: VP8(500),
    af: { breathing: true, hunts: [{ t: 2.2, dur: 0.6, diopters: 6 }] },
  }),
  // 반복 패턴
  variant("repetitive/router-lan3/pan", { codec: VP8(350, 2) }),
  variant("repetitive/breaker5/zoom", { lens: { k1: -0.12, k2: 0.03 } }),
  // 무늬 없음 (광택 흰 패널 + 형광등 반사)
  variant("lowtex/appliance/move"),
  // 화면 밖 → 복귀
  variant("reentry/pos", { codec: VP8(500) }),
  variant("reentry/boiler-customer", { isp: ISP_STRONG }),
  // 고객 최초 탐색 — 기준 이미지가 실제 코덱을 거친 엔지니어 화면
  variant("acquire/pos", { codec: VP8(500) }),
  variant("acquire/router-lan3", { codec: VP8(400) }),
  variant("acquire/boiler", { codec: VP8(500), af: { breathing: true, hunts: [{ t: 0.9, dur: 0.5, diopters: 4 }] } }),
  variant("acquire/breaker5", { codec: VP8(300, 2) }),
  // 스트레스
  variant("stress/hand/pos"),
  variant("stress/shake/boiler", { isp: ISP_STRONG }),
];
