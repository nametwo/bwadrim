import { describe, expect, it } from "vitest";
import { EMPTY_ENGINEER_SNAPSHOT, type EngineerSnapshot } from "@/lib/tracking/session";
import type { AnchorDescriptor, Annotation, TrackUpdate } from "@/lib/tracking/types";
import { customerUntrackable, engineerChip, needsRetap, referenceToast } from "./usage";

const pin = (id: string, x = 0.5): Annotation => ({ id, kind: "pin", p: { x, y: 0.5 } });

function anchor(id: string, annotations: Annotation[]): AnchorDescriptor {
  return { id, refWidth: 320, refHeight: 240, roi: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, annotations };
}

function eng(p: Partial<EngineerSnapshot>): EngineerSnapshot {
  return { ...EMPTY_ENGINEER_SNAPSHOT, ...p };
}

function upd(anchorId: string, state: TrackUpdate["state"], withH = state === "tracking" || state === "weak"): TrackUpdate {
  return {
    anchorId,
    state,
    H: withH ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : null,
    hint: null,
    confidence: 1,
    refSize: { width: 320, height: 240 },
    frameSize: { width: 320, height: 240 },
    processMs: 3,
  };
}

describe("engineerChip", () => {
  it("확정 주석이 없으면 숨김 (그리는 중 포함)", () => {
    expect(engineerChip(eng({}))).toBeNull();
    expect(engineerChip(eng({ anchor: anchor("a1", [pin("draft")]) }))).toBeNull();
  });

  it("고객 상태별 문구", () => {
    const a = anchor("a1", [pin("p1")]);
    expect(engineerChip(eng({ anchor: a, customerState: "tracking" }))?.text).toBe("고객 화면에 표시 중");
    expect(engineerChip(eng({ anchor: a, customerState: "weak" }))?.text).toBe("고객 화면에 표시 중");
    expect(engineerChip(eng({ anchor: a, customerState: "searching" }))?.text).toBe("고객 화면에서 찾는 중…");
    expect(engineerChip(eng({ anchor: a, customerState: "lost" }))?.text).toBe("고객 화면에서 놓침");
    expect(engineerChip(eng({ anchor: a, customerState: null }))?.text).toBe("고객에게 보내는 중…");
  });

  it("무늬 부족이면 사진 카드 안내", () => {
    const a = anchor("a1", [pin("p1")]);
    expect(engineerChip(eng({ anchor: a, customerState: "searching", customerReason: "untrackable" }))?.text).toBe(
      "고객에게 사진 카드로 안내 중",
    );
    expect(engineerChip(eng({ anchor: a, customerState: "lost", trackable: false }))?.text).toBe("고객에게 사진 카드로 안내 중");
    // 고객이 찾았으면(드묾) 그대로 표시 중
    expect(engineerChip(eng({ anchor: a, customerState: "tracking", trackable: false }))?.text).toBe("고객 화면에 표시 중");
  });

  it("고객 화살표 안내가 우선", () => {
    const a = anchor("a1", [pin("p1")]);
    const c = engineerChip(eng({ anchor: a, customerState: "lost", customerArrow: true }));
    expect(c).toEqual({ text: "고객 화면 밖이라 화살표로 안내 중", tone: "guide" });
    expect(engineerChip(eng({ anchor: a, customerState: "tracking", customerArrow: true }))?.tone).toBe("guide");
  });
});

describe("엔지니어 안내: 기준 토스트 · 다시 탭", () => {
  it("기준 설정 결과별 토스트", () => {
    expect(referenceToast({ trackable: null, referenceReason: null })).toBeNull();
    expect(referenceToast({ trackable: true, referenceReason: null })).toBeNull();
    expect(referenceToast({ trackable: false, referenceReason: "low_texture" })).toBe(
      "무늬가 적어서 붙이기 어려워요. 사진 카드로 보여 줄게요",
    );
    expect(referenceToast({ trackable: false, referenceReason: null })).toBe(
      "무늬가 적어서 붙이기 어려워요. 사진 카드로 보여 줄게요",
    );
    expect(referenceToast({ trackable: false, referenceReason: "pin_blank" })).toBe(
      "표시한 곳 주변에 무늬가 적어서 사진 카드로 보여 줄게요",
    );
    expect(referenceToast({ trackable: true, referenceReason: "ambiguous" })).toBe(
      "비슷한 무늬가 많아서 사진 카드로 보여 줄게요",
    );
  });

  it("추적 가능하던 기준을 놓쳤고 다시 못 찾음(untrackable)일 때만 다시 탭", () => {
    const a = anchor("a1", [pin("p1")]);
    const lostU: TrackUpdate = { ...upd("a1", "lost"), reason: "untrackable" };
    expect(needsRetap(eng({ anchor: a, update: lostU, trackable: true }))).toBe(true);
    expect(needsRetap(eng({ anchor: a, update: { ...lostU, state: "searching" }, trackable: true }))).toBe(true);
    // 다른 이유로 놓침 (화면 밖·검증 실패) → 스스로 다시 찾는다
    expect(needsRetap(eng({ anchor: a, update: { ...lostU, reason: "offscreen" }, trackable: true }))).toBe(false);
    expect(needsRetap(eng({ anchor: a, update: { ...lostU, reason: "unverified" }, trackable: true }))).toBe(false);
    // 추적 중, 정지 화면, 처음부터 추적 불가(토스트), 다른 앵커의 갱신, 그리는 중
    expect(needsRetap(eng({ anchor: a, update: upd("a1", "tracking"), trackable: true }))).toBe(false);
    expect(needsRetap(eng({ anchor: a, update: lostU, trackable: true, frozen: true }))).toBe(false);
    expect(needsRetap(eng({ anchor: a, update: lostU, trackable: false }))).toBe(false);
    expect(needsRetap(eng({ anchor: a, update: { ...lostU, anchorId: "a0" }, trackable: true }))).toBe(false);
    expect(needsRetap(eng({ anchor: anchor("a1", [pin("p1"), pin("draft")]), update: lostU, trackable: true }))).toBe(false);
  });

  it("고객: untrackable이면 바로 카드", () => {
    expect(customerUntrackable(null)).toBe(false);
    expect(customerUntrackable({ state: "searching", reason: "untrackable" })).toBe(true);
    expect(customerUntrackable({ state: "lost", reason: "untrackable" })).toBe(true);
    expect(customerUntrackable({ state: "lost", reason: "offscreen" })).toBe(false);
    expect(customerUntrackable({ state: "tracking", reason: "untrackable" })).toBe(false);
  });
});
