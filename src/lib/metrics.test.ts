import { describe, expect, it } from "vitest";
import { computeMetrics, endedConnected, type MetricEvent } from "./metrics";

const ev = (room_id: string, name: string, props: Record<string, unknown> | null = {}): MetricEvent => ({
  room_id,
  name,
  props,
});

describe("endedConnected", () => {
  it("지금 기록: connected가 true일 때만 연결된 상담", () => {
    expect(endedConnected({ duration_sec: 300, connected: true })).toBe(true);
    expect(endedConnected({ duration_sec: 300, connected: false })).toBe(false);
  });

  it("예전 기록: 해결 여부를 답했으면(true/false) 연결된 상담, null이면 연결 없이 닫은 상담", () => {
    expect(endedConnected({ duration_sec: 300, resolved_remotely: true })).toBe(true);
    expect(endedConnected({ duration_sec: 300, resolved_remotely: false })).toBe(true);
    expect(endedConnected({ duration_sec: 300, resolved_remotely: null })).toBe(false);
  });

  it("이벤트가 없거나 비어 있으면 연결 안 됨", () => {
    expect(endedConnected(null)).toBe(false);
    expect(endedConnected(undefined)).toBe(false);
    expect(endedConnected({})).toBe(false);
    // 문자열 'true' 같은 이상한 값은 믿지 않는다
    expect(endedConnected({ connected: "true" })).toBe(false);
  });

  it("예전 방에 답(rooms.resolved_remotely)이 남아 있으면 이벤트가 없어도 연결된 상담", () => {
    expect(endedConnected(null, true)).toBe(true);
    expect(endedConnected(undefined, false)).toBe(true);
    expect(endedConnected({ connected: false }, false)).toBe(true);
    expect(endedConnected(null, null)).toBe(false);
    expect(endedConnected({ connected: true }, null)).toBe(true);
  });
});

describe("computeMetrics", () => {
  it("상담이 없으면 비율 분모가 0이고 평균은 없음", () => {
    const m = computeMetrics([], []);
    expect(m.sessions).toBe(0);
    expect(m.linkToCamera).toEqual({ hit: 0, of: 0 });
    expect(m.avgDurationSec).toBeNull();
    expect(m.durationCount).toBe(0);
    expect(m).not.toHaveProperty("resolvedRemotely");
  });

  it("평균 시간: 연결됐다 끝난 상담만(지금 기록 connected:true + 예전 기록 resolved_remotely true/false)", () => {
    const rooms = ["new-on", "new-off", "old-yes", "old-no", "old-null", "open"].map((id) => ({ id }));
    const m = computeMetrics(rooms, [
      ev("new-on", "ended", { duration_sec: 600, connected: true }),
      ev("new-off", "ended", { duration_sec: 9_000, connected: false }), // 연결 없이 닫음 → 뺀다
      ev("old-yes", "ended", { duration_sec: 300, resolved_remotely: true }),
      ev("old-no", "ended", { duration_sec: 900, resolved_remotely: false }),
      ev("old-null", "ended", { duration_sec: 9_000, resolved_remotely: null }), // 예전 '연결 없이 닫음' → 뺀다
    ]);
    expect(m.sessions).toBe(6);
    expect(m.durationCount).toBe(3);
    expect(m.avgDurationSec).toBe((600 + 300 + 900) / 3);
  });

  it("평균 시간: 'ended'에 해결 여부가 없던 예전 기록(2026-09-24 전)은 방의 답(rooms.resolved_remotely)으로 가린다 — 대시보드와 같은 판정", () => {
    const m = computeMetrics(
      [
        { id: "old-room-yes", resolved_remotely: true },
        { id: "old-room-null", resolved_remotely: null },
        { id: "new", resolved_remotely: null },
      ],
      [
        ev("old-room-yes", "ended", { duration_sec: 400 }),
        ev("old-room-null", "ended", { duration_sec: 9_000 }),
        ev("new", "ended", { duration_sec: 200, connected: true }),
      ],
    );
    expect(m.durationCount).toBe(2);
    expect(m.avgDurationSec).toBe(300);
  });

  it("평균 시간: duration_sec가 숫자가 아니거나 props가 없으면 뺀다", () => {
    const m = computeMetrics([{ id: "a" }, { id: "b" }, { id: "c" }], [
      ev("a", "ended", { duration_sec: "600", connected: true }),
      ev("b", "ended", null),
      ev("c", "ended", { duration_sec: 120, connected: true }),
    ]);
    expect(m.durationCount).toBe(1);
    expect(m.avgDurationSec).toBe(120);
  });

  it("평균 시간도 세션 단위: 한 상담에 ended가 두 번 남아도 한 번만 센다", () => {
    const m = computeMetrics([{ id: "a" }, { id: "b" }], [
      ev("a", "ended", { duration_sec: 100, connected: true }),
      ev("a", "ended", { duration_sec: 500, connected: true }),
      ev("b", "ended", { duration_sec: 300, connected: true }),
    ]);
    expect(m.durationCount).toBe(2);
    expect(m.avgDurationSec).toBe(200);
  });

  it("기간 밖(목록에 없는) 상담의 이벤트는 세지 않는다", () => {
    const m = computeMetrics([{ id: "a" }], [
      ev("a", "link_opened"),
      ev("zzz", "link_opened"),
      ev("zzz", "camera_granted"),
      ev("zzz", "ended", { duration_sec: 999, connected: true }),
    ]);
    expect(m.linkToCamera).toEqual({ hit: 0, of: 1 });
    expect(m.connectFailure).toEqual({ hit: 0, of: 0 });
    expect(m.durationCount).toBe(0);
  });

  it("비율은 이벤트 개수가 아니라 상담 수로 센다", () => {
    const rooms = ["a", "b", "c", "d"].map((id) => ({ id }));
    const m = computeMetrics(rooms, [
      // a: 링크 두 번 열고 카메라 허용, 두 번 연결(재연결), 중계, 포인터·멈춤
      ev("a", "link_opened"),
      ev("a", "link_opened"),
      ev("a", "camera_granted"),
      ev("a", "connected"),
      ev("a", "connected"),
      ev("a", "relay_used"),
      ev("a", "relay_used"),
      ev("a", "pointer_used"),
      ev("a", "freeze_used"),
      // b: 카메라 허용했지만 연결 기록 없음 → 연결 실패(추정)
      ev("b", "link_opened"),
      ev("b", "camera_granted"),
      // c: 링크만 열고 거부
      ev("c", "link_opened"),
      ev("c", "camera_denied"),
      // d: 연결됐고 포인터만
      ev("d", "link_opened"),
      ev("d", "camera_granted"),
      ev("d", "connected"),
      ev("d", "pointer_used"),
    ]);
    expect(m.linkToCamera).toEqual({ hit: 3, of: 4 });
    expect(m.connectFailure).toEqual({ hit: 1, of: 3 });
    expect(m.relay).toEqual({ hit: 1, of: 2 });
    expect(m.pointerUsed).toEqual({ hit: 2, of: 2 });
    expect(m.freezeUsed).toEqual({ hit: 1, of: 2 });
  });
});
