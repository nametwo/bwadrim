import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallTelemetry, STAGE_LIMIT_MS, type CallSignal } from "./call-telemetry";

let signals: CallSignal[];
let t: CallTelemetry;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  signals = [];
  t = new CallTelemetry((s) => signals.push(s), { watchPage: false });
});

afterEach(() => {
  t.dispose();
  vi.useRealTimers();
});

const of = (type: CallSignal["type"]) => signals.filter((s) => s.type === type);

function joinReady(track: "ok" | "timed out" = "ok") {
  t.joinStarted();
  t.authReady();
  t.laneStatus("send", "SUBSCRIBED");
  t.laneStatus("listen", "SUBSCRIBED");
  t.tracked(track);
}

describe("준비(call_ready)", () => {
  it("두 채널 입장 + presence 등록 결과가 모두 오면 한 번", () => {
    t.joinStarted();
    vi.advanceTimersByTime(300);
    t.authReady();
    t.laneStatus("listen", "SUBSCRIBED");
    t.tracked("ok");
    expect(of("ready")).toHaveLength(0);
    t.laneStatus("send", "SUBSCRIBED");
    expect(of("ready")).toEqual([{ type: "ready", ms: 300, track: "ok" }]);
    t.laneStatus("send", "SUBSCRIBED"); // 다시 들어감 — 또 보내지 않는다
    expect(of("ready")).toHaveLength(1);
    expect(t.snapshot().lanes.send.rejoins).toBe(1);
  });

  it("15초 안에 준비가 안 되면 call_stuck(signaling), 어디서 막혔는지 sub", () => {
    t.joinStarted();
    t.authReady();
    t.laneStatus("send", "SUBSCRIBED");
    vi.advanceTimersByTime(STAGE_LIMIT_MS.signaling);
    expect(of("stuck")).toEqual([
      { type: "stuck", stage: "signaling", reason: "join_timeout", ms: STAGE_LIMIT_MS.signaling, attempt: 0, sub: "subscribe:listen" },
    ]);
  });

  it("presence 등록이 시간 초과였고 연결이 시작되지 않으면 call_stuck(presence)", () => {
    joinReady("timed out");
    vi.advanceTimersByTime(STAGE_LIMIT_MS.presence);
    expect(of("stuck").map((s) => s.type === "stuck" && s.reason)).toEqual(["presence_unconfirmed"]);
  });

  it("presence 시간 초과여도 연결이 시작되면 알리지 않는다", () => {
    joinReady("timed out");
    t.pcCreated();
    vi.advanceTimersByTime(STAGE_LIMIT_MS.presence);
    expect(of("stuck")).toHaveLength(0);
  });
});

describe("연결 시도", () => {
  it("offer 뒤 answer가 안 오면 negotiation, 연결이 안 되면 ice로 각각 한 번", () => {
    joinReady();
    t.pcCreated();
    t.offerSent();
    vi.advanceTimersByTime(STAGE_LIMIT_MS.ice);
    expect(of("stuck").map((s) => s.type === "stuck" && `${s.stage}:${s.reason}`)).toEqual([
      "negotiation:no_answer",
      "ice:not_connected",
    ]);
  });

  it("연결되면 타이머를 멈추고 connected는 확인 때 한 번(재연결 표시)", () => {
    joinReady();
    t.pcCreated();
    t.offerSent();
    t.answerApplied();
    vi.advanceTimersByTime(2000);
    t.pcState("connected");
    t.confirmConnected({ relay: true, path: "relay/srflx" });
    vi.advanceTimersByTime(STAGE_LIMIT_MS.ice);
    expect(of("stuck")).toHaveLength(0);
    expect(of("connected")[0]).toMatchObject({ attempt: 1, reconnect: false, relay: true, ms_since_offer: 2000 });
    t.pcCreated();
    t.pcState("connected");
    t.confirmConnected({ relay: false, path: null });
    expect(of("connected")[1]).toMatchObject({ attempt: 2, reconnect: true });
  });

  it("연결 뒤 disconnected가 15초 이어지면 in_call 지연, 끊긴 시간을 센다", () => {
    joinReady();
    t.pcCreated();
    t.pcState("connected");
    t.pcState("disconnected");
    vi.advanceTimersByTime(STAGE_LIMIT_MS.inCall);
    expect(of("stuck")[0]).toMatchObject({ stage: "in_call", reason: "disconnected" });
    t.pcState("connected");
    expect(t.snapshot()).toMatchObject({ disconnects: 1, disconnected_ms: STAGE_LIMIT_MS.inCall });
  });

  it("잠깐 끊겼다 곧 돌아오면 지연으로 알리지 않는다", () => {
    joinReady();
    t.pcCreated();
    t.pcState("connected");
    t.pcState("disconnected");
    vi.advanceTimersByTime(3000);
    t.pcState("connected");
    vi.advanceTimersByTime(STAGE_LIMIT_MS.inCall);
    expect(of("stuck")).toHaveLength(0);
  });
});

describe("실패(call_failed)", () => {
  it("시도마다 처음 실패 하나만 — 원인이 먼저 남은 뒤의 ICE failed는 버린다", () => {
    joinReady();
    t.pcCreated();
    t.fail("negotiation", "offer_error", new TypeError("bad sdp"));
    t.fail(null, "failed");
    expect(of("failed")).toHaveLength(1);
    expect(of("failed")[0]).toMatchObject({ stage: "negotiation", reason: "offer_error", err: "TypeError: bad sdp", after_connected: false });
    t.pcCreated(); // 다음 시도는 새로 센다
    t.fail(null, "failed");
    expect(of("failed")).toHaveLength(2);
    expect(of("failed")[1]).toMatchObject({ stage: "ice", attempt: 2 });
  });

  it("연결된 뒤의 ICE failed는 in_call, 연결 이후 끊김 횟수를 붙인다", () => {
    joinReady();
    t.pcCreated();
    t.pcState("connected");
    t.pcState("disconnected");
    t.fail(null, "failed", undefined, "failed");
    expect(of("failed")[0]).toMatchObject({ stage: "in_call", after_connected: true, disconnects_since_connected: 1 });
  });

  it("연결 중 상대 presence가 사라지면 peer_gone, 연결 전이면 실패가 아니다", () => {
    joinReady();
    t.pcCreated();
    t.presenceLost("new");
    expect(of("failed")).toHaveLength(0);
    t.pcState("connected");
    t.presenceLost("connected");
    expect(of("failed")[0]).toMatchObject({ stage: "in_call", reason: "peer_gone", pc_state: "connected" });
    expect(t.snapshot().peer_left).toBe(2);
  });

  it("엔지니어: presence 없이 맡아 둔 offer가 15초를 넘기면 알린다", () => {
    joinReady();
    t.offerHeld();
    vi.advanceTimersByTime(STAGE_LIMIT_MS.offerHold);
    expect(of("stuck")[0]).toMatchObject({ stage: "presence", reason: "offer_without_presence" });
  });
});
