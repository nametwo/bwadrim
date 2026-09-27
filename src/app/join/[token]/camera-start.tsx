"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallState } from "@/lib/webrtc/call";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { keepScreenOn } from "@/lib/wake-lock";
import { PointerMarker, usePointerMarker } from "@/components/pointer-marker";
import { FreezeCanvas } from "@/components/freeze-canvas";
import { applyDrawCommand, type Stroke } from "@/lib/webrtc/draw";
import type { DataLink } from "@/lib/webrtc/data-link";
import {
  CustomerAnchorLayer,
  type CustomerAnchorBanner,
} from "@/components/anchor/customer-anchor";
import { GuideOverlay, useGuideReceiver } from "@/components/guide-overlay";
import { isGuideMsg } from "@/lib/webrtc/guide";
import {
  setTorch,
  switchCamera,
  torchSupported,
  type CameraState,
  type Facing,
} from "@/lib/webrtc/camera";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { NoticeScreen } from "@/components/ui/notice-screen";
import {
  CheckCircleIcon,
  ClockIcon,
  FlipCameraIcon,
  PhoneIcon,
  PhoneOffIcon,
  RefreshIcon,
  Spinner,
  WifiOffIcon,
} from "@/components/ui/icons";
import { StartScreen } from "./start-screen";
import { CameraHelp, cameraFailureOf, type CameraFailure } from "./camera-help";

type Phase = "ready" | "starting" | "call" | "denied" | "gone";

// 기사님이 오래 안 오면 전화로 알려 달라고 안내한다 (JOIN-06)
const LONG_WAIT_MS = 20_000;
// 끝내기 확인 창이 뜬 직후의 탭은 무시한다 — '끝내기'를 두 번 누른 두 번째 탭이 답 버튼에 떨어지지 않게
const CONFIRM_ARM_MS = 600;

// getUserMedia 오류 이름 (DOMException.name). 지표에도 남긴다
function errorName(e: unknown) {
  return typeof e === "object" && e !== null && "name" in e ? String(e.name) : "unknown";
}

