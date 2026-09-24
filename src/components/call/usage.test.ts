import { describe, expect, it } from "vitest";
import {
  EMPTY_CUSTOMER_SNAPSHOT,
  EMPTY_ENGINEER_SNAPSHOT,
  type CustomerSnapshot,
  type EngineerSnapshot,
} from "@/lib/tracking/session";
import type { AnchorDescriptor, Annotation, TrackUpdate } from "@/lib/tracking/types";
import { CustomerOutcomeTracker, PointerUsageTracker, TRACKABLE_WAIT_MS, engineerChip } from "./usage";

const pin = (id: string, x = 0.5): Annotation => ({ id, kind: "pin", p: { x, y: 0.5 } });
const stroke = (id: string): Annotation => ({
  id,
  kind: "stroke",
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
  ],
});

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
    expect(c).toEqual({ text: "고객 화면 밖 — 화살표 안내 중", tone: "guide" });
    expect(engineerChip(eng({ anchor: a, customerState: "tracking", customerArrow: true }))?.tone).toBe("guide");
  });
});

describe("PointerUsageTracker", () => {
  it("탭 → 새 앵커 핀 1건, 같은 앵커 선 추가 → newAnchor=false", () => {
    const t = new PointerUsageTracker();
    // 누르는 중 (draft만)
    expect(t.observe(eng({ anchor: anchor("a1", [pin("draft")]), trackable: null }), 0)).toEqual([]);
    // 확정 + trackable 이미 나옴
    const e1 = t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: true }), 100);
    expect(e1).toEqual([
      { kind: "pin", newAnchor: true, trackable: true, customerState: null, referenceReason: null, seq: 1 },
    ]);
    // 고객이 찾음
    expect(t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: true, customerState: "tracking" }), 300)).toEqual([]);
    // 같은 앵커에 선 그리는 중 → 확정
    expect(
      t.observe(eng({ anchor: anchor("a1", [pin("p1"), stroke("draft")]), trackable: true, customerState: "lost" }), 400),
    ).toEqual([]);
    const e2 = t.observe(
      eng({ anchor: anchor("a1", [pin("p1"), stroke("s1")]), trackable: true, customerState: "lost" }),
      500,
    );
    // 고객 상태는 누르기 직전 값(tracking) — 그리는 동안 바뀐 값이 아니다
    expect(e2).toEqual([
      { kind: "stroke", newAnchor: false, trackable: true, customerState: "tracking", referenceReason: null, seq: 2 },
    ]);
    expect(t.total()).toBe(2);
  });

  it("새 앵커의 customerState는 이전 앵커의 마지막 상태", () => {
    const t = new PointerUsageTracker();
    t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: true }), 0);
    t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: true, customerState: "lost" }), 10);
    // 다른 곳 탭 → 새 앵커 (고객 상태 초기화됨)
    t.observe(eng({ anchor: anchor("a2", [pin("draft")]), trackable: null, customerState: null }), 20);
    const e = t.observe(eng({ anchor: anchor("a2", [pin("p2")]), trackable: true, customerState: null }), 30);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ newAnchor: true, customerState: "lost", seq: 2 });
  });

  it("trackable 결과를 기다렸다가 보낸다 (최대 1.5초)", () => {
    const t = new PointerUsageTracker();
    expect(t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: null }), 0)).toEqual([]);
    const e = t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: false, referenceReason: "low_texture" }), 50);
    expect(e).toEqual([
      { kind: "pin", newAnchor: true, trackable: false, customerState: null, referenceReason: "low_texture", seq: 1 },
    ]);

    const t2 = new PointerUsageTracker();
    t2.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: null }), 0);
    expect(t2.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: null }), TRACKABLE_WAIT_MS - 1)).toEqual([]);
    const late = t2.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: null }), TRACKABLE_WAIT_MS);
    expect(late).toHaveLength(1);
    expect(late[0].trackable).toBeNull();
  });

  it("보류 중에 지우면 보류 건을 그대로 내보낸다, flush도", () => {
    const t = new PointerUsageTracker();
    t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: null }), 0);
    expect(t.observe(eng({}), 10)).toHaveLength(1);
    t.observe(eng({ anchor: anchor("a2", [pin("p2")]), trackable: null }), 20);
    expect(t.flush()).toHaveLength(1);
    expect(t.flush()).toHaveLength(0);
  });

  it("취소(이전 앵커로 복귀)·그리는 중은 이벤트가 아니다, 지운 뒤 다시 탭하면 새 앵커", () => {
    const t = new PointerUsageTracker();
    t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: true }), 0);
    t.observe(eng({ anchor: anchor("a2", [pin("draft")]), trackable: null }), 10);
    expect(t.observe(eng({ anchor: anchor("a1", [pin("p1")]), trackable: true }), 20)).toEqual([]);
    expect(t.observe(eng({}), 30)).toEqual([]);
    const e = t.observe(eng({ anchor: anchor("a1", [pin("p9")]), trackable: true }), 40);
    expect(e[0]).toMatchObject({ newAnchor: true, seq: 2 });
  });
});

function cust(p: Partial<CustomerSnapshot>): CustomerSnapshot {
  return { ...EMPTY_CUSTOMER_SNAPSHOT, ...p };
}

describe("CustomerOutcomeTracker", () => {
  it("탐색 → 추적 → 카드 → 교체: 시간 구간 합", () => {
    const t = new CustomerOutcomeTracker();
    const a1 = anchor("a1", [pin("p1")]);
    expect(t.observe(cust({ anchor: a1 }), 1000)).toBeNull(); // 받음 (searching)
    t.observe(cust({ anchor: a1, update: upd("a1", "tracking") }), 1300); // 300ms 뒤 찾음
    t.observe(cust({ anchor: a1, update: upd("a1", "lost") }), 2300); // 1초 추적
    t.observe(cust({ anchor: a1, update: upd("a1", "lost"), showCard: true }), 3100); // 0.8초 뒤 카드
    t.observe(cust({ anchor: a1, update: upd("a1", "tracking") }), 3600); // 카드 0.5초 → 다시 찾음
    const done = t.observe(cust({ anchor: anchor("a2", [pin("p2")]) }), 4000); // 0.4초 추적 후 교체
    expect(done).toEqual({
      side: "customer",
      anchor_ms: 3000,
      acquire_ms: 300,
      tracked_ms: 1400,
      tracked_fraction: 0.467,
      card_ms: 500,
      arrow_ms: 0,
      annotations: 1,
      end: "replaced",
    });
    const last = t.finish(4500, "ended");
    expect(last).toMatchObject({ anchor_ms: 500, acquire_ms: null, tracked_ms: 0, end: "ended" });
    expect(t.finish(5000, "ended")).toBeNull();
  });

  it("화살표 시간, 지움, H 없는 weak는 표시가 아니다", () => {
    const t = new CustomerOutcomeTracker();
    const a1 = anchor("a1", [pin("p1"), pin("draft")]);
    t.observe(cust({ anchor: a1, update: upd("a1", "weak", false) }), 0);
    t.observe(cust({ anchor: a1, update: upd("a1", "lost"), arrow: true }), 200);
    const done = t.observe(cust({}), 700);
    expect(done).toMatchObject({ acquire_ms: null, tracked_ms: 0, arrow_ms: 500, annotations: 1, end: "cleared" });
  });
});
