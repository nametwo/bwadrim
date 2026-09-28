// 통화 연결 과정 관찰 (DATA-01 call_ready·call_stuck·call_failed·connected). CallSession이 단계마다 알려 주면
// 제한 시간을 재고, 실패는 연결 시도마다 처음 것 하나만 골라 onSignal로 내보낸다. 화면 동작은 바꾸지 않는다(기록만).
// 미디어 로직이라 webrtc 폴더 안에 둔다 — UI는 CallSignal만 받아 /api/events로 보낸다.

export type CallStage = "signaling" | "denied" | "presence" | "negotiation" | "ice" | "in_call";

export interface LaneCounts {
  // 채널 상태별 횟수 (SUBSCRIBED 두 번째부터 = 다시 들어감)
  rejoins: number;
  errors: number; // CHANNEL_ERROR
  timeouts: number; // TIMED_OUT
  closed: number; // CLOSED
}

export type CallSignal =
  | {
      type: "ready";
      ms: number; // join()부터 두 채널 입장 + presence 등록 결과까지
      track: "ok" | "timed out" | "error";
    }
  | {
      type: "stuck";
      stage: CallStage;
      reason: string;
      ms: number; // 그 단계에 들어간 뒤 지난 시간
      attempt: number;
      sub?: string;
    }
  | {
      type: "failed";
      stage: CallStage;
      reason: string;
      err?: string;
      attempt: number;
      after_connected: boolean;
      pc_state: string | null;
      ms_in_attempt: number | null;
      // 마지막 연결 이후 쌓인 것 — 실패가 수십 초 뒤에 와도 원인을 짐작할 수 있게
      disconnects_since_connected: number;
      hidden_since_connected: number;
      net_changes_since_connected: number;
      sig_problems_since_connected: number;
    }
  | {
      type: "connected";
      attempt: number;
      reconnect: boolean; // 이 화면에서 두 번째 이후 연결
      ms_since_join: number;
      ms_since_offer: number | null; // offer(고객)·answer(엔지니어)를 보낸 뒤
      relay: boolean;
      path: string | null;
    };

export interface TelemetrySnapshot {
  attempts: number;
  connects: number;
  disconnects: number;
  disconnected_ms: number;
  peer_left: number; // 연결 중 상대 presence가 사라진 횟수
  peer_changes: number;
  send_fail: number; // 신호 전송 결과가 ok가 아닌 횟수
  ice_add_fail: number;
  lanes: { send: LaneCounts; listen: LaneCounts };
  stuck: string[];
  failed: string[];
}

// 단계별 제한 시간 — 넘기면 call_stuck (화면은 그대로)
export const STAGE_LIMIT_MS = {
  signaling: 15_000, // join → 두 채널 입장 + presence 등록
  presence: 20_000, // presence 등록이 시간 초과였는데 연결이 시작되지 않음
  offerHold: 15_000, // 엔지니어: presence를 못 본 고객의 offer를 맡아 둔 채
  negotiation: 20_000, // 고객: offer를 보낸 뒤 answer가 안 옴
  ice: 45_000, // offer·answer 뒤 연결이 안 됨
  inCall: 15_000, // 연결 뒤 'disconnected'가 이어짐
} as const;

type TimerKey = "signaling" | "presence" | "offerHold" | "negotiation" | "ice" | "inCall";

function emptyLane(): LaneCounts {
  return { rejoins: 0, errors: 0, timeouts: 0, closed: 0 };
}

export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 160);
  return String(e).slice(0, 160);
}

export class CallTelemetry {
  private now: () => number;
  private joinAt = 0;
  private laneUp = { send: false, listen: false };
  private laneSeen = { send: 0, listen: 0 };
  private track: "ok" | "timed out" | "error" | null = null;
  private readySent = false;
  private authDone = false;

  private attempt = 0;
  private attemptAt = 0;
  private sentAt: number | null = null;
  private connectedThisAttempt = false;
  private everConnected = false;
  private disconnectedSince: number | null = null;
  private failedAttempts = new Set<number>();
  private stuckKeys = new Set<string>();
  private timers = new Map<TimerKey, ReturnType<typeof setTimeout>>();

  private c = {
    connects: 0,
    disconnects: 0,
    disconnectedMs: 0,
    peerLeft: 0,
    peerChanges: 0,
    sendFail: 0,
    iceAddFail: 0,
  };
  private lanes = { send: emptyLane(), listen: emptyLane() };
  // 마지막 연결 이후
  private since = { disconnects: 0, hidden: 0, net: 0, sig: 0 };
  private stuckList: string[] = [];
  private failedList: string[] = [];
  private cleanup: (() => void) | null = null;

  constructor(
    private emit: (s: CallSignal) => void,
    opts: { now?: () => number; watchPage?: boolean } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    if (opts.watchPage !== false && typeof window !== "undefined") this.watchPage();
  }

