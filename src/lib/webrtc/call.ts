import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { isPointerPos, type PointerPos } from "./pointer";
import { parseDrawCommand, type DrawCommand, type DrawEvent } from "./draw";
import {
  parseCameraCommand,
  parseCameraState,
  type CameraCommand,
  type CameraState,
} from "./camera";

// 정지 화면(JPEG data URL)은 DataChannel 메시지 크기 제한 때문에 조각내 보낸다
const FREEZE_CHUNK = 12_000;
const FREEZE_MAX_CHUNKS = 400;

// 1:1 P2P 통화 세션. 시그널링은 Supabase Realtime 비공개(private) 채널 두 개 — 역할별 일방통행.
//   room:{id}:e  엔지니어 → 고객. 보내기(broadcast·presence)는 방 주인(로그인 JWT)만 — DB 정책(RLS)이 검사
//   room:{id}:c  고객 → 엔지니어. 링크를 연 사람 누구나
// 각자 자기 채널로만 보내고 상대 채널만 듣는다. 고객은 :e에서 온 신호만 믿으므로
// 링크를 가진 제3자가 엔지니어 행세를 할 수 없다 (BUG-09). 정책은 supabase/schema.sql.
// 역할 고정: customer(카메라 보유)가 offer, engineer가 answer.
// 포인터·드로잉용 DataChannel('draw')은 offer에 미리 포함해 둔다.
// 포인터는 연결 후 DataChannel로, 아직 열리지 않았으면 시그널링 broadcast로 보낸다.

export type Role = "engineer" | "customer";

export type CallState =
  | "waiting" // 채널 구독 완료, 상대 대기
  | "connecting" // offer/answer 교환 중
  | "connected"
  | "failed"
  | "denied" // 채널 권한 거부 — 엔지니어는 로그인 만료, 고객은 세션 종료·만료
  | "ended"; // 상대가 종료(bye 수신). 내가 hangup()한 경우엔 알리지 않는다

export interface CallSessionOptions {
  roomId: string;
  role: Role;
  iceServers: RTCIceServer[];
  // customer: 카메라+마이크 / engineer: 마이크(없으면 null — 듣기만)
  localStream: MediaStream | null;
  onState: (state: CallState) => void;
  onRemoteStream: (stream: MediaStream) => void;
  // 상대가 레이저 포인터를 찍었다 (영상 원본 기준 0~1 좌표)
  onPointer?: (pos: PointerPos) => void;
  // 상대가 화면을 멈추고 그렸다 (CALL-09)
  onDraw?: (e: DrawEvent) => void;
  // 고객: 엔지니어가 카메라 전환·손전등을 요청했다 (CALL-10, CALL-11)
  onCameraCommand?: (cmd: CameraCommand) => void;
  // 엔지니어: 고객 카메라 상태(명령 결과 포함)
  onCameraState?: (state: CameraState) => void;
  onPeerPresent?: (present: boolean) => void;
}

function laneTopic(roomId: string, role: Role) {
  return `room:${roomId}:${role === "engineer" ? "e" : "c"}`;
}

// 통화 세션 없이(연결 준비 전, 새로고침 후) 상대에게 종료를 알린다.
// 채널에 들어가지 않고 REST로 보낸다. 세션이 살아 있으면 CallSession.hangup()을 쓸 것 —
// 같은 토픽의 채널을 재사용하므로 여기서 지우면 살아 있는 세션의 채널까지 지워진다.
export async function sendBye(roomId: string, from: Role) {
  const supabase = createClient();
  const channel = supabase.channel(laneTopic(roomId, from), {
    config: { private: true },
  });
  try {
    // REST 전송은 소켓이 받아 둔 토큰을 쓴다. 소켓이 아직 없으면 비어 있어 권한 검사에 걸리므로 먼저 받아 둔다
    await supabase.realtime.setAuth();
    await channel.httpSend("bye", { from });
  } catch {
    await channel.send({ type: "broadcast", event: "bye", payload: { from } });
  } finally {
    supabase.removeChannel(channel).catch(() => {});
  }
}

