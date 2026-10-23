"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallQuality, type CallState } from "@/lib/webrtc/call";
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
import { capturePhoto, servePhotos } from "@/lib/webrtc/photo";
import {
  setTorch,
  switchCamera,
  torchSupported,
  type CameraState,
  type Facing,
} from "@/lib/webrtc/camera";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { CallControl } from "@/components/ui/call-control";
import { Sheet } from "@/components/ui/sheet";
import { NoticeScreen } from "@/components/ui/notice-screen";
import {
  CameraIcon,
  CheckCircleIcon,
  ClockIcon,
  FlipCameraIcon,
  FreezeIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  RefreshIcon,
  Spinner,
  UserIcon,
  WifiOffIcon,
} from "@/components/ui/icons";
import { formatDuration } from "@/lib/format";
import { CallTimer } from "@/components/ui/call-timer";
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
  engineerName = null,
  connectedBefore = false,
}: {
  roomId: string;
  token: string;
  /** 기다리고 있는 기사님 이름 (엔지니어 계정의 표시 이름, OPS-03). 없으면 '기사님' */
  engineerName?: string | null;
  /** 이 상담이 전에 기사님과 연결된 적 있는지(rooms.status '연결됨'). 링크를 다시 열어 들어온 경우 — 끝내면 상담이 닫히므로 '링크를 다시 누르면 된다'고 하면 안 된다 (JOIN-08) */
  connectedBefore?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [failure, setFailure] = useState<CameraFailure>("blocked");
  // 카메라를 못 켠 횟수. 두 번째부터는 안내 화면이 '아직 막혀 있어요'를 보인다 (JOIN-05)
  const [deniedCount, setDeniedCount] = useState(0);
  const [callState, setCallState] = useState<CallState>("waiting");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const confirmShownAtRef = useRef(0);
  // 전화 통화 중 등으로 마이크를 못 써 카메라만 연결했다 (JOIN-04)
  const [micOff, setMicOff] = useState(false);
  const [longWait, setLongWait] = useState(false);
  // 연결된 뒤 잠깐 끊김 (피그마 C10) · 기사님과 처음 연결된 시각(끝난 화면의 '12분 통화했어요')
  const [quality, setQuality] = useState<CallQuality>("good");
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  // 이 화면에서 기사님과 한 번이라도 연결됐는지. '다시 연결'·'이 폰으로 연결'(restart)로도 지워지지 않는다 —
  // 연결된 적 있는 상담은 사장님이 끝내면 기사님 화면이 상담을 닫으므로(ROOM-10), 그 뒤 '링크를 다시 누르면 된다'고 하면 안 된다
  const [everConnected, setEverConnected] = useState(connectedBefore);
  const [talkSec, setTalkSec] = useState<number | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  // 통화 콜백은 시작 시점 값을 기억하므로 지금 카메라 상태는 ref로 읽는다
  const facingRef = useRef<Facing>("environment");
  const torchRef = useRef(false);
  const flippingRef = useRef(false);
  // 기사님이 원격으로 바꿨을 때·연결됐을 때 잠깐 보이는 안내 (CALL-10, CALL-11)
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 마이크 없이 연결된 순간 몇 초 보이는 '마이크가 꺼져 있어요' 띠 (JOIN-04)
  const [micNote, setMicNote] = useState(false);
  const micNoteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 이 화면에서 사장님이 직접 '끝내기'를 눌렀는지. 기사님이 상담을 닫아 끝난 것(bye)과 끝난 화면이 다르다 (JOIN-08)
  const selfEndedRef = useRef(false);
  // 폰이 탭 없이는 카메라를 못 바꿀 때: '바꾸기' 버튼을 띄운다
  const [flipRequested, setFlipRequested] = useState(false);
  // 카메라 전환이 끝까지 실패해 영상이 꺼졌다 (JOIN-07·CALL-10). 탭 안에서 다시 켠다
  const [cameraLost, setCameraLost] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenFailed, setReopenFailed] = useState(false);
  // 통화 세대: 시작·다시 연결·끝·화면을 떠날 때마다 올린다. 카메라 열기·연결 준비를 기다리는(await) 사이에
  // 통화가 끝났거나 새로 시작됐으면, 늦게 도착한 카메라는 끄고 손을 뗀다 (켜진 채 남지 않게)
  const liveGenRef = useRef(0);

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
  // 기사님이 방향 링을 누르고 있는 동안의 방향 지시 (CALL-15, 전용 채널 'guide')
  const [guideLink, setGuideLink] = useState<DataLink | null>(null);
  // 사진 요청 받기 해제 (CALL-16)
  const stopPhotosRef = useRef<(() => void) | null>(null);
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

  // 통화 중 카메라가 스스로 꺼지면(다른 앱이 카메라를 가져감, 전화 수신 등) 전환 실패 때와 같은 '카메라가 꺼졌어요' 창을
  // 띄우고 기사님에게도 알린다 (JOIN-07·CALL-10). 우리가 track.stop()으로 끈 것은 ended가 오지 않는다
  function watchCameraEnd(stream: MediaStream) {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const gen = liveGenRef.current;
    track.onended = () => {
      if (gen !== liveGenRef.current || streamRef.current !== stream) return;
      setReopenFailed(false);
      setCameraLost(true);
      reportCamera("lost");
    };
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

  // again: 끊긴 뒤·다른 폰에 넘어간 뒤 다시 연결(JOIN-09·11). 권한은 이미 받았으니 시작 화면('허용' 안내)을 거치지 않는다
  async function start(again = false) {
    liveGenRef.current += 1;
    const gen = liveGenRef.current;
    if (!again) setPhase("starting");
    // 폰을 비추기만 하고 화면을 안 건드려서 자동 잠금으로 끊기기 쉽다 — 버튼 탭 안에서 요청
    releaseWakeLock();
    releaseWakeLockRef.current = keepScreenOn();
    const opened = await openCamera();
    if (gen !== liveGenRef.current) {
      // 그사이 화면을 떠났거나 끝냈다 — 방금 켠 카메라는 아무도 모르니 여기서 끈다
      if ("stream" in opened) opened.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    if ("error" in opened) {
      postEvent("camera_denied", { reason: opened.error });
      releaseWakeLock();
      setFailure(cameraFailureOf(opened.error));
      setDeniedCount((n) => n + 1);
      setPhase("denied");
      return;
    }
    streamRef.current = opened.stream;
    watchCameraEnd(opened.stream);
    setDeniedCount(0);
    setMicOff(!opened.mic);
    postEvent("camera_granted", { mic: opened.mic });
    // 카메라가 켜졌으면 '허용' 안내를 바로 내리고 내 카메라와 '기다리는 중'을 먼저 보여 준다.
    // 연결 준비(TURN 조회)는 그 뒤에 한다 — 느린 망에서 몇 초 걸려도 어두운 화면에 '허용'을 누르라고 남지 않게 (JOIN-02·04)
    lastStateRef.current = "waiting";
    setCallState("waiting");
    setPhase("call");
    if (videoRef.current) videoRef.current.srcObject = opened.stream;

    const ice = await fetchIceServers(token);
    // 그사이 '통화 종료'를 눌렀거나 화면을 떠났다. 카메라는 그쪽에서 이미 껐다
    if (gen !== liveGenRef.current) return;
    // 링크를 연 뒤 세션이 닫혔거나 만료됐다 — 종료 알림(bye)은 채널에 들어오기 전이라 받지 못했다
    if (ice.roomGone) {
      liveGenRef.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      releaseWakeLock();
      setPhase("gone");
      return;
    }
    const session = new CallSession({
      roomId,
      role: "customer",
      iceServers: ice.iceServers,
      clockOffsetMs: ice.clockOffsetMs,
      // 기다리는 동안 고객이 카메라를 바꿨을 수 있다 — 지금 카메라로
      localStream: streamRef.current,
      onState: (s) => {
        const prev = lastStateRef.current;
        lastStateRef.current = s;
        setCallState(s);
        if (s !== "connected") {
          setFrozen(null);
          setStrokes([]);
          resetGuide();
          setQuality("good");
        }
        if (s === "connected") {
          if (connectedAtRef.current === null) connectedAtRef.current = Date.now();
          setConnectedAt(connectedAtRef.current);
          setEverConnected(true);
          reportCamera();
          if (prev !== "connected") {
            showNotice("기사님과 연결됐어요");
            // 마이크 없이 연결했으면(전화 통화 중 등, JOIN-04) 말은 전화로 하라고 한 번 더 — 기다림 카드의 안내는 연결되면 사라지므로
            if (!opened.mic) {
              setMicNote(true);
              clearTimeout(micNoteTimerRef.current);
              micNoteTimerRef.current = setTimeout(() => setMicNote(false), 5000);
            }
          }
          // relay(TURN) 경유 여부 — 원가 지표. turn: TURN 자격증명을 받았는지
          setTimeout(async () => {
            const relay = (await sessionRef.current?.usedRelay()) ?? false;
            postEvent("connected", { relay, turn: !ice.turnError });
            if (relay) postEvent("relay_used");
          }, 1000);
        }
        if (s === "ended" || s === "failed" || s === "denied" || s === "replaced") {
          // 바꾸던 카메라가 늦게 열려도 켜진 채 남지 않게
          liveGenRef.current += 1;
          streamRef.current?.getTracks().forEach((t) => t.stop());
          releaseWakeLock();
          setConfirmEnd(false);
          if (s === "ended") endTalk();
        }
      },
      onQuality: (q) => {
        setQuality(q);
        // 끊긴 동안 떠 있던 화살표는 지운다 — 다시 붙으면 기사님이 새로 누른다 (피그마 C10)
        if (q === "unstable") resetGuide();
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
    // 기사님이 사진을 찍으면 이 폰 카메라로 원본을 찍어 보낸다 (CALL-16). 몰래 찍히지 않게 화면에 알린다
    stopPhotosRef.current?.();
    stopPhotosRef.current = servePhotos(
      session.photoLink,
      () => capturePhoto(videoRef.current, streamRef.current?.getVideoTracks()[0] ?? null),
      () => showNotice("기사님이 사진을 찍었어요"),
    );
    session.join();
  }

  // 끝난 화면에 보여 줄 통화 시간
  function endTalk() {
    const at = connectedAtRef.current;
    setTalkSec(at === null ? null : (Date.now() - at) / 1000);
  }

  // 끊긴 뒤·다른 곳에 넘어간 뒤 다시 연결. 새로고침 없이 이 탭 안에서 카메라부터 다시 연다 (JOIN-09·11).
  // 시작 화면으로 돌아가지 않고 통화 화면('기사님을 기다리는 중…')에서 다시 붙는다. 세대는 start가 올린다
  function restart() {
    stopPhotosRef.current?.();
    stopPhotosRef.current = null;
    sessionRef.current?.destroy();
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    remoteStreamRef.current = null;
    lastStateRef.current = "waiting";
    connectedAtRef.current = null;
    selfEndedRef.current = false;
    setConnectedAt(null);
    setQuality("good");
    facingRef.current = "environment";
    torchRef.current = false;
    setCallState("waiting");
    setConfirmEnd(false);
    setFlipRequested(false);
    setCameraLost(false);
    setReopenFailed(false);
    setNotice(null);
    setFrozen(null);
    setStrokes([]);
    setAnchorLink(null);
    setAnchorBanner(null);
    setGuideLink(null);
    resetGuide();
    start(true);
  }

  // 카메라 전/후면 전환 (replaceTrack — 재협상 불필요). byEngineer: 기사님이 원격으로 요청
  async function flipCamera(byEngineer: boolean) {
    const current = streamRef.current;
    if (!current || flippingRef.current) return;
    const gen = liveGenRef.current;
    // 바꾸는 사이 통화가 끝났거나 다시 시작됐다 — 새로 연 카메라는 아무도 끄지 않으니 여기서 끈다
    const stale = (r: { stream: MediaStream | null }) => {
      if (gen === liveGenRef.current) return false;
      if (r.stream && r.stream !== current) r.stream.getVideoTracks().forEach((t) => t.stop());
      return true;
    };
    flippingRef.current = true;
    try {
      const r = await switchCamera(current, facingRef.current);
      if (stale(r)) return;
      if (r.stream && r.stream !== current) {
        // 지금 카메라를 먼저 바꿔 둔다 — 연결 준비 중이면 곧 만들 통화가 이 카메라로 시작한다
        streamRef.current = r.stream;
        watchCameraEnd(r.stream);
        if (videoRef.current) videoRef.current.srcObject = r.stream;
        torchRef.current = false; // 새 카메라는 손전등이 꺼진 상태
        setCameraLost(false);
        await sessionRef.current?.replaceVideoTrack(r.stream.getVideoTracks()[0]);
        if (stale(r)) return;
      }
      facingRef.current = r.facing;
      if (!r.stream) {
        // 바꾸지도, 원래 카메라를 다시 켜지도 못했다 — 영상이 꺼진 채다. 고객에게 다시 켜는 버튼을 띄운다
        setReopenFailed(false);
        setCameraLost(true);
        reportCamera("lost");
        return;
      }
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

  // '카메라 다시 켜기' (카메라가 꺼졌을 때). 고객의 탭 안에서 부르므로 탭이 있어야 카메라를 여는 폰(아이폰 등)에서도 열린다
  async function reopenCamera() {
    if (flippingRef.current) return;
    const gen = liveGenRef.current;
    flippingRef.current = true;
    setReopening(true);
    try {
      let track: MediaStreamTrack;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingRef.current } });
        track = s.getVideoTracks()[0];
      } catch {
        if (gen !== liveGenRef.current) return;
        setReopenFailed(true);
        reportCamera("lost");
        return;
      }
      if (gen !== liveGenRef.current) {
        track.stop();
        return;
      }
      // 마이크는 그대로 두고 영상만 새 카메라로
      const next = new MediaStream([track, ...(streamRef.current?.getAudioTracks() ?? [])]);
      streamRef.current = next;
      watchCameraEnd(next);
      if (videoRef.current) videoRef.current.srcObject = next;
      torchRef.current = false;
      setCameraLost(false);
      setReopenFailed(false);
      setFlipRequested(false);
      await sessionRef.current?.replaceVideoTrack(track);
      if (gen !== liveGenRef.current) {
        track.stop();
        return;
      }
      reportCamera();
    } finally {
      flippingRef.current = false;
      setReopening(false);
    }
  }

  function askEnd() {
    confirmShownAtRef.current = Date.now();
    setConfirmEnd(true);
  }

  // 끝내기 (JOIN-08): 기사님께 알린다(bye). 기사님과 연결된 적 있으면 기사님 화면이 상담도 닫아 같은 링크로는 다시 못 들어온다.
  // 연결되기 전에 눌렀으면 상담은 그대로라 링크를 다시 열면 된다
  function hangup() {
    if (Date.now() - confirmShownAtRef.current < CONFIRM_ARM_MS) return;
    selfEndedRef.current = true;
    // 바꾸던 카메라·연결 준비가 늦게 끝나도 카메라를 다시 켜지 않게
    liveGenRef.current += 1;
    sessionRef.current?.hangup();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    releaseWakeLock();
    setConfirmEnd(false);
    setCameraLost(false);
    endTalk();
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
      liveGenRef.current += 1;
      stopPhotosRef.current?.();
      sessionRef.current?.destroy();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      releaseWakeLockRef.current?.();
      clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const engineerLabel = engineerName ? `${engineerName} 기사님` : "기사님";

  // 채널 권한 거부·링크를 연 뒤 닫힌 세션 (JOIN-03, 피그마 C06)
  const goneScreen = (
    <NoticeScreen
      testId="cust-gone"
      tone="neutral"
      icon={<ClockIcon className="size-10" />}
      title="상담이 이미 끝났어요"
    >
      도움이 더 필요하시면
      <br />
      기사님께 새 링크를 받아 주세요.
    </NoticeScreen>
  );

  if (phase === "gone") return goneScreen;

  // start(again)에 클릭 이벤트가 들어가지 않게 감싼다
  if (phase === "denied") return <CameraHelp failure={failure} retried={deniedCount > 1} onRetry={() => start()} />;

  if (phase === "call") {
    if (callState === "ended") {
      // 기사님과 연결되기 전에 사장님이 '끝내기'를 눌렀다: 상담은 그대로 열려 있고 카메라만 껐다 (JOIN-08, ROOM-10).
      // '상담이 끝났어요'라고 하면 사장님은 끝난 줄 알고, 기사님은 전화로 다시 눌러 달라고 해야 한다.
      // 기사님이 연결 전에 상담을 닫은 것(bye)은 다르다 — 링크가 죽었으니 아래 '상담이 끝났어요'.
      // '다시 연결' 뒤 연결 전에 끝낸 것도 다르다 — 연결된 적 있는 상담이라 기사님 화면이 상담을 닫는다
      if (selfEndedRef.current && !everConnected) {
        return (
          <NoticeScreen
            testId="cust-ended"
            tone="neutral"
            icon={<CameraIcon className="size-10" />}
            title="카메라를 껐어요"
          >
            다시 하시려면 문자나 카톡으로 받으신
            <br />
            링크를 눌러 주세요.
          </NoticeScreen>
        );
      }
      // 피그마 C19: 더 누를 것이 없음. 브라우저 창은 코드로 닫을 수 없어서 '닫아도 돼요'로 안내
      return (
        <NoticeScreen
          testId="cust-ended"
          tone="success"
          icon={<CheckCircleIcon className="size-10" />}
          title="상담이 끝났어요"
        >
          {talkSec !== null && talkSec >= 1 && (
            <>
              {engineerLabel}과 {formatDuration(talkSec)} 통화했어요.
              <br />
            </>
          )}
          이 창은 닫으셔도 돼요.
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
          title="다른 폰에서 연결됐어요"
          actions={
            <Button size="xl" block onClick={restart}>
              이 폰으로 연결
            </Button>
          }
        >
          같은 링크가 다른 폰이나 창에서 열렸어요.
          <br />이 폰으로 계속하시려면 &lsquo;이 폰으로 연결&rsquo;을 눌러 주세요.
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
          와이파이나 데이터가 켜져 있는지 보시고
          <br />
          &lsquo;다시 연결&rsquo;을 눌러 주세요.
        </NoticeScreen>
      );
    }

    // 방향 지시가 떠 있는 동안은 그것만 보여 준다: AR 핀·화살표·카드와 위쪽 바를 잠시 숨김 (추적은 계속)
    const guideShown = !frozen && guideView !== null;
    const connected = callState === "connected";
    const unstable = connected && quality === "unstable";
    // 기사님과 통화하다가 기사님 쪽이 사라져 다시 기다리는 중 (기사님 폰이 꺼짐·탭이 닫힘·기기를 바꾸는 중, CALL-05).
    // 처음 기다릴 때와 같은 '카메라 켰다고 알려 주세요'는 방금까지 통화한 사장님에게 맞지 않는다.
    // 기사님이 돌아와 다시 잇는 중(connecting)에는 '다시 들어오면 이어져요'가 맞지 않으므로 기다리는 동안만
    const rejoining = callState === "waiting" && everConnected;
    // 기사님을 기다리는 동안(나갔다 다시 오는 중 포함)은 핀 안내를 띄우지 않는다 — '기다리는 중' 카드와 엇갈리지 않게
    const statusText =
      connected && anchorBanner === "pin" && !frozen
        ? "빨간 동그라미를 봐 주세요"
        : frozen
        ? "화면을 멈추고 설명하고 있어요"
        : connected
        ? "기사님이 보고 있어요"
        : callState === "connecting"
          ? "기사님과 연결하는 중…"
          : rejoining
            ? "기사님을 다시 기다리는 중…"
            : "기사님을 기다리는 중…";
    const hideTop = anchorBanner === "card" || anchorBanner === "arrow" || guideShown;
    const waitHint = rejoining
      ? "기사님이 다시 들어오면 바로 이어져요. 오래 걸리면 기사님께 전화해 보세요."
      : longWait
        ? "오래 걸리면 기사님께 전화로 “카메라 켰어요”라고 알려 주세요."
        : micOff
          ? "마이크 없이 연결할게요. 말씀은 전화로 나눠 주세요."
          : "카메라는 이미 켜졌어요. 고장 난 곳을 미리 비춰 주세요.";

    return (
      <main className="relative flex h-dvh flex-col overflow-hidden bg-call-bg [--guide-bottom:120px]">
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
            hidden={!!frozen || guideShown || !connected}
            onBanner={setAnchorBanner}
          />
        )}
        {/* 잘림 없이 전체를 보여 줘야 기사님이 가리킨 곳이 항상 화면 안에 있다 */}
        {frozen ? (
          <FreezeCanvas image={frozen} strokes={strokes} lineWidth={8} />
        ) : (
          <PointerMarker marker={marker} size={88} />
        )}
        <GuideOverlay view={frozen || unstable ? null : guideView} />
        <audio ref={audioRef} autoPlay />

        {/* 위쪽 바 (피그마 C07): 누구와 통화 중인지 + 지금 상태 */}
        <div
          className={`relative flex items-center gap-3 bg-gradient-to-b from-black-80 to-transparent px-4 pt-[max(12px,env(safe-area-inset-top))] pb-6 ${
            hideTop ? "invisible" : ""
          }`}
        >
          <span className="grid size-11 flex-none place-items-center rounded-full bg-call-control text-call-icon">
            <UserIcon className="size-[22px]" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-title-s text-call-text">{engineerLabel}</span>
            <span className="flex items-center gap-1.5 text-label-l text-call-text">
              {connected || frozen ? (
                <span aria-hidden="true" className={`size-2.5 flex-none rounded-full ${unstable ? "bg-warning" : "bg-success"}`} />
              ) : (
                <Spinner className="size-4 flex-none" />
              )}
              <span data-testid="cust-status">{statusText}</span>
              {connected && connectedAt && !frozen && (
                <span className="font-normal text-call-text-secondary">
                  · <CallTimer since={connectedAt} />
                </span>
              )}
            </span>
          </div>
        </div>

        <div className="relative mx-4 flex flex-col gap-3">
          {/* 피그마 C10: 잠깐 끊김 */}
          {unstable && (
            <Banner tone="warning" role="status" size="l" sub="창을 닫지 말고 기다려 주세요">
              연결이 잠깐 끊겼어요
            </Banner>
          )}
          {micNote && !unstable && (
            <Banner tone="info" role="status" size="l" icon={<MicOffIcon className="size-6" />} sub="말씀은 전화로 나눠 주세요">
              마이크가 꺼져 있어요
            </Banner>
          )}
          {/* 피그마 C09: 멈춘 동안은 폰을 내려놔도 된다 — 팔 떨림을 없앤다 */}
          {frozen && !unstable && (
            <Banner tone="info" role="status" size="l" icon={<FreezeIcon className="size-6" />} sub="폰을 내려놓으셔도 돼요">
              기사님이 화면을 멈췄어요
            </Banner>
          )}
          {notice && (
            <div
              role="status"
              className="animate-[sheet-up_0.2s_ease-out] rounded-3xl bg-black-80 px-5 py-5 text-center text-title-m text-gray-0 shadow-float"
            >
              {notice}
            </div>
          )}
        </div>

        {/* 피그마 C03: 기다리는 동안 가운데 카드 — 카메라는 켜졌다는 것을 알린다 */}
        {(!connected || unstable) && !notice && (
          <div className="pointer-events-none absolute inset-x-6 top-1/2 flex -translate-y-1/2 justify-center">
            <div className="flex max-w-xs flex-col items-center gap-3 rounded-2xl bg-black-80 px-6 py-5 text-center shadow-float">
              <Spinner className="size-7 text-call-text" />
              <p className="text-title-s text-call-text">
                {unstable
                  ? "다시 연결하는 중…"
                  : callState === "connecting"
                    ? "기사님과 연결하는 중…"
                    : rejoining
                      ? "기사님을 다시 기다리는 중…"
                      : "기사님을 기다리는 중…"}
              </p>
              {!unstable && <p className="text-body-l text-call-text-secondary">{waitHint}</p>}
            </div>
          </div>
        )}

        {/* 아래 (피그마 C07): 카메라 전환 + 통화 종료. 고객 쪽 버튼은 모두 크게 */}
        <div className="relative mt-auto flex items-end gap-4 bg-gradient-to-t from-black-80 to-transparent px-4 pt-12 pb-[max(20px,env(safe-area-inset-bottom))]">
          <CallControl size="xl" icon={<FlipCameraIcon />} label="카메라 바꾸기" onClick={() => flipCamera(false)} />
          <Button
            variant="call-danger"
            size="xl"
            onClick={askEnd}
            className="mb-7 flex-1"
            icon={<PhoneOffIcon className="size-6" />}
          >
            통화 종료
          </Button>
        </div>

        {/* 폰이 탭 없이는 카메라를 못 바꿀 때(CALL-10): 엄지가 닿는 아래쪽에서 올라오는 창으로 묻는다 */}
        <Sheet
          open={flipRequested && !cameraLost}
          onClose={() => setFlipRequested(false)}
          title="기사님이 카메라를 바꿔 달라고 하셨어요"
          testId="cust-flip-sheet"
          size="l"
        >
          <Button size="xl" block onClick={() => flipCamera(false)} icon={<FlipCameraIcon className="size-6" />}>
            카메라 바꾸기
          </Button>
          <Button variant="secondary" size="xl" block onClick={() => setFlipRequested(false)}>
            닫기
          </Button>
        </Sheet>

        {/* 카메라 전환이 끝까지 실패해 영상이 꺼졌다 (JOIN-07·CALL-10). 답을 받아야 해서 바깥을 눌러도 닫히지 않는다 */}
        <Sheet
          open={cameraLost}
          title="카메라가 꺼졌어요"
          description={
            reopenFailed ? (
              <>
                카메라를 켜지 못했어요.
                <br />
                &lsquo;카메라 다시 켜기&rsquo;를 한 번 더 눌러 주세요.
              </>
            ) : (
              "‘카메라 다시 켜기’를 눌러 주세요."
            )
          }
          testId="cust-camera-lost"
          size="l"
        >
          <Button size="xl" block loading={reopening} onClick={reopenCamera} icon={<CameraIcon className="size-6" />}>
            카메라 다시 켜기
          </Button>
          <Button variant="secondary" size="xl" block onClick={askEnd}>
            통화 종료
          </Button>
        </Sheet>

        {/* 피그마 C18: 실수로 누르는 일을 막는 확인 한 번. 고객 쪽 버튼은 모두 XL.
            카메라가 꺼졌다는 창에서 '통화 종료'를 눌러도 이 창이 위에 뜨도록 뒤에 둔다 */}
        <Sheet
          open={confirmEnd}
          onClose={() => setConfirmEnd(false)}
          // 한 번도 연결되기 전에는 끊길 연결이 없다. 끝내도 링크를 다시 누르면 들어올 수 있다는 것을 미리 말한다 (JOIN-08).
          // 연결된 적 있는데 지금은 끊겨 있으면(기사님이 나감, '다시 연결' 중) 기사님이 돌아와도 이어지지 않는다는 것을 말한다.
          // 링크가 다시 열릴지는 기사님이 상담을 닫는지에 달려 있어 약속하지 않는다
          title={everConnected ? "상담을 끝낼까요?" : "아직 기사님과 연결되지 않았어요"}
          description={
            !everConnected
              ? "지금 끝내도 문자나 카톡 속 링크를 다시 누르면 들어올 수 있어요."
              : connected
                ? "기사님과 연결이 끊겨요."
                : "기사님이 돌아와도 이어지지 않아요. 도움이 더 필요하시면 기사님께 전화해 주세요."
          }
          testId="cust-end-sheet"
          size="l"
        >
          <Button variant="danger" size="xl" block onClick={hangup}>
            끝내기
          </Button>
          <Button
            variant="secondary"
            size="xl"
            block
            onClick={() => {
              // 뜬 직후의 탭은 무시한다 — '통화 종료'를 두 번 누른 두 번째 탭이 바로 창을 닫지 않게 (JOIN-08)
              if (Date.now() - confirmShownAtRef.current < CONFIRM_ARM_MS) return;
              setConfirmEnd(false);
            }}
          >
            계속하기
          </Button>
        </Sheet>
      </main>
    );
  }

  return <StartScreen starting={phase === "starting"} onStart={() => start()} engineerName={engineerName} />;
}
