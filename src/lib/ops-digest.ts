// 하루 운영 요약 계산 (OPS-07). 순수 함수 — 입력은 하루 동안 만든 상담·그 상담의 기록·화면 요약.
// 세션(상담) 단위로 센다. 로컬·Preview 상담(room_created.env ≠ production)은 뺀다.

export interface DigestRoom {
  id: string;
  resolved_remotely: boolean | null;
}

export interface DigestEvent {
  room_id: string | null;
  actor: string;
  name: string;
  props: Record<string, unknown> | null;
  created_at: string;
}

export interface DigestReport {
  room_id: string;
  actor: string;
  report: Record<string, unknown> | null;
}

export interface Ratio {
  hit: number;
  of: number;
}

export interface Digest {
  sessions: number;
  linkOpened: number;
  cameraGranted: number;
  connected: number;
  resolved: Ratio; // 답한 상담 중 '네'
  // 양쪽(고객·엔지니어)이 모두 준비(call_ready)된 상담 중 끝내 연결 안 된 상담 — 실측 연결 실패율 (NFR-05의 5%와 비교)
  connectFailure: Ratio;
  // 고객은 준비됐는데 엔지니어 call_ready가 없는 상담 (엔지니어 미준비, 실패율에서 뺌)
  engineerNotReady: number;
  // 처음 연결될 때까지 걸린 시간(서버 시각: 첫 camera_granted → 첫 connected), 초
  connectSec: { p50: number | null; p90: number | null; n: number };
  failedByStage: Record<string, number>; // 상담 수
  stuckByStage: Record<string, number>; // 상담 수
  inCallDrop: Ratio; // 연결된 상담 중 통화 중 끊김(call_failed/call_stuck in_call)
  relay: Ratio; // 연결된 상담 중 TURN 경유
  turnFallback: number; // TURN 없이 시작한 상담 수
  turnFallbackReasons: Record<string, number>;
  cameraDenied: Record<string, number>; // 거부 원인별 상담 수
  clientErrors: number;
  clientErrorTop: { sig: string; n: number }[];
  quality: { rttP50: number | null; lossPct: number | null; n: number };
}

function isProd(p: Record<string, unknown> | null | undefined) {
  // v·env를 붙이기 전 기록은 운영으로 본다
  return !p || p.env === undefined || p.env === "production";
}

export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
}

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

