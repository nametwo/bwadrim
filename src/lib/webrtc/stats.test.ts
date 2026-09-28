import { describe, expect, it } from "vitest";
import { readSample, summarize, type StatsSample } from "./stats";

type R = Record<string, unknown> & { type: string; id: string };

function reports(opts: { relay?: boolean; bytes?: number; recv?: number; lost?: number; rtt?: number; fps?: number; inBytes?: number }): R[] {
  return [
    { type: "transport", id: "T", selectedCandidatePairId: "P" },
    {
      type: "candidate-pair",
      id: "P",
      localCandidateId: "L",
      remoteCandidateId: "RC",
      currentRoundTripTime: opts.rtt ?? 0.05,
      bytesSent: (opts.bytes ?? 0) / 2,
      bytesReceived: (opts.bytes ?? 0) / 2,
    },
    { type: "local-candidate", id: "L", candidateType: opts.relay ? "relay" : "host" },
    { type: "remote-candidate", id: "RC", candidateType: "srflx" },
    {
      type: "inbound-rtp",
      id: "V",
      kind: "video",
      packetsReceived: opts.recv ?? 0,
      packetsLost: opts.lost ?? 0,
      bytesReceived: opts.inBytes ?? 0,
      framesPerSecond: opts.fps,
    },
  ];
}

describe("readSample", () => {
  it("선택된 경로·RTT·경로 종류를 읽는다", () => {
    const { sample } = readSample(reports({ rtt: 0.12 }), 0, null);
    expect(sample.rttMs).toBe(120);
    expect(sample.relay).toBe(false);
    expect(sample.path).toBe("host/srflx");
    expect(sample.lossPct).toBeNull(); // 첫 표본은 비교할 앞 값이 없다
  });

  it("앞 표본과의 차이로 손실률·속도·TURN 바이트를 잰다", () => {
    const first = readSample(reports({ relay: true, bytes: 1000, recv: 100, lost: 0, inBytes: 0 }), 0, null);
    expect(first.sample.relayBytes).toBe(1000);
    const second = readSample(reports({ relay: true, bytes: 6000, recv: 190, lost: 10, inBytes: 5000, fps: 24 }), 5000, first.cursor);
    expect(second.sample.lossPct).toBeCloseTo(10); // 90 받고 10 잃음
    expect(second.sample.kbpsIn).toBeCloseTo(8); // 5000B × 8 / 5초 = 8kbps
    expect(second.sample.relayBytes).toBe(5000);
    expect(second.sample.fps).toBe(24);
  });

  it("transport가 없으면 nominated·succeeded 경로를 쓴다", () => {
    const rs = reports({}).filter((r) => r.type !== "transport");
    (rs[0] as R).nominated = true;
    (rs[0] as R).state = "succeeded";
    expect(readSample(rs, 0, null).sample.path).toBe("host/srflx");
  });
});

describe("summarize", () => {
  it("p50·p95·평균 손실·TURN KB", () => {
    const s = (rtt: number, loss: number | null, relayBytes = 0): StatsSample => ({
      rttMs: rtt,
      lossPct: loss,
      fps: 20,
      kbpsIn: 500,
      relay: relayBytes > 0,
      relayBytes,
      path: "relay/srflx",
    });
    const sum = summarize([s(10, 0, 1024), s(20, 2, 1024), s(30, 4), s(400, null)]);
    expect(sum.samples).toBe(4);
    expect(sum.rtt_p50).toBe(20);
    expect(sum.rtt_p95).toBe(400);
    expect(sum.loss_pct).toBe(2);
    expect(sum.relay_kb).toBe(2);
    expect(sum.fps_min).toBe(20);
  });
  it("표본이 없으면 null", () => {
    expect(summarize([])).toMatchObject({ samples: 0, rtt_p50: null, loss_pct: null, relay_kb: 0, path: null });
  });
});