// 고객 화면: 한 화면에 한 가지 행동. 큰 버튼 하나 → 카메라 → 자동 연결.
// getUserMedia는 반드시 버튼 탭(사용자 제스처) 이후 호출 (iOS 정책)
export function CameraStart({
  roomId,
  token,
}: {
  roomId: string;
  token: string;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [failure, setFailure] = useState<CameraFailure>("blocked");
  const [callState, setCallState] = useState<CallState>("waiting");
  // 내가 '끝내기'를 눌러 끝났는지 — 잘못 눌렀으면 다시 연결할 수 있게 (JOIN-08)
  const [endedByMe, setEndedByMe] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const confirmShownAtRef = useRef(0);
  // 전화 통화 중 등으로 마이크를 못 써 카메라만 연결했다 (JOIN-04)
  const [micOff, setMicOff] = useState(false);
  const [longWait, setLongWait] = useState(false);
  // 통화 콜백은 시작 시점 값을 기억하므로 지금 카메라 상태는 ref로 읽는다
  const facingRef = useRef<Facing>("environment");
  const torchRef = useRef(false);
  const flippingRef = useRef(false);
  // 기사님이 원격으로 바꿨을 때·연결됐을 때 잠깐 보이는 안내 (CALL-10, CALL-11)
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 폰이 탭 없이는 카메라를 못 바꿀 때: '바꾸기' 버튼을 띄운다
  const [flipRequested, setFlipRequested] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const releaseWakeLockRef = useRef<(() => void) | null>(null);
  const lastStateRef = useRef<CallState>("waiting");
  const { marker, show: showMarker } = usePointerMarker();
  // 기사님이 멈춘 화면과 그 위의 선 (CALL-09)
  const [frozen, setFrozen] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  // 기사님이 길게 눌러 꽂은 AR 핀 (CALL-14). 핀 안내(카드·화살표)가 뜨면 상태 문구는 숨긴다
  const [anchorLink, setAnchorLink] = useState<DataLink | null>(null);
  const [anchorBanner, setAnchorBanner] = useState<CustomerAnchorBanner>(null);
  // 기사님이 십자키를 누르고 있는 동안의 방향 지시 (CALL-15, 전용 채널 'guide')
  const [guideLink, setGuideLink] = useState<DataLink | null>(null);
  const { view: guideView, receive: receiveGuide, reset: resetGuide } = useGuideReceiver();

  function releaseWakeLock() {
    releaseWakeLockRef.current?.();
    releaseWakeLockRef.current = null;
  }

  function showNotice(text: string, ms = 2500) {
    setNotice(text);
    clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), ms);
  }

  function reportCamera(error?: CameraState["error"]) {
    const track = streamRef.current?.getVideoTracks()[0];
    sessionRef.current?.sendCameraState({
      facing: facingRef.current,
      torch: torchRef.current,
      torchSupported: torchSupported(track),
      error,
    });
  }

  function postEvent(name: string, props: Record<string, unknown> = {}) {
    // 지표 기록 — 실패해도 진행을 막지 않는다
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, props }),
      keepalive: true,
    }).catch(() => {});
  }

  // 카메라+마이크를 연다. 마이크를 못 쓰면(전화 통화 중 등) 카메라만이라도 연다 — 목소리는 전화로 하면 된다
  async function openCamera(): Promise<{ stream: MediaStream; mic: boolean } | { error: string }> {
    if (!navigator.mediaDevices?.getUserMedia) return { error: "unsupported" };
    const video = { facingMode: "environment" }; // 후면 카메라
    try {
      return { stream: await navigator.mediaDevices.getUserMedia({ video, audio: true }), mic: true };
    } catch {
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ video }), mic: false };
      } catch (e) {
        return { error: errorName(e) };
      }
    }
  }

  async function start() {
    setPhase("starting");
    // 폰을 비추기만 하고 화면을 안 건드려서 자동 잠금으로 끊기기 쉽다 — 버튼 탭 안에서 요청
    releaseWakeLock();
    releaseWakeLockRef.current = keepScreenOn();
    const opened = await openCamera();
    if ("error" in opened) {
      postEvent("camera_denied", { reason: opened.error });
      releaseWakeLock();
      setFailure(cameraFailureOf(opened.error));
      setPhase("denied");
      return;
    }
    const stream = opened.stream;
    streamRef.current = stream;
    setMicOff(!opened.mic);
    postEvent("camera_granted", { mic: opened.mic });

    const ice = await fetchIceServers(token);
    // 링크를 연 뒤 세션이 닫혔거나 만료됐다 — 종료 알림(bye)은 채널에 들어오기 전이라 받지 못했다
    if (ice.roomGone) {
      stream.getTracks().forEach((t) => t.stop());
      releaseWakeLock();
      setPhase("gone");
      return;
    }
    const session = new CallSession({
      roomId,
      role: "customer",
      iceServers: ice.iceServers,
      clockOffsetMs: ice.clockOffsetMs,
      localStream: stream,
      onState: (s) => {
        const prev = lastStateRef.current;
        lastStateRef.current = s;
        setCallState(s);
        if (s !== "connected") {
          setFrozen(null);
          setStrokes([]);
          resetGuide();
        }
        if (s === "connected") {
          reportCamera();
          if (prev !== "connected") showNotice("기사님과 연결됐어요");
          // relay(TURN) 경유 여부 — 원가 지표. turn: TURN 자격증명을 받았는지
          setTimeout(async () => {
            const relay = (await sessionRef.current?.usedRelay()) ?? false;
            postEvent("connected", { relay, turn: !ice.turnError });
            if (relay) postEvent("relay_used");
          }, 1000);
        }
        if (s === "ended" || s === "failed" || s === "denied" || s === "replaced") {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          releaseWakeLock();
          setConfirmEnd(false);
        }
      },
      onPointer: (pos) => showMarker(videoRef.current, pos),
      onCameraCommand: (cmd) => {
        if (cmd.cmd === "flip") flipCamera(true);
        else applyTorch(cmd.on);
      },
      onDraw: (e) => {
        if (e.t === "freeze") {
          setFrozen(e.image);
          setStrokes([]);
          return;
        }
        if (e.t === "resume") setFrozen(null);
        setStrokes((prev) => applyDrawCommand(prev, e));
      },
      onRemoteStream: (remote) => {
        // 기사님 음성
        remoteStreamRef.current = remote;
        if (audioRef.current) audioRef.current.srcObject = remote;
      },
    });
    sessionRef.current = session;
    setAnchorLink(session.anchorLink);
    setGuideLink(session.guideLink);
    session.join();
    setPhase("call");
  }

  // 끊긴 뒤·다른 곳에 넘어간 뒤·잘못 끝낸 뒤 다시 연결. 새로고침 없이 이 탭 안에서 카메라부터 다시 연다 (JOIN-08·09·11)
  function restart() {
    sessionRef.current?.destroy();
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    remoteStreamRef.current = null;
    lastStateRef.current = "waiting";
    facingRef.current = "environment";
    torchRef.current = false;
    setCallState("waiting");
    setEndedByMe(false);
    setConfirmEnd(false);
    setFlipRequested(false);
    setNotice(null);
    setFrozen(null);
    setStrokes([]);
    setAnchorLink(null);
    setAnchorBanner(null);
    setGuideLink(null);
    resetGuide();
    start();
  }

  // 카메라 전/후면 전환 (replaceTrack — 재협상 불필요). byEngineer: 기사님이 원격으로 요청
  async function flipCamera(byEngineer: boolean) {
    const current = streamRef.current;
    if (!current || flippingRef.current) return;
    flippingRef.current = true;
    try {
      const r = await switchCamera(current, facingRef.current);
      if (r.stream && r.stream !== current) {
        await sessionRef.current?.replaceVideoTrack(r.stream.getVideoTracks()[0]);
        streamRef.current = r.stream;
        if (videoRef.current) videoRef.current.srcObject = r.stream;
        torchRef.current = false; // 새 카메라는 손전등이 꺼진 상태
      }
      facingRef.current = r.facing;
      if (r.ok) {
        setFlipRequested(false);
        if (byEngineer) {
          showNotice(
            r.facing === "user"
              ? "기사님이 앞 카메라로 바꿨어요"
              : "기사님이 뒤 카메라로 바꿨어요",
          );
        }
        reportCamera();
      } else {
        if (r.reason === "needs_tap" && byEngineer) setFlipRequested(true);
        reportCamera(r.reason);
      }
    } finally {
      flippingRef.current = false;
    }
  }

  async function applyTorch(on: boolean) {
    const ok = await setTorch(streamRef.current?.getVideoTracks()[0], on);
    if (ok) {
      torchRef.current = on;
      showNotice(on ? "기사님이 손전등을 켰어요" : "기사님이 손전등을 껐어요");
    }
    reportCamera(ok ? undefined : "failed");
  }

  function askEnd() {
    confirmShownAtRef.current = Date.now();
    setConfirmEnd(true);
  }

  function hangup() {
    if (Date.now() - confirmShownAtRef.current < CONFIRM_ARM_MS) return;
    sessionRef.current?.hangup();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    releaseWakeLock();
    setConfirmEnd(false);
    setEndedByMe(true);
    setCallState("ended");
  }

  // 방향 지시 수신. 채널이 닫히면(재연결) 바로 지운다 — 다시 누르면 새 hold가 온다
  useEffect(() => {
    if (!guideLink) return;
    const offMsg = guideLink.onMessage((data) => {
      if (typeof data !== "string") return;
      try {
        const m: unknown = JSON.parse(data);
        if (isGuideMsg(m)) receiveGuide(m);
      } catch {
        // 형식이 틀린 메시지는 버린다
      }
    });
    const offOpen = guideLink.onOpenChange((open) => {
      if (!open) resetGuide();
    });
    return () => {
      offMsg();
      offOpen();
    };
  }, [guideLink, receiveGuide, resetGuide]);

  // 로컬 미리보기 연결
  useEffect(() => {
    if (phase === "call" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
    if (phase === "call" && audioRef.current && remoteStreamRef.current) {
      audioRef.current.srcObject = remoteStreamRef.current;
    }
  }, [phase, callState]);

  // 기사님을 오래 기다리면 전화로 알려 달라는 안내
  const waitingForEngineer = phase === "call" && callState === "waiting";
  useEffect(() => {
    if (!waitingForEngineer) return;
    const t = setTimeout(() => setLongWait(true), LONG_WAIT_MS);
    return () => {
      clearTimeout(t);
      setLongWait(false);
    };
  }, [waitingForEngineer]);

  // 언마운트 정리
  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      releaseWakeLockRef.current?.();
      clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const goneScreen = (
    <NoticeScreen
      testId="cust-gone"
      tone="neutral"
      icon={<ClockIcon className="size-10" />}
      title="이미 끝난 상담 링크예요"
    >
      다시 도움이 필요하면
      <br />
      기사님께 새 링크를 보내 달라고 말씀해 주세요.
    </NoticeScreen>
  );

  if (phase === "gone") return goneScreen;

  if (phase === "denied") return <CameraHelp failure={failure} onRetry={start} />;

  if (phase === "call") {
    if (callState === "ended") {
      return (
        <NoticeScreen
          testId="cust-ended"
          tone="success"
          icon={<CheckCircleIcon className="size-10" />}
          title="상담이 끝났어요"
          actions={
            endedByMe && (
              <Button
                variant="secondary"
                size="l"
                block
                onClick={restart}
                icon={<RefreshIcon className="size-5" />}
              >
                잘못 눌렀어요 · 다시 연결
              </Button>
            )
          }
        >
          이용해 주셔서 감사합니다.
          <br />
          이제 이 화면을 닫으셔도 돼요.
        </NoticeScreen>
      );
    }

    // 같은 링크를 다른 폰(또는 다른 창)에서 열어 그쪽이 이어받았다 (BUG-04)
    if (callState === "replaced") {
      return (
        <NoticeScreen
          testId="cust-replaced"
          tone="neutral"
          icon={<PhoneIcon className="size-10" />}
          title="다른 곳에서 연결했어요"
          actions={
            <Button size="xl" block onClick={restart}>
              이 폰으로 연결
            </Button>
          }
        >
          같은 링크를 다른 폰이나 창에서 열었어요.
          <br />이 폰으로 계속하려면 아래를 눌러 주세요.
        </NoticeScreen>
      );
    }

    // 채널 권한 거부 = 링크를 연 뒤 세션이 닫혔거나 만료됐다
    if (callState === "denied") return goneScreen;

    if (callState === "failed") {
      return (
        <NoticeScreen
          testId="cust-failed"
          tone="warning"
          icon={<WifiOffIcon className="size-10" />}
          title="연결이 끊겼어요"
          actions={
            <Button size="xl" block onClick={restart} icon={<RefreshIcon className="size-6" />}>
              다시 연결
            </Button>
          }
        >
          와이파이나 데이터가 켜져 있는지 보고
          <br />
          아래 버튼을 눌러 주세요.
        </NoticeScreen>
      );
    }

    // 방향 지시가 떠 있는 동안은 그것만 보여 준다: AR 핀·화살표·카드와 상태 문구를 잠시 숨김 (추적은 계속)
    const guideShown = !frozen && guideView !== null;
    const connected = callState === "connected";
    const statusText =
      anchorBanner === "pin" && !frozen
        ? "빨간 동그라미를 봐주세요"
        : frozen
        ? "기사님이 화면을 멈추고 설명 중이에요"
        : connected
        ? "기사님이 보고 있어요"
        : callState === "connecting"
          ? "기사님과 연결하는 중…"
          : "기사님을 기다리는 중…";
    const hideStatus = anchorBanner === "card" || anchorBanner === "arrow" || guideShown;
    const hint = connected
      ? null
      : longWait
        ? "오래 걸리면 기사님께 전화로 “카메라 켰어요”라고 알려 주세요."
        : micOff
          ? "마이크 없이 연결해요. 기사님과는 전화로 이야기해 주세요."
          : "곧 연결돼요. 고장 난 곳을 미리 비춰 주세요.";

    return (
      <main className="relative flex h-dvh flex-col overflow-hidden bg-call-bg [--guide-bottom:104px]">
        <video
          ref={videoRef}
          data-testid="cust-video"
          autoPlay
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-contain"
        />
        {anchorLink && (
          <CustomerAnchorLayer
            video={videoRef}
            link={anchorLink}
            hidden={!!frozen || guideShown}
            onBanner={setAnchorBanner}
          />
        )}
        {/* 잘림 없이 전체를 보여 줘야 기사님이 가리킨 곳이 항상 화면 안에 있다 */}
        {frozen ? (
          <FreezeCanvas image={frozen} strokes={strokes} lineWidth={8} />
        ) : (
          <PointerMarker marker={marker} size={88} />
        )}
        <GuideOverlay view={frozen ? null : guideView} />
        <audio ref={audioRef} autoPlay />

        <div
          className={`relative flex flex-col items-center gap-2 px-4 pt-[max(12px,env(safe-area-inset-top))] ${
            hideStatus ? "invisible" : ""
          }`}
        >
          <span
            data-testid="cust-status"
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-label-l text-gray-0 shadow-float ${
              frozen
                ? "bg-amber-700"
                : connected
                  ? "bg-green-600"
                  : "bg-black-80"
            }`}
          >
            {connected || frozen ? (
              <span aria-hidden="true" className="size-2.5 rounded-full bg-gray-0" />
            ) : (
              <Spinner className="size-4" />
            )}
            {statusText}
          </span>
          {hint && (
            <p className="max-w-xs rounded-2xl bg-black-50 px-4 py-2 text-center text-body-m text-call-text">
              {hint}
            </p>
          )}
        </div>

        {notice && (
          <div
            role="status"
            className="relative mx-6 mt-6 animate-[sheet-up_0.2s_ease-out] rounded-3xl bg-black-80 px-5 py-5 text-center text-title-m text-gray-0 shadow-float"
          >
            {notice}
          </div>
        )}

        {flipRequested && (
          <div className="relative mx-5 mt-6 flex flex-col items-center gap-3 rounded-3xl bg-bg-page px-5 py-5 text-center shadow-float">
            <p className="text-title-m text-text-primary">기사님이 카메라를 바꿔 달라고 하세요</p>
            <Button
              size="xl"
              block
              onClick={() => flipCamera(false)}
              icon={<FlipCameraIcon className="size-7" />}
            >
              카메라 바꾸기
            </Button>
            <Button variant="ghost" size="m" onClick={() => setFlipRequested(false)}>
              닫기
            </Button>
          </div>
        )}

        <div className="relative mt-auto grid grid-cols-2 gap-3 bg-gradient-to-t from-black-80 to-transparent px-4 pt-12 pb-[max(20px,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => flipCamera(false)}
            className="flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-2xl bg-call-control/90 text-label-l text-call-text active:bg-call-control-pressed"
          >
            <FlipCameraIcon className="size-7" />
            카메라 바꾸기
          </button>
          <button
            type="button"
            onClick={askEnd}
            className="flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-2xl bg-danger text-label-l text-on-primary active:bg-danger-pressed"
          >
            <PhoneOffIcon className="size-7" />
            끝내기
          </button>
        </div>

        <Sheet
          open={confirmEnd}
          onClose={() => setConfirmEnd(false)}
          title="상담을 끝낼까요?"
          description="기사님과 연결이 끊어져요."
          testId="cust-end-sheet"
        >
          <Button variant="danger" size="xl" block onClick={hangup}>
            네, 끝낼게요
          </Button>
          <Button variant="secondary" size="xl" block onClick={() => setConfirmEnd(false)}>
            아니요, 계속할게요
          </Button>
        </Sheet>
      </main>
    );
  }

  return <StartScreen starting={phase === "starting"} onStart={start} />;
}