  // 화면 숨김·망 전환을 센다 — 실패 원인 짐작용
  private watchPage() {
    const onVis = () => {
      if (document.visibilityState === "hidden") this.since.hidden++;
    };
    const onNet = () => this.since.net++;
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
    conn?.addEventListener?.("change", onNet);
    this.cleanup = () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
      conn?.removeEventListener?.("change", onNet);
    };
  }

  private startTimer(key: TimerKey, ms: number, fire: () => void) {
    this.stopTimer(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fire();
      }, ms),
    );
  }

  private stopTimer(key: TimerKey) {
    const t = this.timers.get(key);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(key);
  }

  private stuck(stage: CallStage, reason: string, since: number, sub?: string) {
    const key = `${this.attempt}:${stage}:${reason}`;
    if (this.stuckKeys.has(key)) return;
    this.stuckKeys.add(key);
    this.stuckList.push(`${stage}:${reason}`);
    this.emit({ type: "stuck", stage, reason, ms: this.now() - since, attempt: this.attempt, ...(sub ? { sub } : {}) });
  }

  // ── 채널 입장 ──
  joinStarted() {
    this.joinAt = this.now();
    this.startTimer("signaling", STAGE_LIMIT_MS.signaling, () => {
      if (this.readySent) return;
      const sub = !this.authDone
        ? "auth"
        : !this.laneUp.send || !this.laneUp.listen
          ? `subscribe:${this.laneUp.send ? "" : "send"}${!this.laneUp.send && !this.laneUp.listen ? "+" : ""}${this.laneUp.listen ? "" : "listen"}`
          : "track";
      this.stuck("signaling", "join_timeout", this.joinAt, sub);
    });
  }

  authReady() {
    this.authDone = true;
  }

  laneStatus(lane: "send" | "listen", status: string) {
    const l = this.lanes[lane];
    if (status === "SUBSCRIBED") {
      if (this.laneSeen[lane]++ > 0) {
        l.rejoins++;
        if (this.everConnected) this.since.sig++;
      }
      this.laneUp[lane] = true;
      this.maybeReady();
      return;
    }
    if (status === "CHANNEL_ERROR") l.errors++;
    else if (status === "TIMED_OUT") l.timeouts++;
    else if (status === "CLOSED") l.closed++;
    if (this.everConnected) this.since.sig++;
  }

  tracked(result: "ok" | "timed out" | "error") {
    if (this.track === null || result === "ok") this.track = result;
    this.maybeReady();
  }

  private maybeReady() {
    if (this.readySent || !this.laneUp.send || !this.laneUp.listen || this.track === null) return;
    this.readySent = true;
    this.stopTimer("signaling");
    this.emit({ type: "ready", ms: this.now() - this.joinAt, track: this.track });
    // presence 등록이 확인되지 않았으면 상대가 이쪽을 못 볼 수 있다 — 연결이 시작되는지 지켜본다
    if (this.track !== "ok" && this.attempt === 0) {
      const at = this.now();
      this.startTimer("presence", STAGE_LIMIT_MS.presence, () => {
        if (this.attempt === 0) this.stuck("presence", "presence_unconfirmed", at);
      });
    }
  }

  // 엔지니어: presence를 아직 못 본 고객 기기의 offer를 맡아 뒀다
  offerHeld() {
    if (this.timers.has("offerHold")) return;
    const at = this.now();
    this.startTimer("offerHold", STAGE_LIMIT_MS.offerHold, () => this.stuck("presence", "offer_without_presence", at));
  }

  offerReleased() {
    this.stopTimer("offerHold");
  }

  // ── 연결 시도 (RTCPeerConnection 하나 = 시도 하나) ──
  pcCreated() {
    this.attempt++;
    this.attemptAt = this.now();
    this.sentAt = null;
    this.connectedThisAttempt = false;
    this.disconnectedSince = null;
    this.stopTimer("presence");
    this.stopTimer("offerHold");
    this.stopTimer("negotiation");
    this.stopTimer("ice");
    this.stopTimer("inCall");
  }

  // 고객: offer를 보냈다 → answer를 기다리고, 연결도 기다린다
  offerSent() {
    const at = (this.sentAt = this.now());
    const attempt = this.attempt;
    this.startTimer("negotiation", STAGE_LIMIT_MS.negotiation, () => {
      if (this.attempt === attempt) this.stuck("negotiation", "no_answer", at);
    });
    this.watchIce(at);
  }

  // 엔지니어: answer를 보냈다 → 연결을 기다린다
  answerSent() {
    this.sentAt = this.now();
    this.watchIce(this.sentAt);
  }

  answerApplied() {
    this.stopTimer("negotiation");
  }

  private watchIce(at: number) {
    const attempt = this.attempt;
    this.startTimer("ice", STAGE_LIMIT_MS.ice, () => {
      if (this.attempt === attempt && !this.connectedThisAttempt) this.stuck("ice", "not_connected", at);
    });
  }

  sendResult(result: string) {
    if (result !== "ok") this.c.sendFail++;
  }

  iceAddFailed() {
    this.c.iceAddFail++;
  }

  // RTCPeerConnection.connectionState가 바뀌었다
  pcState(state: RTCPeerConnectionState) {
    const now = this.now();
    if (state === "connected") {
      this.stopTimer("ice");
      this.stopTimer("negotiation");
      this.stopTimer("inCall");
      if (this.disconnectedSince !== null) {
        this.c.disconnectedMs += now - this.disconnectedSince;
        this.disconnectedSince = null;
      }
      if (!this.connectedThisAttempt) {
        this.connectedThisAttempt = true;
        this.c.connects++;
        this.since = { disconnects: 0, hidden: 0, net: 0, sig: 0 };
      }
      return;
    }
    if (state === "disconnected" && this.connectedThisAttempt && this.disconnectedSince === null) {
      this.c.disconnects++;
      this.since.disconnects++;
      this.disconnectedSince = now;
      const attempt = this.attempt;
      this.startTimer("inCall", STAGE_LIMIT_MS.inCall, () => {
        if (this.attempt === attempt && this.disconnectedSince !== null) this.stuck("in_call", "disconnected", now);
      });
    }
  }

  // 연결되고 1초 뒤에도 연결돼 있다 — connected 기록 (시도마다 한 번, CallSession이 확인해서 부른다)
  confirmConnected(info: { relay: boolean; path: string | null }) {
    const now = this.now();
    const reconnect = this.everConnected;
    this.everConnected = true;
    this.emit({
      type: "connected",
      attempt: this.attempt,
      reconnect,
      ms_since_join: now - this.joinAt,
      ms_since_offer: this.sentAt === null ? null : now - this.sentAt,
      relay: info.relay,
      path: info.path,
    });
  }

  // 연결 중에 상대 presence가 사라졌다 — 이쪽이 멀쩡한 연결을 닫는다. 끊김의 흔한 경로라 실패로 남긴다
  presenceLost(pcState: RTCPeerConnectionState | null) {
    this.c.peerLeft++;
    if (this.connectedThisAttempt && (pcState === "connected" || pcState === "disconnected")) {
      this.fail("in_call", "peer_gone", undefined, pcState);
    }
  }

  peerChanged() {
    this.c.peerChanges++;
  }

  // 실패. 시도마다 처음 것만 — 뒤따르는 실패(채널이 닫혀 곧 ICE도 실패 등)는 보내지 않는다.
  // stage가 없으면(ICE failed) 연결된 적 있으면 in_call, 없으면 ice
  fail(stage: CallStage | null, reason: string, err?: unknown, pcState: RTCPeerConnectionState | null = null) {
    if (this.failedAttempts.has(this.attempt)) return;
    this.failedAttempts.add(this.attempt);
    const s: CallStage = stage ?? (this.connectedThisAttempt ? "in_call" : "ice");
    this.failedList.push(`${s}:${reason}`);
    if (this.disconnectedSince !== null) {
      this.c.disconnectedMs += this.now() - this.disconnectedSince;
      this.disconnectedSince = null;
    }
    this.stopTimer("ice");
    this.stopTimer("negotiation");
    this.stopTimer("inCall");
    this.emit({
      type: "failed",
      stage: s,
      reason,
      ...(err !== undefined ? { err: errText(err) } : {}),
      attempt: this.attempt,
      after_connected: this.connectedThisAttempt,
      pc_state: pcState,
      ms_in_attempt: this.attempt ? this.now() - this.attemptAt : null,
      disconnects_since_connected: this.since.disconnects,
      hidden_since_connected: this.since.hidden,
      net_changes_since_connected: this.since.net,
      sig_problems_since_connected: this.since.sig,
    });
  }

  snapshot(): TelemetrySnapshot {
    const open = this.disconnectedSince === null ? 0 : this.now() - this.disconnectedSince;
    return {
      attempts: this.attempt,
      connects: this.c.connects,
      disconnects: this.c.disconnects,
      disconnected_ms: this.c.disconnectedMs + open,
      peer_left: this.c.peerLeft,
      peer_changes: this.c.peerChanges,
      send_fail: this.c.sendFail,
      ice_add_fail: this.c.iceAddFail,
      lanes: { send: { ...this.lanes.send }, listen: { ...this.lanes.listen } },
      stuck: [...this.stuckList],
      failed: [...this.failedList],
    };
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.cleanup?.();
    this.cleanup = null;
  }
}
