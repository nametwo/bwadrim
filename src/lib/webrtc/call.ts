import type {
  RealtimeChannel,
  RealtimePresenceState,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { isPointerPos, type PointerPos } from "./pointer";
import { parseDrawCommand, type DrawCommand, type DrawEvent } from "./draw";
import {
  parseCameraCommand,
  parseCameraState,
  type CameraCommand,
  type CameraState,
} from "./camera";
import { fromRTCDataChannel, type ChannelDataLink, type DataLink } from "./data-link";

// 정지 화면(JPEG data URL)은 DataChannel 메시지 크기 제한 때문에 조각내 보낸다
const FREEZE_CHUNK = 12_000;
const FREEZE_MAX_CHUNKS = 400;
// 상대 presence가 사라져도 통화(P2P)가 살아 있으면 이만큼 기다린 뒤에야 정리한다 — 양쪽 모두.
// 시그널링 소켓만 잠깐 끊겼다가(앱 전환·망 전환·엘리베이터) 같은 기기로 다시 붙는 경우가 있다 (CALL-05).
// 2026-10-21 전에는 엔지니어 쪽에만 있어서, 엔지니어 폰의 소켓이 흔들리면 고객 폰이 멀쩡한 영상을 끊고 다시 맺었다
const PEER_GONE_GRACE_MS = 8000;
// 엔지니어: 연결된 동안 고객 채널로 온 종료(bye)는 보낸 기기가 이 시간 안에 채널에서 정말 나가야 따른다 (CALL-12)
const BYE_CLAIM_MS = 5000;
// 고객: offer를 보내고 이 시간 안에 answer가 없으면 다시 청한다 (CALL-03). broadcast는 저장되지 않아 받는 쪽 소켓이
// 재접속 중이면 신호가 그냥 사라지는데, 그러면 양쪽이 '연결 중'에서 영영 멈춘다. 이만큼 거듭 안 되면 실패로 본다
const OFFER_TIMEOUT_MS = 10_000;
const OFFER_MAX_RETRIES = 3;
// 엔지니어: 같은 고객 기기의 종료가 DataChannel과 시그널링으로 두 번 오면 한 번만 처리한다
const BYE_DEDUP_MS = 3000;

// 1:1 P2P 통화 세션. 시그널링은 Supabase Realtime 비공개(private) 채널 두 개 — 역할별 일방통행.
//   room:{id}:e  엔지니어 → 고객. 보내기(broadcast·presence)는 방 주인(로그인 JWT)만 — DB 정책(RLS)이 검사
//   room:{id}:c  고객 → 엔지니어. 링크를 연 사람 누구나
// 각자 자기 채널로만 보내고 상대 채널만 듣는다. 고객은 :e에서 온 신호만 믿으므로
// 링크를 가진 제3자가 엔지니어 행세를 할 수 없다 (BUG-09). 정책은 supabase/schema.sql.
// 이어받기 (BUG-04): 기기(탭)마다 고유 id를 두고, 같은 역할이 여러 기기에서 들어오면 **가장 늦게 들어온 기기**가
// 이어받는다. 신호에는 보낸 id(from)와 받을 id(to)를 붙여 다른 기기의 신호를 무시한다.
// 밀려난 기기는 'replaced'가 되고 채널에서 나간다(bye 없음 — 상대 연결은 새 기기와 이어진다).
// 순서는 서버 시각 기준(clockOffsetMs)이라 기기 시계가 틀려도 대체로 맞다.
// 역할 고정: customer(카메라 보유)가 offer, engineer가 answer.
// 포인터·드로잉용 DataChannel('draw')은 offer에 미리 포함해 둔다.
// AR 핀(CALL-14)은 전용 DataChannel('anchor')을 따로 연다 — 기준 사진 조각이 'draw'의 포인터·그리기를 막지 않게.
// 연결이 바뀌어도(재연결·이어받기) 같은 anchorLink 객체에 새 채널을 붙이므로 쓰는 쪽은 한 번만 받으면 된다.
// 방향 지시(CALL-15)도 전용 DataChannel('guide') — 누르는 동안 0.4초마다 오는 hold가 사진 조각 뒤에 막히면
// 고객 쪽 1.5초 만료가 지나 화살표가 저절로 사라진다(고객에겐 '멈춤'으로 보임). guideLink도 anchorLink처럼 같은 객체.
// 사진 찍기(CALL-16)도 전용 DataChannel('photo') — 원본 사진(수백 KB~수 MB)이 다른 채널을 막지 않게. photoLink도 같은 객체.
// 포인터는 연결 후 DataChannel로, 아직 열리지 않았으면 시그널링 broadcast로 보낸다.
// 엔지니어가 유예(PEER_GONE_GRACE_MS)가 끝나 연결을 버린 뒤 바로 그 고객 기기가 돌아오면 'reoffer'를 보낸다 — 그 기기는
// 자기 연결이 살아 있는 줄 알아(상대가 pc를 닫아도 브라우저는 수십 초 뒤에야 안다) 새 offer를 보내지 않기 때문 (CALL-05).
// 고객 채널(:c)은 링크를 가진 누구나 쓸 수 있고 from도 보낸 쪽이 직접 적는다. 그래서 엔지니어는 (CALL-12)
//  - 연결된 동안의 고객 종료는 DTLS로 보호되는 'draw' 채널의 {t:'bye'}로 받는다. 시그널링 bye만 오면
//    보낸 기기가 채널에서 정말 나갈 때까지(BYE_CLAIM_MS) 기다렸다 따른다
//  - 고객은 세션 동안 같은 DTLS 인증서로 연결한다(pinned). 같은 기기 id인데 인증서 지문이 다른 offer가 오면
//    다른 기기가 그 id를 흉내 낸 것일 수 있어 '고객 쪽 기기가 바뀌었어요'(onPeerChanged)를 띄운다

export type Role = "engineer" | "customer";

export type CallState =
  | "waiting" // 채널 구독 완료, 상대 대기
  | "connecting" // offer/answer 교환 중
  | "connected"
  | "failed"
  | "denied" // 채널 권한 거부 — 엔지니어는 로그인 만료, 고객은 세션 종료·만료
  | "replaced" // 같은 역할의 다른 기기가 이어받았다. 세션은 스스로 닫혔다
  | "ended"; // 상대가 종료(bye 수신). 내가 hangup()한 경우엔 알리지 않는다

export interface CallSessionOptions {
  roomId: string;
  role: Role;
  iceServers: RTCIceServer[];
  // customer: 카메라+마이크 / engineer: 마이크(없으면 null — 듣기만)
  localStream: MediaStream | null;
  // 서버 시각 - 이 기기 시각(ms). 이어받기 순서를 정하는 데 쓴다 (fetchIceServers가 알려 준다)
  clockOffsetMs?: number;
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
  // 상대 기기가 바뀌었다 (새로고침 또는 다른 기기에서 링크를 열었음)
  onPeerChanged?: () => void;
  // 연결된 뒤 잠깐 끊겼다(unstable) / 다시 붙었다(good). 브라우저가 스스로 다시 붙거나, 못 붙으면 failed가 된다
  onQuality?: (quality: CallQuality) => void;
}

export type CallQuality = "good" | "unstable";

// presence에 올리는 내 정보. at = 들어온 시각(서버 기준)
interface Member {
  id: string;
  at: number;
}

function isNewer(a: Member, b: Member) {
  return a.at !== b.at ? a.at > b.at : a.id > b.id;
}

// 채널에 있는 기기 중 가장 늦게 들어온 기기 (모든 기기가 같은 답을 얻는다)
function newestMember(state: RealtimePresenceState): Member | null {
  let best: Member | null = null;
  for (const metas of Object.values(state)) {
    for (const m of metas as unknown as Partial<Member>[]) {
      if (typeof m.id !== "string" || typeof m.at !== "number") continue;
      const member = { id: m.id, at: m.at };
      if (!best || isNewer(member, best)) best = member;
    }
  }
  return best;
}

// SDP에 실린 DTLS 인증서 지문 ('sha-256 ab:cd:…'). 없으면 null
function sdpFingerprint(sdp: RTCSessionDescriptionInit): string | null {
  const m = /^a=fingerprint:(.+)$/m.exec(sdp.sdp ?? "");
  return m ? m[1].trim().toLowerCase() : null;
}

// 고객 기기의 DTLS 인증서. 다시 연결할 때도 같은 것을 써서, 엔지니어가 지문으로 같은 기기인지 알아볼 수 있게 한다.
// 만들지 못하면(지원 안 함) null — 연결마다 브라우저가 새로 만든다
async function makeCertificate(): Promise<RTCCertificate | null> {
  try {
    return await RTCPeerConnection.generateCertificate({
      name: "ECDSA",
      namedCurve: "P-256",
    } as EcKeyGenParams);
  } catch {
    return null;
  }
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
  // 이 기기(탭)의 id와 들어온 시각
  private readonly id = crypto.randomUUID();
  private joinedAt = 0;
  // 상대 역할에서 지금 이어받은 기기 / 지금 연결(pc)의 상대 기기
  private activePeer: string | null = null;
  private pcPeer: string | null = null;
  // 엔지니어: presence보다 먼저 도착한 offer
  private pendingOffer: { from: string; sdp: RTCSessionDescriptionInit; pinned: boolean; n?: number } | null =
    null;
  // 고객: 이 세션 동안 모든 연결에 쓰는 DTLS 인증서 (없으면 연결마다 브라우저가 새로 만든다)
  private cert: RTCCertificate | null = null;
  // 엔지니어: 고객 기기 id별 첫 pinned offer의 인증서 지문
  private readonly peerPrints = new Map<string, string>();
  // 엔지니어: 고객 presence가 사라진 뒤 살아 있는 연결을 정리하기까지의 유예 타이머
  private peerGoneTimer: ReturnType<typeof setTimeout> | null = null;
  // 엔지니어: 유예가 끝나 연결을 버린 고객 기기 id. 같은 기기가 돌아오면 reoffer를 보낸다
  private lostPeer: string | null = null;
  // 고객: 지금 offer의 번호(answer가 어느 offer의 것인지 맞춰 본다)와 answer 대기 타이머·재시도 횟수
  private offerSeq = 0;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  private offerRetries = 0;
  // 엔지니어: 연결된 동안 시그널링으로 온 고객 종료. 그 기기가 채널에서 나가면 따른다
  private byeClaim: { from: string; until: number } | null = null;
  // 엔지니어: 마지막으로 따른 고객 종료 (같은 종료가 두 길로 오는 것을 한 번만)
  private lastBye: { from: string; at: number } | null = null;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: { from: string; candidate: RTCIceCandidateInit }[] = [];
  private dc: RTCDataChannel | null = null;
  private readonly anchorChannel: ChannelDataLink = fromRTCDataChannel(null);
  private readonly guideChannel: ChannelDataLink = fromRTCDataChannel(null);
  // 사진 찍기(CALL-16): 고객 원본 사진 조각이 포인터·방향 지시를 막지 않게 전용 채널. 큰 사진이라 큐를 넉넉히
  private readonly photoChannel: ChannelDataLink = fromRTCDataChannel(null, { maxQueueBytes: 12 * 1024 * 1024 });
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
    void this.start();
  }

  private async start() {
    const { roomId, role } = this.opts;
    const peer = this.peerRole();

    // 로그인 토큰(JWT)을 소켓에 먼저 실어 둔다. 페이지를 막 연 직후엔 토큰이 늦게 붙어서,
    // 그 전에 채널에 들어가면 익명으로 취급돼 엔지니어 채널 보내기가 거부된다 (고객은 원래 익명).
    // 고객은 그동안 이 세션에서 쓸 인증서를 만든다 — 첫 offer부터 같은 지문이어야 한다
    const [, cert] = await Promise.all([
      this.refreshAuth(),
      role === "customer" ? makeCertificate() : null,
    ]);
    if (this.closed) return;
    this.cert = cert;
    this.joinedAt = Date.now() + (this.opts.clockOffsetMs ?? 0);

    // 내 채널의 presence도 본다: 같은 역할의 더 늦은 기기가 오면 물러난다
    this.sendLane = this.supabase.channel(laneTopic(roomId, role), {
      config: {
        private: true,
        presence: { key: this.id },
        broadcast: { self: false },
      },
    });
    this.listenLane = this.supabase.channel(laneTopic(roomId, peer), {
      config: { private: true },
    });

    const me: Member = { id: this.id, at: this.joinedAt };
    this.sendLane
      .on("presence", { event: "sync" }, () => this.onOwnLaneSync())
      .subscribe(async (status, err) => {
      if (status === "SUBSCRIBED") {
        let tracked = await this.sendLane?.track(me);
        if (tracked === "error") {
          // 토큰이 막 바뀐 경우일 수 있다 — 토큰을 다시 싣고 한 번 더
          await this.refreshAuth();
          tracked = await this.sendLane?.track(me);
        }
        if (this.closed) return;
        // 그래도 거부 = 보내기 권한이 없다 (로그인이 풀렸거나 이 세션의 주인이 아님)
        if (tracked === "error") {
          this.onChannelError(new Error("Unauthorized: presence track"));
          return;
        }
        this.sendLaneReady = true;
        // 재구독(망 전환 등)이나 track 대기 중 이미 연결이 시작됐으면 상태를 덮어쓰지 않는다
        if (!this.closed && !this.pc) this.opts.onState("waiting");
        this.onOwnLaneSync();
        this.onPresenceSync(); // 상대가 먼저 와 있었으면 지금 시작
      } else if (status === "CHANNEL_ERROR") {
        this.onChannelError(err);
      }
    });

    this.listenLane
      .on("broadcast", { event: "offer" }, ({ payload }) => {
        if (role === "engineer") this.onOffer(payload);
      })
      .on("broadcast", { event: "answer" }, ({ payload }) => {
        if (role === "customer") this.acceptAnswer(payload);
      })
      .on("broadcast", { event: "reoffer" }, ({ payload }) => {
        if (role === "customer") this.onReoffer(payload);
      })
      .on("broadcast", { event: "ice" }, ({ payload }) => this.onIce(payload))
      .on("broadcast", { event: "bye" }, ({ payload }) => this.onByeSignal(payload))
      .on("broadcast", { event: "pointer" }, ({ payload }) => {
        if (payload?.from === this.activePeer) this.receivePointer(payload);
      })
      .on("broadcast", { event: "cam" }, ({ payload }) => {
        if (payload?.from === this.activePeer) this.receiveCamera(payload);
      })
      .on("presence", { event: "sync" }, () => this.onPresenceSync())
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR") this.onChannelError(err);
      });
  }

  private async refreshAuth() {
    try {
      await this.supabase.realtime.setAuth();
    } catch (e) {
      console.warn("[call] 토큰 갱신 실패:", e);
    }
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

  // 같은 역할의 더 늦은 기기가 들어왔으면 물러난다. bye는 보내지 않는다 — 상대는 새 기기와 이어진다
  private onOwnLaneSync() {
    if (this.closed || !this.sendLane || !this.sendLaneReady) return;
    const top = newestMember(this.sendLane.presenceState());
    if (top && top.id !== this.id && isNewer(top, { id: this.id, at: this.joinedAt })) {
      this.opts.onState("replaced");
      this.destroy();
    }
  }

  private onPresenceSync() {
    if (this.closed || !this.listenLane) return;
    const top = newestMember(this.listenLane.presenceState());
    this.opts.onPeerPresent?.(!!top);

    const prev = this.activePeer;
    this.activePeer = top?.id ?? null;

    // 엔지니어: 연결된 채로 시그널링 종료를 받았고, 이제 고객 채널이 비었다 = 그 기기가 정말 끝내고 나갔다.
    // 다른 기기가 남아 있거나 새로 왔으면 따르지 않는다 — 가짜 종료 뒤 이어받기는 '기기가 바뀌었어요'로 알려야 한다
    const claim = this.byeClaim;
    if (claim && Date.now() > claim.until) this.byeClaim = null;
    else if (claim && !top) {
      this.byeClaim = null;
      this.onBye(claim.from);
      return;
    }

    if (!top) {
      // 통화가 살아 있으면 곧바로 끊지 않는다(양쪽 모두). 상대의 시그널링 소켓만 잠깐 끊겼다가 같은 기기로
      // 다시 붙었을 수 있고, 그때 연결을 버리면 상대 쪽은 자기 연결이 살아 있어 다시 맺지 못한다 (CALL-05).
      // 같은 기기가 돌아오면(아래 top.id === pcPeer) 살아 있는 연결을 그대로 쓴다.
      // 정말 나갔으면 유예하는 동안 연결이 '불안정'이 되고, 유예가 끝나면 정리한다
      if (this.pc?.connectionState === "connected") {
        this.peerGoneTimer ??= setTimeout(() => {
          this.peerGoneTimer = null;
          if (!this.closed && !this.activePeer && this.pc) {
            // 엔지니어는 버린 기기를 기억해 둔다 — 같은 기기가 돌아오면 다시 맺자고 알려야 한다 (reoffer)
            if (this.opts.role === "engineer") this.lostPeer = this.pcPeer;
            this.resetPeer();
          }
        }, PEER_GONE_GRACE_MS);
        return;
      }
      // 상대가 나갔다 — 연결을 정리하고 재접속을 기다린다 (고객이 새로고침하는 경우)
      if (this.pc) this.resetPeer();
      return;
    }
    this.clearPeerGoneTimer();

    if (top.id !== prev) {
      // 상대 기기가 바뀌었다 — 이전 기기와의 연결은 버리고 새 기기와 맺는다.
      // 유예 중에 같은 기기가 돌아왔으면(prev는 비어 있다) 살아 있는 연결을 그대로 둔다
      const stale = !!this.pc && top.id !== this.pcPeer;
      if (stale) this.resetPeer();
      if (prev || stale) this.opts.onPeerChanged?.();
      this.offerRetries = 0;
      const queued = this.pendingOffer;
      if (queued?.from === top.id) {
        this.pendingOffer = null;
        this.answer(queued.from, queued.sdp, queued.pinned, queued.n);
        return;
      }
    }

    // 엔지니어: 유예가 끝나 연결을 버린 바로 그 고객 기기가 돌아왔다. 그 기기는 자기 연결이 살아 있는 줄 알아
    // 새 offer를 보내지 않으므로 다시 맺자고 알린다. 다른 기기면 그쪽이 스스로 offer한다
    if (this.lostPeer) {
      if (this.opts.role === "engineer" && !this.pc && top.id === this.lostPeer) {
        this.send("reoffer", { to: top.id });
      }
      this.lostPeer = null;
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

  private createPeer(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers,
      ...(this.cert ? { certificates: [this.cert] } : {}),
    });

    const stream = this.localStream;
    stream?.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.ontrack = (e) => {
      if (e.streams[0]) this.opts.onRemoteStream(e.streams[0]);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && this.pc === pc) {
        this.send("ice", { to: peerId, candidate: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.closed || this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        this.opts.onQuality?.("good");
        this.opts.onState("connected");
      } else if (pc.connectionState === "disconnected") {
        // 망이 잠깐 흔들림(와이파이↔데이터 전환, 엘리베이터 등). 대개 몇 초 안에 connected로 돌아온다
        this.opts.onQuality?.("unstable");
      } else if (pc.connectionState === "failed") this.fail();
    };

    this.pc = pc;
    this.pcPeer = peerId;
    this.lostPeer = null;
    return pc;
  }

  // 고객: 엔지니어가 내 연결을 버렸다고 알려 왔다(유예 만료 뒤 돌아온 경우). 지금 연결을 버리고 새로 청한다.
  // :e 채널은 방 주인만 쓸 수 있으므로 믿는다. 나에게 온, 지금 이어진 엔지니어 기기 것만 따른다
  private onReoffer(payload: { from?: unknown; to?: unknown } | null | undefined) {
    if (this.closed || payload?.to !== this.id || payload.from !== this.activePeer) return;
    if (this.pc) this.resetPeer();
    this.onPresenceSync();
  }

  private async offer() {
    const peerId = this.activePeer;
    if (!peerId) return;
    let pc: RTCPeerConnection | null = null;
    const n = ++this.offerSeq;
    try {
      this.negotiating = true;
      this.opts.onState("connecting");
      pc = this.createPeer(peerId);

      this.attachDataChannel(pc.createDataChannel("draw"));
      this.anchorChannel.attach(pc.createDataChannel("anchor"));
      this.guideChannel.attach(pc.createDataChannel("guide"));
      this.photoChannel.attach(pc.createDataChannel("photo"));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.pc !== pc) return; // 그사이 상대 기기가 바뀌었다
      // pinned: 이 세션의 연결은 모두 같은 인증서 — 엔지니어가 지문으로 같은 기기인지 본다
      // n: offer 번호. 엔지니어가 answer에 그대로 실어 보내 늦게 온 예전 answer를 가려낸다
      this.send("offer", { to: peerId, sdp: offer, n, ...(this.cert ? { pinned: true } : {}) });
      this.armOfferTimer(pc);
    } catch (e) {
      if (this.pc !== pc) return;
      console.error("[call] offer 실패:", e);
      this.fail();
    } finally {
      this.negotiating = false;
      // 준비하는 동안 상대 기기가 바뀌었으면 새 기기로 다시 시작
      if (!this.closed && this.pc !== pc) this.onPresenceSync();
    }
  }

  // 엔지니어: 지금 이어진 고객 기기의 offer만 받는다. presence가 아직 안 왔으면 잠시 맡아 둔다
  private onOffer(payload: {
    from?: unknown;
    to?: unknown;
    sdp?: RTCSessionDescriptionInit;
    pinned?: unknown;
    n?: unknown;
  }) {
    if (typeof payload?.from !== "string" || payload.to !== this.id || !payload.sdp) {
      return;
    }
    const pinned = payload.pinned === true;
    const n = typeof payload.n === "number" ? payload.n : undefined;
    if (payload.from !== this.activePeer) {
      this.pendingOffer = { from: payload.from, sdp: payload.sdp, pinned, n };
      return;
    }
    this.answer(payload.from, payload.sdp, pinned, n);
  }

  // 같은 기기 id로 온 offer인데 인증서 지문이 처음과 다르면, 링크를 가진 다른 기기가 그 id를 흉내 낸 것일 수 있다.
  // 기기가 바뀐 것과 같이 알리고(CALL-13) 새 기기로 받는다. 지문은 pinned offer일 때만 처음 기억한다 —
  // 인증서를 못 만든 고객 폰은 연결마다 지문이 바뀌므로
  private checkPeerPrint(from: string, sdp: RTCSessionDescriptionInit, pinned: boolean) {
    const print = sdpFingerprint(sdp);
    if (!print) return;
    const known = this.peerPrints.get(from);
    if (known && known !== print) {
      this.opts.onPeerChanged?.();
      this.peerPrints.set(from, print);
    } else if (!known && pinned) {
      this.peerPrints.set(from, print);
    }
  }

  private async answer(peerId: string, sdp: RTCSessionDescriptionInit, pinned: boolean, n?: number) {
    this.checkPeerPrint(peerId, sdp, pinned);
    let pc: RTCPeerConnection | null = null;
    try {
      // 고객이 재시도한 경우 이전 연결 폐기. resetPeer가 'waiting'을 알리므로 그 뒤에 'connecting'을 알린다 —
      // 순서가 바뀌면 재협상 동안 엔지니어 화면이 어두운 통화 화면에서 흰 대기 화면으로 갔다 돌아온다
      if (this.pc) this.resetPeer();
      this.opts.onState("connecting");
      pc = this.createPeer(peerId);

      pc.ondatachannel = (e) => {
        if (e.channel.label === "anchor") this.anchorChannel.attach(e.channel);
        else if (e.channel.label === "guide") this.guideChannel.attach(e.channel);
        else if (e.channel.label === "photo") this.photoChannel.attach(e.channel);
        else this.attachDataChannel(e.channel);
      };

      await pc.setRemoteDescription(sdp);
      if (this.pc !== pc) return;
      this.flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.pc !== pc) return;
      this.send("answer", { to: peerId, sdp: answer, ...(n !== undefined ? { n } : {}) });
    } catch (e) {
      if (this.pc !== pc) return;
      console.error("[call] answer 실패:", e);
      this.fail();
    }
  }

  private async acceptAnswer(payload: { from?: unknown; to?: unknown; sdp?: RTCSessionDescriptionInit; n?: unknown }) {
    const pc = this.pc;
    if (!pc || payload?.to !== this.id || payload.from !== this.pcPeer || !payload.sdp) {
      return;
    }
    // 다시 청한 뒤 늦게 도착한 예전 offer의 answer는 버린다 (번호가 없는 answer는 예전 엔지니어 화면 — 그대로 받는다)
    if (typeof payload.n === "number" && payload.n !== this.offerSeq) return;
    try {
      await pc.setRemoteDescription(payload.sdp);
      if (this.pc !== pc) return;
      this.clearOfferTimer();
      this.offerRetries = 0;
      this.flushIce();
    } catch (e) {
      if (this.pc !== pc) return;
      console.error("[call] answer 수신 처리 실패:", e);
      this.fail();
    }
  }

  // 나에게 온, 지금(또는 곧) 연결할 기기의 후보만 받는다
  private onIce(payload: { from?: unknown; to?: unknown; candidate?: RTCIceCandidateInit }) {
    if (typeof payload?.from !== "string" || payload.to !== this.id || !payload.candidate) {
      return;
    }
    this.addIce(payload.from, payload.candidate);
  }

  private async addIce(from: string, candidate: RTCIceCandidateInit) {
    const pc = this.pc;
    if (pc?.remoteDescription && from === this.pcPeer) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("[call] ICE 후보 추가 실패:", e);
      }
    } else {
      // 연결 준비 전(엔지니어가 offer를 맡아 둔 사이 포함) — 연결을 맺으면 그 기기 것만 넣는다
      this.pendingIce.push({ from, candidate });
      if (this.pendingIce.length > 200) this.pendingIce.shift();
    }
  }

  private flushIce() {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const q of queued) {
      if (q.from === this.pcPeer) this.addIce(q.from, q.candidate);
    }
  }

  // 모든 신호에 내 기기 id(from)를 붙인다
  private send(event: string, payload: Record<string, unknown>) {
    this.sendLane?.send({
      type: "broadcast",
      event,
      payload: { ...payload, from: this.id },
    });
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
      if (t === "bye") {
        // 고객이 끝냈다. DTLS로 보호된 연결 안으로 온 것이라 그대로 따른다 (CALL-12). 엔지니어는 이 길로 보내지 않는다
        if (this.opts.role === "engineer" && this.dc === dc && this.pcPeer) this.onBye(this.pcPeer);
        return;
      }
      if (t === "pointer") this.receivePointer(msg);
      else if (t === "cam" || t === "cam-state") this.receiveCamera(msg);
      else if (t === "freeze-chunk") this.receiveFreezeChunk(msg);
      else {
        const cmd = parseDrawCommand(msg);
        if (cmd && !this.closed) this.opts.onDraw?.(cmd);
      }
    };
  }

  // AR 핀 추적 프로토콜용 전송로 (src/lib/tracking). 세션이 살아 있는 동안 같은 객체
  get anchorLink(): DataLink {
    return this.anchorChannel;
  }

  // 방향 지시(CALL-15)용 전송로 (src/lib/webrtc/guide.ts 메시지). 세션이 살아 있는 동안 같은 객체
  get guideLink(): DataLink {
    return this.guideChannel;
  }

  // 사진 찍기(CALL-16)용 전송로 (src/lib/webrtc/photo.ts 메시지). 세션이 살아 있는 동안 같은 객체
  get photoLink(): DataLink {
    return this.photoChannel;
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

  private clearPeerGoneTimer() {
    if (this.peerGoneTimer) clearTimeout(this.peerGoneTimer);
    this.peerGoneTimer = null;
  }

  // 고객: answer가 제때 안 오면 다시 청한다. 몇 번을 거듭해도 안 오면 실패('연결이 끊겼어요 / 다시 연결')
  private armOfferTimer(pc: RTCPeerConnection) {
    this.clearOfferTimer();
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null;
      if (this.closed || this.pc !== pc || pc.remoteDescription) return;
      if (this.offerRetries >= OFFER_MAX_RETRIES) {
        console.warn("[call] answer가 오지 않아 연결 실패");
        this.fail();
        return;
      }
      this.offerRetries++;
      console.warn(`[call] answer가 없어 다시 청한다 (${this.offerRetries}/${OFFER_MAX_RETRIES})`);
      this.resetPeer();
      this.onPresenceSync();
    }, OFFER_TIMEOUT_MS);
  }

  private clearOfferTimer() {
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
  }

  private resetPeer() {
    const old = this.pcPeer;
    this.clearPeerGoneTimer();
    this.clearOfferTimer();
    // 버리는 연결에 대한 종료 주장도 같이 버린다
    this.byeClaim = null;
    this.pc?.close();
    this.pc = null;
    this.pcPeer = null;
    this.dc = null;
    this.anchorChannel.attach(null);
    this.guideChannel.attach(null);
    this.photoChannel.attach(null);
    this.incomingFreeze = null;
    // 이전 기기의 후보만 버린다 — 새 기기 후보가 먼저 와 있을 수 있다
    this.pendingIce = this.pendingIce.filter((q) => q.from !== old);
    if (!this.closed) this.opts.onState("waiting");
  }

  // 직접 종료: 상대에게 bye를 알리고 채널에서 나간다. onState는 부르지 않는다(호출측이 안다).
  // 채널이 붙어 있으면 bye는 즉시 소켓에 실리므로 곧바로 나가도 순서가 지켜진다.
  // 채널을 만들기 전(토큰 갱신 대기 중)이면 채널 없이 REST로 보낸다. 돌려주는 약속은 그 전송이 끝날 때 풀린다 —
  // 기다리지 않아도 보내기는 시작된다. 이미 닫힌 세션(밀려남·실패)은 아무것도 보내지 않는다
  hangup(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.sendLane) {
      const sent = sendBye(this.opts.roomId, this.opts.role).catch(() => {});
      this.destroy();
      return sent;
    }
    // 고객: 연결돼 있으면 DTLS로 보호되는 'draw' 채널로 먼저 알린다. 엔지니어는 연결된 동안 시그널링 bye만으로는
    // 끝내지 않는다(누구나 보낼 수 있으므로). 시그널링 bye는 연결 전이거나 이 메시지가 못 간 경우를 위해 같이 보낸다
    if (this.opts.role === "customer" && this.dc?.readyState === "open") {
      try {
        this.dc.send(JSON.stringify({ t: "bye" }));
      } catch {
        // 닫히는 중 — 시그널링 bye로 알린다
      }
    }
    this.send("bye", { role: this.opts.role });
    this.destroy();
    return Promise.resolve();
  }

  // 종료 신호(bye)를 시그널링으로 받았다. 엔지니어 채널엔 방 주인만 쓸 수 있으므로 엔지니어의 종료는
  // 어느 기기에서 왔든 따른다(세션 없이 보내는 sendBye는 id가 없다). 고객 쪽 종료는 지금 이어진 기기 것만.
  // 고객 채널은 누구나 쓸 수 있어, 그 기기와 연결된 동안 온 것은 그 기기가 채널에서 나갈 때까지 미뤄 둔다(onPresenceSync).
  // 진짜 고객은 'draw' 채널로도 보내므로 대개 그쪽이 먼저 끝낸다. 연결 전이거나 불안정할 때는 바로 따른다
  private onByeSignal(payload: { from?: unknown } | null | undefined) {
    if (this.opts.role === "customer") {
      this.onBye();
      return;
    }
    const from = payload?.from;
    if (typeof from !== "string" || from !== this.activePeer) return;
    if (this.pc && this.pcPeer === from && this.pc.connectionState === "connected") {
      this.byeClaim = { from, until: Date.now() + BYE_CLAIM_MS };
      return;
    }
    this.onBye(from);
  }

  // 상대가 종료했다. 고객은 채널에서 나가 이후 재연결되지 않게 하고,
  // 엔지니어는 채널에 남아 고객이 링크를 다시 열면 이어받는다.
  // from: 엔지니어가 받은 고객 기기 id. 같은 기기의 종료가 'draw' 채널과 시그널링 두 길로 오면 한 번만 따른다
  // (다시 들어온 고객은 새 id라 막히지 않는다)
  private onBye(from?: string) {
    if (this.closed) return;
    if (this.opts.role === "engineer" && from) {
      const now = Date.now();
      if (this.lastBye?.from === from && now - this.lastBye.at < BYE_DEDUP_MS) return;
      this.lastBye = { from, at: now };
    }
    this.byeClaim = null;
    this.clearPeerGoneTimer();
    this.pc?.close();
    this.pc = null;
    this.pcPeer = null;
    this.anchorChannel.attach(null);
    this.guideChannel.attach(null);
    this.photoChannel.attach(null);
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
    this.clearPeerGoneTimer();
    this.clearOfferTimer();
    this.anchorChannel.dispose();
    this.guideChannel.dispose();
    this.photoChannel.dispose();
    this.pc?.close();
    this.pc = null;
    this.pcPeer = null;
    for (const ch of [this.sendLane, this.listenLane]) {
      if (ch) this.supabase.removeChannel(ch);
    }
    this.sendLane = null;
    this.listenLane = null;
    this.sendLaneReady = false;
  }
}