export function computeDigest(rooms: DigestRoom[], events: DigestEvent[], reports: DigestReport[]): Digest {
  // 운영 상담만: room_created가 운영 환경이 아닌 상담은 뺀다
  const nonProd = new Set(
    events.filter((e) => e.name === "room_created" && !isProd(e.props)).map((e) => e.room_id),
  );
  const live = rooms.filter((r) => !nonProd.has(r.id));
  const ids = new Set(live.map((r) => r.id));
  const evs = events.filter((e) => e.room_id !== null && ids.has(e.room_id));

  const rooms_ = (pred: (e: DigestEvent) => boolean) => new Set(evs.filter(pred).map((e) => e.room_id as string));
  const named = (name: string, actor?: string) => rooms_((e) => e.name === name && (!actor || e.actor === actor));

  const opened = named("link_opened");
  const granted = named("camera_granted");
  const connected = named("connected");
  const custReady = named("call_ready", "customer");
  const engReady = named("call_ready", "engineer");

  const relayed = named("relay_used");
  const bothReady = [...custReady].filter((id) => engReady.has(id));
  const answered = live.filter((r) => r.resolved_remotely !== null);

  // 연결까지 걸린 시간: 상담마다 첫 camera_granted → 첫 connected
  const firstAt = (name: string) => {
    const m = new Map<string, number>();
    for (const e of evs) {
      if (e.name !== name) continue;
      const t = Date.parse(e.created_at);
      const id = e.room_id as string;
      if (!m.has(id) || t < m.get(id)!) m.set(id, t);
    }
    return m;
  };
  const grantAt = firstAt("camera_granted");
  const connAt = firstAt("connected");
  const connectSecs: number[] = [];
  for (const [id, t] of connAt) {
    const g = grantAt.get(id);
    if (g !== undefined && t >= g) connectSecs.push((t - g) / 1000);
  }

  // 실패·지연 단계: 상담마다 단계별 한 번
  const failedByStage: Record<string, number> = {};
  const stuckByStage: Record<string, number> = {};
  const seenFail = new Set<string>();
  const seenStuck = new Set<string>();
  const inCall = new Set<string>();
  for (const e of evs) {
    const stage = String(e.props?.stage ?? "unknown");
    const key = `${e.room_id}:${stage}`;
    if (e.name === "call_failed" && !seenFail.has(key)) {
      seenFail.add(key);
      bump(failedByStage, stage);
    }
    if (e.name === "call_stuck" && !seenStuck.has(key)) {
      seenStuck.add(key);
      bump(stuckByStage, stage);
    }
    if ((e.name === "call_failed" || e.name === "call_stuck") && stage === "in_call") inCall.add(e.room_id as string);
  }

  const turnFallbackRooms = new Set<string>();
  const turnFallbackReasons: Record<string, number> = {};
  const deniedSeen = new Set<string>();
  const cameraDenied: Record<string, number> = {};
  const errSig = new Map<string, number>();
  let clientErrors = 0;
  for (const e of evs) {
    if (e.name === "turn_fallback") {
      turnFallbackRooms.add(e.room_id as string);
      bump(turnFallbackReasons, String(e.props?.reason ?? "unknown"));
    }
    if (e.name === "camera_denied") {
      const reason = String(e.props?.reason ?? "unknown");
      const key = `${e.room_id}:${reason}`;
      if (!deniedSeen.has(key)) {
        deniedSeen.add(key);
        bump(cameraDenied, reason);
      }
    }
    if (e.name === "client_error") {
      clientErrors++;
      const sig = `${e.props?.kind ?? "?"} ${e.props?.name ?? ""}: ${String(e.props?.msg ?? "").slice(0, 60)}`;
      errSig.set(sig, (errSig.get(sig) ?? 0) + 1);
    }
  }

  // 통화 품질: 엔지니어 화면 요약(받는 영상 기준)의 rtt·손실
  const rtts: number[] = [];
  const losses: number[] = [];
  for (const r of reports) {
    if (!ids.has(r.room_id) || r.actor !== "engineer" || !isProd(r.report)) continue;
    const q = r.report?.quality as Record<string, unknown> | undefined;
    if (!q) continue;
    if (typeof q.rtt_p50 === "number") rtts.push(q.rtt_p50);
    if (typeof q.loss_pct === "number") losses.push(q.loss_pct);
  }

  return {
    sessions: live.length,
    linkOpened: opened.size,
    cameraGranted: granted.size,
    connected: connected.size,
    resolved: { hit: answered.filter((r) => r.resolved_remotely === true).length, of: answered.length },
    connectFailure: { hit: bothReady.filter((id) => !connected.has(id)).length, of: bothReady.length },
    engineerNotReady: [...custReady].filter((id) => !engReady.has(id)).length,
    connectSec: { p50: percentile(connectSecs, 0.5), p90: percentile(connectSecs, 0.9), n: connectSecs.length },
    failedByStage,
    stuckByStage,
    inCallDrop: { hit: [...connected].filter((id) => inCall.has(id)).length, of: connected.size },
    relay: { hit: [...connected].filter((id) => relayed.has(id)).length, of: connected.size },
    turnFallback: turnFallbackRooms.size,
    turnFallbackReasons,
    cameraDenied,
    clientErrors,
    clientErrorTop: [...errSig.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([sig, n]) => ({ sig, n })),
    quality: {
      rttP50: percentile(rtts, 0.5),
      lossPct: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
      n: Math.max(rtts.length, losses.length),
    },
  };
}

export function pct(r: Ratio): string {
  return r.of === 0 ? "—" : `${Math.round((r.hit / r.of) * 100)}% (${r.hit}/${r.of})`;
}