export class CallSession {
  private supabase = createClient();
  // sendLane: 내가 보내는 채널(내 역할) / listenLane: 상대가 보내는 채널
  private sendLane: RealtimeChannel | null = null;
  private listenLane: RealtimeChannel | null = null;
  private sendLaneReady = false;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private dc: RTCDataChannel | null = null;
  private incomingFreeze: { id: string; parts: string[]; got: number } | null =
    null;
  private negotiating = false;
  private closed = false;
  // 카메라 전환 시 교체된다. 이후 새로 맺는 연결도 지금 카메라로 보내기 위함
  private localStream: MediaStream | null;

  constructor(private opts: CallSessionOptions) {
    this.localStream = opts.localStream;
  }

  join() {
    const { roomId, role } = this.opts;
    const peer = this.peerRole();

    this.sendLane = this.supabase.channel(laneTopic(roomId, role), {
      config: { private: true, presence: { key: role }, broadcast: { self: false } },
    });
    this.listenLane = this.supabase.channel(laneTopic(roomId, peer), {
      config: { private: true },
    });

    this.sendLane.subscribe(async (status, err) => {
      if (status === "SUBSCRIBED") {
        const tracked = await this.sendLane?.track({ at: Date.now() });
        // 채널엔 들어왔는데 보내기 권한이 없다 (엔지니어 로그인이 다른 기기에서 풀린 경우 등)
        if (tracked === "error") {
          this.onChannelError(new Error("Unauthorized: presence track"));
          return;
        }
        this.sendLaneReady = true;
        // 재구독(망 전환 등)이나 track 대기 중 이미 연결이 시작됐으면 상태를 덮어쓰지 않는다
        if (!this.closed && !this.pc) this.opts.onState("waiting");
        this.onPresenceSync(); // 상대가 먼저 와 있었으면 지금 시작
      } else if (status === "CHANNEL_ERROR") {
        this.onChannelError(err);
      }
    });

    this.listenLane
      .on("broadcast", { event: "offer" }, ({ payload }) => {
        if (role === "engineer") this.answer(payload.sdp);
      })
      .on("broadcast", { event: "answer" }, ({ payload }) => {
        if (role === "customer") this.acceptAnswer(payload.sdp);
      })
      .on("broadcast", { event: "ice" }, ({ payload }) =>
        this.addIce(payload.candidate),
      )
      .on("broadcast", { event: "bye" }, () => this.onBye())
      .on("broadcast", { event: "pointer" }, ({ payload }) =>
        this.receivePointer(payload),
      )
      .on("broadcast", { event: "cam" }, ({ payload }) =>
        this.receiveCamera(payload),
      )
      .on("presence", { event: "sync" }, () => this.onPresenceSync())
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR") this.onChannelError(err);
      });
  }

  // 권한 거부만 통화 실패로 본다. 망 끊김 등은 realtime이 스스로 다시 들어간다
  private onChannelError(err?: Error) {
    console.warn("[call] 채널 오류:", err);
    if (this.closed || !/unauthori[sz]ed|permission|denied/i.test(err?.message ?? "")) {
      return;
    }
    this.opts.onState("denied");
    this.destroy();
  }

  private peerRole(): Role {
    return this.opts.role === "engineer" ? "customer" : "engineer";
  }

  private onPresenceSync() {
    if (this.closed || !this.listenLane) return;
    const present = !!this.listenLane.presenceState()[this.peerRole()]?.length;
    this.opts.onPeerPresent?.(present);

    if (!present) {
      // 상대가 나갔다 — 연결을 정리하고 재접속을 기다린다 (고객이 새로고침하는 경우)
      if (this.pc) this.resetPeer();
      return;
    }

    // customer가 offer 측: 엔지니어가 보이고 아직 연결 전이면 시작 (보낼 채널이 준비된 뒤)
    if (
      this.opts.role === "customer" &&
      this.sendLaneReady &&
      !this.pc &&
      !this.negotiating
    ) {
      this.offer();
    }
  }

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers });

    const stream = this.localStream;
    stream?.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.ontrack = (e) => {
      if (e.streams[0]) this.opts.onRemoteStream(e.streams[0]);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.send("ice", { candidate: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === "connected") this.opts.onState("connected");
      else if (pc.connectionState === "failed") this.fail();
    };

    this.pc = pc;
    this.pendingIce = [];
    return pc;
  }

  private async offer() {
    try {
      this.negotiating = true;
      this.opts.onState("connecting");
      const pc = this.createPeer();

      this.attachDataChannel(pc.createDataChannel("draw"));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send("offer", { sdp: offer });
    } catch (e) {
      console.error("[call] offer 실패:", e);
      this.fail();
    } finally {
      this.negotiating = false;
    }
  }

  private async answer(sdp: RTCSessionDescriptionInit) {
    try {
      this.opts.onState("connecting");
      if (this.pc) this.resetPeer(); // 고객이 재시도한 경우 이전 연결 폐기
      const pc = this.createPeer();

      pc.ondatachannel = (e) => this.attachDataChannel(e.channel);

      await pc.setRemoteDescription(sdp);
      this.flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send("answer", { sdp: answer });
    } catch (e) {
      console.error("[call] answer 실패:", e);
      this.fail();
    }
  }

  private async acceptAnswer(sdp: RTCSessionDescriptionInit) {
    try {
      if (!this.pc) return;
      await this.pc.setRemoteDescription(sdp);
      this.flushIce();
    } catch (e) {
      console.error("[call] answer 수신 처리 실패:", e);
      this.fail();
    }
  }

  private async addIce(candidate: RTCIceCandidateInit) {
    if (this.pc?.remoteDescription) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("[call] ICE 후보 추가 실패:", e);
      }
    } else {
      this.pendingIce.push(candidate);
    }
  }

  private flushIce() {
    const queued = this.pendingIce;
    this.pendingIce = [];
    queued.forEach((c) => this.addIce(c));
  }

  private send(event: string, payload: Record<string, unknown>) {
    this.sendLane?.send({ type: "broadcast", event, payload });
  }

  private attachDataChannel(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onmessage = (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // 형식이 다른 메시지는 무시
      }
      const t = (msg as { t?: unknown } | null)?.t;
      if (t === "pointer") this.receivePointer(msg);
      else if (t === "cam" || t === "cam-state") this.receiveCamera(msg);
      else if (t === "freeze-chunk") this.receiveFreezeChunk(msg);
      else {
        const cmd = parseDrawCommand(msg);
        if (cmd && !this.closed) this.opts.onDraw?.(cmd);
      }
    };
  }

  private receiveFreezeChunk(msg: unknown) {
    const m = msg as Record<string, unknown>;
    const { id, i, n, d } = m;
    if (
      typeof id !== "string" ||
      typeof i !== "number" ||
      typeof n !== "number" ||
      typeof d !== "string" ||
      n < 1 ||
      n > FREEZE_MAX_CHUNKS ||
      i < 0 ||
      i >= n
    ) {
      return;
    }
    // 새 정지 화면이 오면 이전에 모으던 것은 버린다
    if (this.incomingFreeze?.id !== id) {
      this.incomingFreeze = { id, parts: new Array(n), got: 0 };
    }
    const f = this.incomingFreeze;
    if (f.parts.length !== n || f.parts[i] !== undefined) return;
    f.parts[i] = d;
    f.got++;
    if (f.got === n) {
      this.incomingFreeze = null;
      const image = f.parts.join("");
      if (image.startsWith("data:image/jpeg;base64,") && !this.closed) {
        this.opts.onDraw?.({ t: "freeze", image });
      }
    }
  }

  private dcOpen() {
    return !this.closed && this.dc?.readyState === "open";
  }

  // 정지 화면 보내기. 연결(DataChannel)이 없으면 false — 크기가 커서 시그널링으로는 못 보낸다
  sendFreeze(image: string): boolean {
    if (!this.dcOpen()) return false;
    const id = crypto.randomUUID();
    const n = Math.ceil(image.length / FREEZE_CHUNK);
    if (n > FREEZE_MAX_CHUNKS) return false;
    for (let i = 0; i < n; i++) {
      const d = image.slice(i * FREEZE_CHUNK, (i + 1) * FREEZE_CHUNK);
      this.dc!.send(JSON.stringify({ t: "freeze-chunk", id, i, n, d }));
    }
    return true;
  }

  // 선·되돌리기·지우기·다시 보기. 정지 화면과 같은 채널로 보내 순서가 지켜지게 한다
  sendDraw(cmd: DrawCommand): boolean {
    if (!this.dcOpen()) return false;
    this.dc!.send(JSON.stringify(cmd));
    return true;
  }

  private receivePointer(msg: unknown) {
    if (this.closed || !isPointerPos(msg)) return;
    this.opts.onPointer?.({ x: msg.x, y: msg.y });
  }

  private receiveCamera(msg: unknown) {
    if (this.closed) return;
    if (this.opts.role === "customer") {
      const cmd = parseCameraCommand(msg);
      if (cmd) this.opts.onCameraCommand?.(cmd);
    } else {
      const state = parseCameraState(msg);
      if (state) this.opts.onCameraState?.(state);
    }
  }

  // 작은 메시지: 연결 후엔 DataChannel, 아직이면 시그널링 broadcast
  private sendSmall(msg: { t: string } & Record<string, unknown>) {
    if (this.closed) return;
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg));
    else this.send("cam", msg);
  }

  sendCameraCommand(cmd: CameraCommand) {
    this.sendSmall(cmd);
  }

  sendCameraState(state: CameraState) {
    this.sendSmall({ t: "cam-state", ...state });
  }

  sendPointer(pos: PointerPos) {
    if (this.closed) return;
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify({ t: "pointer", x: pos.x, y: pos.y }));
    } else {
      this.send("pointer", { x: pos.x, y: pos.y });
    }
  }

  // 카메라 전/후면 전환 (재협상 없이 replaceTrack).
  // 아직 연결 전이어도 교체해 두어야, 나중에 맺는 연결이 꺼진 이전 카메라를 보내지 않는다
  async replaceVideoTrack(track: MediaStreamTrack) {
    const audio = this.localStream?.getAudioTracks() ?? [];
    this.localStream = new MediaStream([track, ...audio]);
    const sender = this.pc
      ?.getSenders()
      .find((s) => s.track?.kind === "video");
    await sender?.replaceTrack(track);
  }

  // relay(TURN) 경유 여부 — 연결 후 원가 지표용
  async usedRelay(): Promise<boolean> {
    if (!this.pc) return false;
    try {
      const stats = await this.pc.getStats();
      let selectedPairId: string | null = null;
      stats.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) {
          selectedPairId = s.selectedCandidatePairId;
        }
      });
      let localCandidateId: string | null = null;
      stats.forEach((s) => {
        if (
          s.type === "candidate-pair" &&
          (s.id === selectedPairId || (!selectedPairId && s.nominated && s.state === "succeeded"))
        ) {
          localCandidateId = s.localCandidateId;
        }
      });
      let relay = false;
      stats.forEach((s) => {
        if (s.id === localCandidateId && s.candidateType === "relay") {
          relay = true;
        }
      });
      return relay;
    } catch {
      return false;
    }
  }

  private resetPeer() {
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    this.incomingFreeze = null;
    this.pendingIce = [];
    if (!this.closed) this.opts.onState("waiting");
  }

  // 직접 종료: 상대에게 bye를 알리고 채널에서 나간다. onState는 부르지 않는다(호출측이 안다).
  // 채널이 붙어 있으면 bye는 즉시 소켓에 실리므로 곧바로 나가도 순서가 지켜진다.
  hangup() {
    this.send("bye", { from: this.opts.role });
    this.destroy();
  }

  // 상대가 종료했다. 고객은 채널에서 나가 이후 재연결되지 않게 하고,
  // 엔지니어는 채널에 남아 고객이 링크를 다시 열면 이어받는다.
  private onBye() {
    if (this.closed) return;
    this.pc?.close();
    this.pc = null;
    this.opts.onState("ended");
    if (this.opts.role === "customer") this.destroy();
  }

  // 고객은 실패하면 카메라를 끄고 '다시 연결'(새로고침)으로만 복구하므로 채널에서 나간다.
  // 남아 있으면 엔지니어가 다시 들어올 때 꺼진 카메라로 재연결된다.
  private fail() {
    if (this.closed) return;
    this.opts.onState("failed");
    if (this.opts.role === "customer") this.destroy();
  }

  // 언마운트 시에도 호출. 여러 번 불러도 된다. 로컬 트랙 정지는 호출측 책임.
  destroy() {
    this.closed = true;
    this.pc?.close();
    this.pc = null;
    for (const ch of [this.sendLane, this.listenLane]) {
      if (ch) this.supabase.removeChannel(ch);
    }
    this.sendLane = null;
    this.listenLane = null;
    this.sendLaneReady = false;
  }
}
