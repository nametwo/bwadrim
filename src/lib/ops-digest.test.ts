import { describe, expect, it } from "vitest";
import { computeDigest, digestNeedsAlert, kstDayRange, percentile, type DigestEvent } from "./ops-digest";

const prod = { env: "production" };
let n = 0;
function ev(room: string, name: string, props: Record<string, unknown> = {}, actor = "customer", sec = n++): DigestEvent {
  return { room_id: room, actor, name, props: { ...prod, ...props }, created_at: new Date(Date.UTC(2026, 8, 27, 1, 0, sec)).toISOString() };
}

describe("computeDigest", () => {
  it("양쪽 모두 준비된 상담만 실패율 분모, 엔지니어 미준비는 따로", () => {
    const rooms = ["a", "b", "c", "d"].map((id) => ({ id, resolved_remotely: id === "a" ? true : id === "b" ? false : null }));
    const events: DigestEvent[] = [
      // a: 정상 연결
      ev("a", "room_created", {}, "engineer"),
      ev("a", "camera_granted", {}, "customer", 0),
      ev("a", "call_ready", {}, "customer"),
      ev("a", "call_ready", {}, "engineer"),
      ev("a", "connected", {}, "customer", 10),
      ev("a", "relay_used"),
      // b: 둘 다 준비됐는데 ICE 실패
      ev("b", "camera_granted"),
      ev("b", "call_ready", {}, "customer"),
      ev("b", "call_ready", {}, "engineer"),
      ev("b", "call_failed", { stage: "ice" }),
      ev("b", "call_failed", { stage: "ice" }, "engineer"),
      ev("b", "call_stuck", { stage: "ice" }),
      // c: 엔지니어 미준비
      ev("c", "camera_granted"),
      ev("c", "call_ready", {}, "customer"),
      ev("c", "camera_denied", { reason: "NotAllowedError" }),
      // d: 로컬 개발 상담 — 빠져야 한다
      ev("d", "room_created", { env: "development" }, "engineer"),
      ev("d", "call_failed", { stage: "ice", env: "development" }),
      ev("x", "turn_fallback", { reason: "cf_http" }), // 기간 밖 상담
    ];
    const d = computeDigest(rooms, events, [
      { room_id: "a", actor: "engineer", report: { ...prod, quality: { rtt_p50: 80, loss_pct: 1 } } },
    ]);
    expect(d.sessions).toBe(3);
    expect(d.connectFailure).toEqual({ hit: 1, of: 2 });
    expect(d.engineerNotReady).toBe(1);
    expect(d.failedByStage).toEqual({ ice: 1 }); // 상담 단위 (양쪽 기록은 하나로)
    expect(d.stuckByStage).toEqual({ ice: 1 });
    expect(d.relay).toEqual({ hit: 1, of: 1 });
    expect(d.resolved).toEqual({ hit: 1, of: 2 });
    expect(d.cameraDenied).toEqual({ NotAllowedError: 1 });
    expect(d.turnFallback).toBe(0);
    expect(d.connectSec.n).toBe(1);
    expect(d.connectSec.p50).toBeGreaterThan(0);
    expect(d.quality).toEqual({ rttP50: 80, lossPct: 1, n: 1 });
  });

  it("5% 초과는 20건 이상일 때만, TURN 폴백은 1건이라도 응급", () => {
    const base = computeDigest([], [], []);
    expect(digestNeedsAlert({ ...base, connectFailure: { hit: 2, of: 10 } })).toEqual([]);
    expect(digestNeedsAlert({ ...base, connectFailure: { hit: 2, of: 20 } })).toHaveLength(1);
    expect(digestNeedsAlert({ ...base, turnFallback: 1, turnFallbackReasons: { cf_timeout: 1 } })[0]).toContain("cf_timeout");
  });
});

describe("percentile", () => {
  it("가까운 순위 방식", () => {
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("kstDayRange", () => {
  it("날짜가 없으면 한국 시간 어제 0시~24시", () => {
    // 2026-09-28 00:00 UTC = 한국 09:00 → 어제 = 9월 27일
    const r = kstDayRange(null, Date.UTC(2026, 8, 28, 0, 0))!;
    expect(r.label).toBe("2026-09-27");
    expect(r.start.toISOString()).toBe("2026-09-26T15:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-09-27T15:00:00.000Z");
  });
  it("날짜를 주면 그날, 형식이 틀리면 null", () => {
    expect(kstDayRange("2026-09-01")!.start.toISOString()).toBe("2026-08-31T15:00:00.000Z");
    expect(kstDayRange("9/1")).toBeNull();
  });
});
