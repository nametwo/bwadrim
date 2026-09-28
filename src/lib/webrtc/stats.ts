// 통화 품질 표본 (DATA-07 call_summary.quality). 5초마다 getStats()를 읽어 모아 두고, 화면을 떠날 때 요약 한 줄로 보낸다.
// 표본마다 DB에 쓰지 않는다. 미디어 로직이라 webrtc 폴더 안에 둔다.

export interface StatsSample {
  rttMs: number | null; // 선택된 경로의 왕복 시간
  lossPct: number | null; // 이번 구간에 받은 영상·음성 패킷 중 잃은 비율
  fps: number | null; // 받는 영상 fps (엔지니어만 — 고객은 음성만 받는다)
  kbpsIn: number | null; // 받는 속도
  relay: boolean; // 선택된 경로가 TURN 중계인지 (내 쪽 후보 기준)
  relayBytes: number; // 이번 구간에 TURN으로 주고받은 바이트
  path: string | null; // 'host/srflx' 처럼 내 쪽/상대 쪽 후보 종류
}

export interface StatsCursor {
  at: number;
  packetsReceived: number;
  packetsLost: number;
  bytesReceived: number;
  pairBytes: number;
}

export interface QualitySummary {
  samples: number;
  rtt_p50: number | null;
  rtt_p95: number | null;
  loss_pct: number | null; // 표본 평균
  fps_min: number | null;
  fps_p50: number | null;
  kbps_in_p50: number | null;
  relay_kb: number; // TURN으로 주고받은 양(KB) — 세션당 TURN 원가 근거
  path: string | null; // 마지막 경로
}

type Report = Record<string, unknown> & { type: string; id: string };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// getStats() 결과 하나 → 표본. prev가 있으면 그 사이 변화로 손실·속도를 계산한다
export function readSample(
  reports: Iterable<Report>,
  now: number,
  prev: StatsCursor | null,
): { sample: StatsSample; cursor: StatsCursor } {
  const all = [...reports];
  const byId = new Map(all.map((r) => [r.id, r]));
  let pairId: string | null = null;
  for (const r of all) {
    if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") pairId = r.selectedCandidatePairId;
  }
  let pair: Report | undefined = pairId ? byId.get(pairId) : undefined;
  if (!pair) {
    pair = all.find((r) => r.type === "candidate-pair" && r.nominated === true && r.state === "succeeded");
  }
  const local = pair ? byId.get(String(pair.localCandidateId)) : undefined;
  const remote = pair ? byId.get(String(pair.remoteCandidateId)) : undefined;
  const relay = local?.candidateType === "relay";
  const path = local || remote ? `${local?.candidateType ?? "?"}/${remote?.candidateType ?? "?"}` : null;

  let packetsReceived = 0;
  let packetsLost = 0;
  let bytesReceived = 0;
  let fps: number | null = null;
  for (const r of all) {
    if (r.type !== "inbound-rtp") continue;
    packetsReceived += num(r.packetsReceived) ?? 0;
    packetsLost += Math.max(0, num(r.packetsLost) ?? 0);
    bytesReceived += num(r.bytesReceived) ?? 0;
    if (r.kind === "video" && num(r.framesPerSecond) !== null) fps = num(r.framesPerSecond);
  }
  const pairBytes = (num(pair?.bytesSent) ?? 0) + (num(pair?.bytesReceived) ?? 0);
  const cursor: StatsCursor = { at: now, packetsReceived, packetsLost, bytesReceived, pairBytes };

  let lossPct: number | null = null;
  let kbpsIn: number | null = null;
  let relayBytes = 0;
  if (prev) {
    const got = packetsReceived - prev.packetsReceived;
    const lost = packetsLost - prev.packetsLost;
    if (got + lost > 0 && lost >= 0) lossPct = (lost / (got + lost)) * 100;
    const secs = (now - prev.at) / 1000;
    if (secs > 0 && bytesReceived >= prev.bytesReceived) kbpsIn = ((bytesReceived - prev.bytesReceived) * 8) / 1000 / secs;
    // 경로가 바뀌면 바이트가 새로 시작한다 — 줄어들었으면 지금 값을 이번 구간으로 본다
    if (relay) relayBytes = pairBytes >= prev.pairBytes ? pairBytes - prev.pairBytes : pairBytes;
  } else if (relay) {
    relayBytes = pairBytes;
  }

  const rtt = num(pair?.currentRoundTripTime);
  return {
    sample: { rttMs: rtt === null ? null : rtt * 1000, lossPct, fps, kbpsIn, relay, relayBytes, path },
    cursor,
  };
}

function pctl(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function round(v: number | null, digits = 0): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function summarize(samples: StatsSample[]): QualitySummary {
  const pick = (f: (s: StatsSample) => number | null) => samples.map(f).filter((v): v is number => v !== null);
  const rtts = pick((s) => s.rttMs);
  const losses = pick((s) => s.lossPct);
  const fpss = pick((s) => s.fps);
  const kbps = pick((s) => s.kbpsIn);
  return {
    samples: samples.length,
    rtt_p50: round(pctl(rtts, 0.5)),
    rtt_p95: round(pctl(rtts, 0.95)),
    loss_pct: losses.length ? round(losses.reduce((a, b) => a + b, 0) / losses.length, 2) : null,
    fps_min: round(fpss.length ? Math.min(...fpss) : null),
    fps_p50: round(pctl(fpss, 0.5)),
    kbps_in_p50: round(pctl(kbps, 0.5)),
    relay_kb: Math.round(samples.reduce((a, s) => a + s.relayBytes, 0) / 1024),
    path: samples.length ? samples[samples.length - 1].path : null,
  };
}

// 연결(pc)이 바뀌어도 표본은 한 화면 동안 계속 모은다. 너무 오래 통화해도 메모리가 늘지 않게 최근 것만 둔다
const INTERVAL_MS = 5000;
const MAX_SAMPLES = 720; // 5초 × 720 = 1시간

export class StatsSampler {
  private samples: StatsSample[] = [];
  private cursor: StatsCursor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pc: RTCPeerConnection | null = null;

  start(pc: RTCPeerConnection) {
    this.stop();
    this.pc = pc;
    this.cursor = null;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pc = null;
    this.cursor = null;
  }

  private async tick() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== "connected") return;
    try {
      const stats = await pc.getStats();
      if (this.pc !== pc) return;
      const { sample, cursor } = readSample(stats.values() as Iterable<Report>, Date.now(), this.cursor);
      this.cursor = cursor;
      this.samples.push(sample);
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    } catch {
      // 표본 하나 빠져도 괜찮다
    }
  }

  summary(): QualitySummary {
    return summarize(this.samples);
  }
}

// 지금 선택된 경로 (연결 직후 한 번 — connected 기록의 relay·path)
export async function pathInfo(pc: RTCPeerConnection): Promise<{ relay: boolean; path: string | null }> {
  try {
    const stats = await pc.getStats();
    const { sample } = readSample(stats.values() as Iterable<Report>, Date.now(), null);
    return { relay: sample.relay, path: sample.path };
  } catch {
    return { relay: false, path: null };
  }
}