function list(m: Record<string, number>): string {
  const entries = Object.entries(m).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, n]) => `${k} ${n}`).join(", ") : "없음";
}

// NFR-05: 실측 연결 실패율이 5%를 넘으면 응급 채널에도 알린다 (표본이 작을 땐 흔들리므로 20건 이상일 때만)
export const FAILURE_ALERT_RATE = 0.05;
export const FAILURE_ALERT_MIN = 20;

export function digestNeedsAlert(d: Digest): string[] {
  const reasons: string[] = [];
  if (d.connectFailure.of >= FAILURE_ALERT_MIN && d.connectFailure.hit / d.connectFailure.of > FAILURE_ALERT_RATE) {
    reasons.push(`연결 실패율 ${pct(d.connectFailure)}가 5%를 넘었어요 (NFR-05)`);
  }
  if (d.turnFallback > 0) reasons.push(`TURN 없이 시작한 상담 ${d.turnFallback}건 (${list(d.turnFallbackReasons)})`);
  return reasons;
}

// 디스코드에 보낼 줄들
export function digestLines(d: Digest): { lines: string[]; fields: { name: string; value: string; inline?: boolean }[] } {
  const sec = (v: number | null) => (v === null ? "—" : `${Math.round(v)}초`);
  return {
    lines: [
      `상담 ${d.sessions}건 · 링크 연 ${d.linkOpened} · 카메라 켠 ${d.cameraGranted} · 연결 ${d.connected}`,
      `원격 해결률 ${pct(d.resolved)}`,
    ],
    fields: [
      { name: "연결 실패율 (실측)", value: pct(d.connectFailure) },
      { name: "엔지니어 미준비", value: `${d.engineerNotReady}건` },
      { name: "연결까지", value: `p50 ${sec(d.connectSec.p50)} · p90 ${sec(d.connectSec.p90)} (${d.connectSec.n}건)` },
      { name: "실패 단계", value: list(d.failedByStage), inline: false },
      { name: "제한 시간 초과", value: list(d.stuckByStage), inline: false },
      { name: "통화 중 끊김", value: pct(d.inCallDrop) },
      { name: "TURN 중계", value: pct(d.relay) },
      { name: "TURN 없이 시작", value: d.turnFallback ? `${d.turnFallback}건 (${list(d.turnFallbackReasons)})` : "0건" },
      { name: "카메라 거부 원인", value: list(d.cameraDenied), inline: false },
      {
        name: "화면 오류",
        value: d.clientErrors ? `${d.clientErrors}건 · ${d.clientErrorTop.map((t) => `${t.sig} ×${t.n}`).join(" / ")}` : "0건",
        inline: false,
      },
      {
        name: "통화 품질",
        value: d.quality.n
          ? `RTT p50 ${d.quality.rttP50 === null ? "—" : `${Math.round(d.quality.rttP50)}ms`} · 손실 ${d.quality.lossPct === null ? "—" : `${d.quality.lossPct.toFixed(1)}%`} (${d.quality.n}건)`
          : "요약 없음",
        inline: false,
      },
    ],
  };
}

const KST_MS = 9 * 3600_000;
const DAY_MS = 24 * 3600_000;

// 한국 날짜(YYYY-MM-DD) → 그날 0시~24시의 UTC 범위. date가 없으면 어제
export function kstDayRange(date: string | null, now = Date.now()): { label: string; start: Date; end: Date } | null {
  let startMs: number;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    startMs = Date.parse(`${date}T00:00:00Z`) - KST_MS;
    if (Number.isNaN(startMs)) return null;
  } else {
    const kstToday = Math.floor((now + KST_MS) / DAY_MS) * DAY_MS;
    startMs = kstToday - DAY_MS - KST_MS;
  }
  const label = new Date(startMs + KST_MS).toISOString().slice(0, 10);
  return { label, start: new Date(startMs), end: new Date(startMs + DAY_MS) };
}
