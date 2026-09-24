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
  | "ended"; // 상대가 종료(bye 수신). 내가 hangup()한 경우엔 알리지 않는다

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

// 통화 세션 없이(연결 준비 전, 새로고침 후) 상대에게 종료를 알린다.
// 채널에 들어가지 않고 REST로 보낸다. 세션이 살아 있으면 CallSession.hangup()을 쓸 것 —
// 같은 토픽의 채널을 재사용하므로 여기서 지우면 살아 있는 세션의 채널까지 지워진다.
export async function sendBye(roomId: string, from: Role) {
  const supabase = createClient();
  const channel = supabase.channel(`room:${roomId}`);
  try {
    await channel.httpSend("bye", { from });
  } catch {
    await channel.send({ type: "broadcast", event: "bye", payload: { from } });
  } finally {
    supabase.removeChannel(channel).catch(() => {});
  }
}

export class CallSession {
  private supabase = createClient();
  private channel: RealtimeChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private negotiating = false;
  private closed = false;
  // 카메라 전환 시 교체된다. 이후 새로 맺는 연결도 지금 카메라로 보내기 위함
  private localStream: MediaStream | null;

  constructor(private opts: CallSessionOptions) {
    this.localStream = opts.localStream;
  }

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
      .on("broadcast", { event: "bye" }, () => this.onBye())
      .on("presence", { event: "sync" }, () => this.onPresenceSync())
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await this.channel?.track({ at: Date.now() });
          // 재구독(망 전환 등)이나 track 대기 중 이미 연결이 시작됐으면 상태를 덮어쓰지 않는다
          if (!this.closed && !this.pc) this.opts.onState("waiting");
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

    const stream = this.localStream;
    stream?.getTracks().forEach((t) => pc.addTrack(t, stream));

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

      const dc = pc.createDataChannel("draw");
      this.opts.onDataChannel?.(dc);

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

      pc.ondatachannel = (e) => this.opts.onDataChannel?.(e.channel);

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
    this.channel?.send({ type: "broadcast", event, payload });
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
    if (this.channel) this.supabase.removeChannel(this.channel);
    this.channel = null;
  }
}
