import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

// 1:1 P2P 통화 세션. 시그널링은 Supabase Realtime broadcast `room:{id}`.
// 역할 고정: customer(카메라 보유)가 offer, engineer가 answer.
// 포인터·드로잉용 DataChannel('draw')은 offer에 미리 포함해 둔다.

export type Role = "engineer" | "customer";

export type CallState =
  | "waiting" // 채널 구독 완료, 상대 대기
  | "connecting" // offer/answer 교환 중
  | "connected"
  | "failed"
  | "ended"; // bye 수신 또는 직접 종료

export interface CallSessionOptions {
  roomId: string;
  role: Role;
  iceServers: RTCIceServer[];
  // customer: 카메라+마이크 / engineer: 마이크(없으면 null — 듣기만)
  localStream: MediaStream | null;
  onState: (state: CallState) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onDataChannel?: (dc: RTCDataChannel) => void;
  onPeerPresent?: (present: boolean) => void;
}

export class CallSession {
  private supabase = createClient();
  private channel: RealtimeChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private negotiating = false;
  private closed = false;

  constructor(private opts: CallSessionOptions) {}

  join() {
    const { roomId, role } = this.opts;

    this.channel = this.supabase.channel(`room:${roomId}`, {
      config: { presence: { key: role }, broadcast: { self: false } },
    });

    this.channel
      .on("broadcast", { event: "offer" }, ({ payload }) => {
        if (role === "engineer") this.answer(payload.sdp);
      })
      .on("broadcast", { event: "answer" }, ({ payload }) => {
        if (role === "customer") this.acceptAnswer(payload.sdp);
      })
      .on("broadcast", { event: "ice" }, ({ payload }) => {
        if (payload.from !== role) this.addIce(payload.candidate);
      })
      .on("broadcast", { event: "bye" }, () => this.teardown("ended"))
      .on("presence", { event: "sync" }, () => this.onPresenceSync())
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await this.channel?.track({ at: Date.now() });
          this.opts.onState("waiting");
        }
      });
  }

  private peerRole(): Role {
    return this.opts.role === "engineer" ? "customer" : "engineer";
  }

  private onPresenceSync() {
    if (this.closed || !this.channel) return;
    const present = !!this.channel.presenceState()[this.peerRole()]?.length;
    this.opts.onPeerPresent?.(present);

    if (!present) {
      // 상대가 나갔다 — 연결을 정리하고 재접속을 기다린다 (고객이 새로고침하는 경우)
      if (this.pc) this.resetPeer();
      return;
    }

    // customer가 offer 측: 엔지니어가 보이고 아직 연결 전이면 시작
    if (this.opts.role === "customer" && !this.pc && !this.negotiating) {
      this.offer();
    }
  }

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers });

    this.opts.localStream
      ?.getTracks()
      .forEach((t) => pc.addTrack(t, this.opts.localStream!));

    pc.ontrack = (e) => {
      if (e.streams[0]) this.opts.onRemoteStream(e.streams[0]);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.send("ice", {
          from: this.opts.role,
          candidate: e.candidate.toJSON(),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === "connected") this.opts.onState("connected");
      else if (pc.connectionState === "failed") this.opts.onState("failed");
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

      const dc = pc.createDataChannel("draw");
      this.opts.onDataChannel?.(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send("offer", { sdp: offer });
    } catch (e) {
      console.error("[call] offer 실패:", e);
      this.opts.onState("failed");
    } finally {
      this.negotiating = false;
    }
  }

  private async answer(sdp: RTCSessionDescriptionInit) {
    try {
      this.opts.onState("connecting");
      if (this.pc) this.resetPeer(); // 고객이 재시도한 경우 이전 연결 폐기
      const pc = this.createPeer();

      pc.ondatachannel = (e) => this.opts.onDataChannel?.(e.channel);

      await pc.setRemoteDescription(sdp);
      this.flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send("answer", { sdp: answer });
    } catch (e) {
      console.error("[call] answer 실패:", e);
      this.opts.onState("failed");
    }
  }

  private async acceptAnswer(sdp: RTCSessionDescriptionInit) {
    try {
      if (!this.pc) return;
      await this.pc.setRemoteDescription(sdp);
      this.flushIce();
    } catch (e) {
      console.error("[call] answer 수신 처리 실패:", e);
      this.opts.onState("failed");
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
    this.channel?.send({ type: "broadcast", event, payload });
  }

  // 카메라 전/후면 전환 (재협상 없이 replaceTrack)
  async replaceVideoTrack(track: MediaStreamTrack) {
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
    this.pendingIce = [];
    if (!this.closed) this.opts.onState("waiting");
  }

  // 직접 종료: 상대에게 bye를 알리고 정리
  hangup() {
    this.send("bye", { from: this.opts.role });
    this.teardown("ended");
  }

  private teardown(state: CallState) {
    if (this.closed) return;
    this.pc?.close();
    this.pc = null;
    this.opts.onState(state);
  }

  // 언마운트 시 호출. 로컬 트랙 정지는 호출측 책임(미리보기 재사용 가능성).
  destroy() {
    this.closed = true;
    this.pc?.close();
    this.pc = null;
    if (this.channel) this.supabase.removeChannel(this.channel);
    this.channel = null;
  }
}
