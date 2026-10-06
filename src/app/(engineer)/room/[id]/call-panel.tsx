"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CallSession, sendBye, type CallQuality, type CallState } from "@/lib/webrtc/call";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { toVideoPos } from "@/lib/webrtc/pointer";
import {
  applyDrawCommand,
  captureFrame,
  type Point,
  type Stroke,
} from "@/lib/webrtc/draw";
import { keepScreenOn } from "@/lib/wake-lock";
import { takeMicAhead } from "@/lib/webrtc/mic-ahead";
import { PhotoRequester } from "@/lib/webrtc/photo";
import type { TakenPhoto } from "@/lib/photo-save";
import type { CameraState } from "@/lib/webrtc/camera";
import type { GuideCmd, GuideMsg } from "@/lib/webrtc/guide";
import { PointerMarker, usePointerMarker } from "@/components/pointer-marker";
import { FreezeCanvas, type DrawHandlers } from "@/components/freeze-canvas";
import {
  EngineerAnchorLayer,
  type EngineerAnchorApi,
} from "@/components/anchor/engineer-anchor";
import { LongPressRing } from "@/components/anchor/long-press-ring";
import { GuideDpad } from "@/components/guide-dpad";
import { GuidePill } from "@/components/guide-pill";
import { Banner } from "@/components/ui/banner";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Brand } from "@/components/ui/brand";
import { Button } from "@/components/ui/button";
import { CallControl } from "@/components/ui/call-control";
import { Sheet } from "@/components/ui/sheet";
import { NoticeScreen } from "@/components/ui/notice-screen";
import {
  AlertIcon,
  CameraIcon,
  EraserIcon,
  FlashlightIcon,
  FlipCameraIcon,
  FreezeIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  PlayIcon,
  Spinner,
  UndoIcon,
} from "@/components/ui/icons";
import {
  endRoom,
  getJoinProgress,
  logToolUsed,
  markRoomActive,
  type EndRoomResult,
  type JoinProgress,
} from "./actions";
import type { SentVia } from "./share-buttons";
import { AppBar, AppBarAction, CallTimer, QualityPill, ShortcutsBox } from "./call-ui";
import type { KakaoShareArgs } from "@/lib/kakao-webhook";
import { WaitingView } from "./waiting-view";
import { PhotoSaveView, SavePhotosFirst } from "./photo-save-view";

// 누가 통화를 끝냈는지. null = 고객과 연결된 적 없이 닫음
type Closer = "engineer" | "customer" | null;

type PanelState =
  | { phase: "idle" }
  | { phase: "call"; call: CallState; peerPresent: boolean }
  // 상담을 닫는 중(endRoom). 실패하면 이 화면에서 다시 시도한다. 통화로는 돌아가지 않는다
  | { phase: "closing"; by: Closer }
  // 상담을 닫은 뒤 통화 중 찍은 사진을 저장할지 묻는다(CALL-16). relogin: 로그인이 풀려 닫지 못했다
  | { phase: "photos"; by: Closer; relogin: boolean }
  // 고객이 끝내서 상담을 닫았다(찍은 사진 없음)
  | { phase: "ended" };

// 끝내기 확인 창: end = 통화를 끝낼까요?(E10, 연결된 적 있음), close = 연결 없이 닫기
type EndSheetKind = "end" | "close" | null;

// 확인 창이 뜬 직후의 탭은 무시한다. 종료 버튼을 두 번 누르면 두 번째 탭이 같은 자리에 뜬 버튼에 떨어진다
const CONFIRM_ARM_MS = 600;

// 길게 누르기(AR 핀, CALL-14) 판정: 이 시간 이상 누르고, 그동안 손가락이 이 거리 안에 있으면 핀.
// 그보다 짧게 떼면 레이저 포인터(CALL-08). 움직이면 둘 다 아님(스크롤·실수 방지)
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 12;

// 고객 진행 상황(ROOM-13)을 묻는 간격
const PROGRESS_POLL_MS = 3000;

// 세션 없이 보내는 종료 알림(REST)을 상담을 닫기 전에 기다리는 최대 시간
const BYE_WAIT_MS = 3000;

// 닫는 중 화면. 연결된 적 있는 상담은 '끝내기', 연결 없이 닫는 상담은 '닫기' (확인 창 버튼과 같은 말)
const CLOSING_TEXT = {
  end: { busy: "상담을 끝내는 중이에요", failed: "상담을 끝내지 못했어요", retry: "다시 끝내기" },
  close: { busy: "상담을 닫는 중이에요", failed: "상담을 닫지 못했어요", retry: "다시 닫기" },
} as const;

// 방향키 등 텍스트 입력 중인지 (F 단축키가 입력을 가로채지 않게)
function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// 엔지니어 세션 화면 (피그마 E03~E10·P01, ROOM-05·10·13, CALL-01·04).
//   고객 부르기(링크 보내기 → 고객 진행 상황) → 통화(어두운 전체 화면, 영상 + 방향 링·도구) → 통화를 끝낼까요? → 상담 닫힘
//   → 찍은 사진이 있으면 저장할지 묻고, 없으면 상담 목록으로
// 대시보드의 '새 A/S 시작'·'이어하기' 탭에서 마이크를 미리 받아 두면(mic-ahead) 화면이 뜨자마자 통화 대기를 시작한다.
// 폰 한 손 조작 기준: 누를 것은 아래쪽에, 크게.
export function CallPanel({
  roomId,
  joinToken,
  joinUrl,
  createdLabel,
  everConnected: initialEverConnected,
  kakaoArgs,
}: {
  roomId: string;
  // 고객 링크 토큰. TURN 자격증명 발급에 쓴다
  joinToken: string;
  // 고객에게 보낼 링크 (ROOM-06~08)
  joinUrl: string;
  // '오늘 오후 5:00' — 이 상담을 만든 시각
  createdLabel: string;
  // 이미 '연결됨'인 상담인지. 한 번도 연결 안 된 상담은 '상담 닫기'(연결 없이 닫음)
  everConnected: boolean;
  // 카톡 전송 웹훅용 서명된 상담 id (ROOM-15·16). 서버에 카카오 어드민 키가 없으면 null
  kakaoArgs: KakaoShareArgs | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const [everConnected, setEverConnected] = useState(initialEverConnected);
  const [micOn, setMicOn] = useState(false);
  const [starting, setStarting] = useState(false);
  // 대시보드에서 마이크를 미리 받아 와 스스로 시작하는 중 (버튼 없이 링크 보내기 화면을 먼저 보여 준다)
  const [autoStarting, setAutoStarting] = useState(false);
  const [sheet, setSheet] = useState<EndSheetKind>(null);
  const [saveError, setSaveError] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [turnOpen, setTurnOpen] = useState(false);
  // 처음 연결된 시각 — 통화 시간 표시
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  // 연결된 뒤 잠깐 끊김 (피그마 E09)
  const [quality, setQuality] = useState<CallQuality>("good");
  // 고객 쪽 소리가 오는지. 고객이 전화 통화 중이라 마이크 없이 카메라만 켰으면 false (JOIN-04)
  const [peerMic, setPeerMic] = useState<boolean | null>(null);
  // 처음 쓰기 전까지만 보이는 사용법 안내 (영상 제스처)
  const [gestureLearned, setGestureLearned] = useState(false);
  // 지금 고객 화면에 떠 있는 방향 지시 (피그마 GuidePill)
  const [guideCmd, setGuideCmd] = useState<GuideCmd | null>(null);
  // 방향 링을 톡 누르기만 했을 때 '고객 화면' 알약 자리에 잠깐 보여 주는 쓰는 법
  const [padHint, setPadHint] = useState<string | null>(null);
  // 링크를 어떻게 보냈는지(E03 → E04), 고객이 어디까지 왔는지 (ROOM-13)
  const [sentVia, setSentVia] = useState<SentVia | null>(null);
  const [progress, setProgress] = useState<JoinProgress | null>(null);
  // 고객 쪽 기기가 바뀐 직후 잠깐 알린다 (BUG-04: 링크가 새서 다른 사람이 들어온 경우를 알아채게)
  const [peerChanged, setPeerChanged] = useState(false);
  const peerChangedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef<CallSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  // 화면을 떠난 뒤 늦게 끝난 start()·finish()가 세션을 만들거나 화면을 옮기지 않게 한다
  const unmountedRef = useRef(false);
  // 상담을 닫기 시작했다(되돌릴 수 없다) / 닫는 요청(endRoom)이 가는 중
  const closingRef = useRef(false);
  const endingRef = useRef(false);
  // 통화 콜백은 시작 시점 값을 기억하므로 지금 값은 ref로 읽는다
  const everConnectedRef = useRef(initialEverConnected);
  const lastCallRef = useRef<CallState>("waiting");
  const confirmShownAtRef = useRef(0);
  const releaseWakeLockRef = useRef<(() => void) | null>(null);
  const toolsLoggedRef = useRef(new Set<"pointer_used" | "freeze_used" | "anchor_used" | "guide_used" | "photo_taken">());
  const connectedAtRef = useRef<number | null>(null);
  // 화면 멈춤 + 그리기 (CALL-09)
  const [frozen, setFrozen] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [freezeError, setFreezeError] = useState(false);
  const strokeRef = useRef<{ id: string; pending: Point[] } | null>(null);
  const flushFrameRef = useRef<number | null>(null);
  // 고객 카메라 원격 전환·손전등 (CALL-10, CALL-11)
  const [camState, setCamState] = useState<CameraState | null>(null);
  const [camPending, setCamPending] = useState(false);
  const camTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { marker, show: showMarker } = usePointerMarker();
  // AR 핀 (CALL-14): 연결마다 같은 전송로(anchorLink), 누르는 중인 손가락
  const [anchorLink, setAnchorLink] = useState<CallSession["anchorLink"] | null>(null);
  const anchorApiRef = useRef<EngineerAnchorApi | null>(null);
  const pressRef = useRef<{
    id: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    done: boolean;
  } | null>(null);
  const [press, setPress] = useState<{ x: number; y: number } | null>(null);
  // 방향 지시 (CALL-15): 연결마다 같은 전송로(guideLink, 전용 채널 'guide')
  const [guideLink, setGuideLink] = useState<CallSession["guideLink"] | null>(null);
  // 사진 찍기 (CALL-16): 고객 폰 원본 사진을 받아 이 기기 메모리에만 모아 두고, 끝낼 때 저장할지 묻는다
  const photoReqRef = useRef<PhotoRequester | null>(null);
  const [photos, setPhotos] = useState<TakenPhoto[]>([]);
  const photosRef = useRef<TakenPhoto[]>([]);
  // 상담을 닫지 못한 화면에서 사진을 먼저 저장했다 (닫힌 뒤 사진 저장 화면을 건너뛴다)
  const [photosSaved, setPhotosSaved] = useState(false);
  const photosSavedRef = useRef(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoNote, setPhotoNote] = useState<"taken" | "failed" | null>(null);
  const [photoFlash, setPhotoFlash] = useState(0);
  const photoNoteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      clearTimeout(camTimerRef.current);
      clearTimeout(peerChangedTimerRef.current);
      clearTimeout(photoNoteTimerRef.current);
      if (pressRef.current) clearTimeout(pressRef.current.timer);
      photoReqRef.current?.dispose();
      // 저장(다운로드)을 누르자마자 떠나도 내려받기가 끊기지 않게 사진 주소는 조금 뒤에 버린다
      const urls = photosRef.current.map((p) => p.url);
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30_000);
      sessionRef.current?.destroy();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      releaseWakeLockRef.current?.();
    };
  }, []);

  // 대시보드 탭에서 미리 받아 둔 마이크가 있으면 버튼 없이 바로 통화 대기를 시작한다 (CALL-01)
  useEffect(() => {
    const ahead = takeMicAhead(roomId);
    if (!ahead) return;
    queueMicrotask(() => {
      setAutoStarting(true);
      start(ahead);
    });
    // start는 이 화면이 처음 뜰 때 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // remote stream을 video에 연결
  useEffect(() => {
    if (
      state.phase === "call" &&
      videoRef.current &&
      remoteStreamRef.current &&
      videoRef.current.srcObject !== remoteStreamRef.current
    ) {
      videoRef.current.srcObject = remoteStreamRef.current;
    }
  });

  // 고객 진행 상황: 고객을 기다리는 동안 몇 초마다 묻는다 (링크 열림 → 카메라 허용·거부)
  const waitingForCustomer =
    (state.phase === "call" && state.call !== "connected" && !(state.call === "connecting" && state.peerPresent)) ||
    (state.phase === "idle" && autoStarting);
  useEffect(() => {
    if (!waitingForCustomer) return;
    let stopped = false;
    const poll = async () => {
      if (document.hidden) return;
      const p = await getJoinProgress(roomId).catch(() => null);
      // 받는 분(ROOM-16)을 이번에 읽지 못했으면(undefined) 하던 대로 둔다 — 이름을 적는 중인 칸이 사라지지 않게
      if (!stopped && p) setProgress((prev) => (p.recipient === undefined ? { ...p, recipient: prev?.recipient } : p));
    };
    poll();
    const id = setInterval(poll, PROGRESS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [waitingForCustomer, roomId]);

  // 마이크 요청은 반드시 탭(제스처) 이후 — 여기서 직접 누른 '연결 준비' 또는 대시보드에서 받아 둔 것(ahead)
  async function start(ahead?: { mic: Promise<MediaStream | null>; releaseWakeLock: () => void } | null) {
    if (starting || sessionRef.current) return;
    setStarting(true);
    releaseWakeLockRef.current?.();
    let mic: MediaStream | null = null;
    if (ahead) {
      releaseWakeLockRef.current = ahead.releaseWakeLock;
      mic = await ahead.mic;
    } else {
      releaseWakeLockRef.current = keepScreenOn();
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // 마이크 거부/없음 — 영상 보기만이라도 진행
      }
    }
    const ice = await fetchIceServers(joinToken);
    // 기다리는 동안 화면을 떠났거나 상담을 닫기 시작했다
    if (unmountedRef.current || closingRef.current) {
      mic?.getTracks().forEach((t) => t.stop());
      releaseWakeLockRef.current?.();
      return;
    }
    micStreamRef.current = mic;
    setMicOn(!!mic);
    setTurnError(ice.turnError);
    const session = new CallSession({
      roomId,
      role: "engineer",
      iceServers: ice.iceServers,
      clockOffsetMs: ice.clockOffsetMs,
      localStream: mic,
      onState: (state) => {
        // 연결된 적 없는데 고객이 '통화 종료'를 눌렀다(기다리다 잘못 누름 등). 아직 통화한 것이 없으니 상담은 닫지 않고
        // 다시 기다린다. 고객이 같은 링크를 다시 열면 이어진다. 엔지니어가 들어오기 전에 누른 경우(종료 알림이 아무에게도
        // 안 감)와도 결과가 같다. 그만두려는 것이었다면 엔지니어가 '상담 닫기'로 닫는다
        const call: CallState = state === "ended" && !everConnectedRef.current ? "waiting" : state;
        lastCallRef.current = call;
        // 연결이 바뀌면 고객 쪽 정지 화면도 사라지므로 이쪽도 풀어 둔다
        if (call !== "connected") {
          setFrozen(null);
          setStrokes([]);
          setCamState(null);
          setCamPending(false);
          setQuality("good");
          setGuideCmd(null);
        }
        if (call === "connected") {
          everConnectedRef.current = true;
          setEverConnected(true);
          if (connectedAtRef.current === null) connectedAtRef.current = Date.now();
          setConnectedAt(connectedAtRef.current);
          // 연결된 적 없는 상담의 '닫을까요?'는 더 맞지 않다 ('통화를 끝낼까요?'로 물어야 한다)
          setSheet((s) => (s === "close" ? null : s));
          markRoomActive(roomId);
        }
        if (call === "ended") {
          // 고객이 통화를 끝냈다 = 상담도 끝 (ROOM-10). 열린 확인 창은 닫고, 채널에서 나가 상담을 닫는다.
          // 고객이 링크를 다시 열어도 통화로 돌아오지 않는다(닫힌 상담이라 고객 화면엔 '상담이 이미 끝났어요')
          closeRoom("customer");
          return;
        }
        if (call === "denied" || call === "replaced") {
          // 채널 권한이 없거나 다른 기기가 이어받았다 — 세션은 스스로 닫혔다.
          // 마이크·화면 켜짐도 풀고, '여기서 다시 받기'로 새 세션을 열 수 있게 비운다
          sessionRef.current = null;
          micStreamRef.current?.getTracks().forEach((t) => t.stop());
          micStreamRef.current = null;
          releaseWakeLockRef.current?.();
          releaseWakeLockRef.current = null;
          setSheet(null);
        }
        // 상담을 닫기 시작한 뒤에는 통화 화면으로 돌아가지 않는다 (세션도 이미 닫혔다)
        setState((prev) =>
          prev.phase === "idle" || prev.phase === "call"
            ? { phase: "call", call, peerPresent: prev.phase === "call" ? prev.peerPresent : false }
            : prev,
        );
      },
      onQuality: setQuality,
      onCameraState: (cs) => {
        clearTimeout(camTimerRef.current);
        setCamPending(false);
        setCamState(cs);
      },
      onRemoteStream: (stream) => {
        remoteStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        const checkMic = () => setPeerMic(stream.getAudioTracks().length > 0);
        stream.onaddtrack = checkMic;
        stream.onremovetrack = checkMic;
        checkMic();
      },
      onPeerChanged: () => {
        setPeerChanged(true);
        clearTimeout(peerChangedTimerRef.current);
        peerChangedTimerRef.current = setTimeout(() => setPeerChanged(false), 8000);
      },
      onPeerPresent: (present) => {
        setState((prev) =>
          prev.phase === "call" ? { ...prev, peerPresent: present } : prev,
        );
      },
    });
    sessionRef.current = session;
    setAnchorLink(session.anchorLink);
    setGuideLink(session.guideLink);
    photoReqRef.current?.dispose();
    photoReqRef.current = new PhotoRequester(session.photoLink);
    session.join();
    setState((prev) => (prev.phase === "idle" ? { phase: "call", call: "waiting", peerPresent: false } : prev));
    setStarting(false);
    setAutoStarting(false);
  }

  function stopSession() {
    photoReqRef.current?.dispose();
    photoReqRef.current = null;
    sessionRef.current?.destroy();
    sessionRef.current = null;
    setAnchorLink(null);
    setGuideLink(null);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    releaseWakeLockRef.current?.();
    releaseWakeLockRef.current = null;
  }

  // 영상을 탭한 곳을 고객 화면에 표시한다. 영상 밖 검은 여백은 무시
  function pointAt(clientX: number, clientY: number) {
    const video = videoRef.current;
    const session = sessionRef.current;
    if (!video || !session || lastCallRef.current !== "connected") return;
    const rect = video.getBoundingClientRect();
    const pos = toVideoPos(video, clientX - rect.left, clientY - rect.top);
    if (!pos) return;
    session.sendPointer(pos);
    showMarker(video, pos);
    setGestureLearned(true);
    logToolOnce("pointer_used");
  }

  // 짧게 탭 = 레이저 포인터(CALL-08), 길게 누름 = 물체에 붙는 핀(CALL-14)
  function endPress() {
    const p = pressRef.current;
    if (p) clearTimeout(p.timer);
    pressRef.current = null;
    setPress(null);
  }

  function onPressDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (lastCallRef.current !== "connected" || pressRef.current) return;
    const box = e.currentTarget.getBoundingClientRect();
    const { clientX: x, clientY: y, pointerId: id } = e;
    const timer = setTimeout(() => {
      const p = pressRef.current;
      if (!p || p.id !== id) return;
      p.done = true;
      setPress(null);
      if (anchorApiRef.current?.pinAt(x, y)) {
        navigator.vibrate?.(15);
        setGestureLearned(true);
        logToolOnce("anchor_used");
      }
    }, LONG_PRESS_MS);
    pressRef.current = { id, x, y, timer, done: false };
    setPress({ x: x - box.left, y: y - box.top });
  }

  function onPressMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId || p.done) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) endPress();
  }

  function onPressUp(e: React.PointerEvent<HTMLDivElement>) {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    const tap = !p.done;
    endPress();
    if (tap) pointAt(p.x, p.y);
  }

  function sendCamera(cmd: "flip" | "torch") {
    const session = sessionRef.current;
    if (!session || camPending || lastCallRef.current !== "connected") return;
    if (cmd === "flip") session.sendCameraCommand({ t: "cam", cmd: "flip" });
    else session.sendCameraCommand({ t: "cam", cmd: "torch", on: !camState?.torch });
    setCamPending(true);
    setCamState((cs) => (cs ? { ...cs, error: undefined } : cs));
    // 응답이 안 오면(구버전 고객 화면 등) 버튼을 다시 풀어 준다
    clearTimeout(camTimerRef.current);
    camTimerRef.current = setTimeout(() => setCamPending(false), 6000);
  }

  // 방향 지시(CALL-15): 누르는 동안 방향 링·알약이 0.4초마다 hold를 보낸다. 닫혀 있으면 send가 false(버림)
  function sendGuide(msg: GuideMsg) {
    if (msg.kind === "release") {
      setGuideCmd(null);
      if (guideLink && lastCallRef.current === "connected") guideLink.send(JSON.stringify(msg));
      return;
    }
    if (!guideLink || lastCallRef.current !== "connected") return;
    if (guideLink.send(JSON.stringify(msg))) {
      setGuideCmd(msg.cmd);
      logToolOnce("guide_used");
    }
  }

  // 고객 폰 카메라로 원본 사진 한 장 (CALL-16). 고객 화면에는 '기사님이 사진을 찍었어요'가 뜬다
  async function takePhoto() {
    const req = photoReqRef.current;
    if (!req || photoBusy || lastCallRef.current !== "connected") return;
    setPhotoBusy(true);
    setPhotoFlash((k) => k + 1);
    let note: "taken" | "failed" = "failed";
    try {
      const blob = await req.request();
      if (unmountedRef.current) return;
      const photo: TakenPhoto = { id: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), at: Date.now() };
      photosRef.current = [...photosRef.current, photo];
      setPhotos(photosRef.current);
      note = "taken";
      logToolOnce("photo_taken");
    } catch {
      // 연결 끊김·고객 폰에서 못 찍음·시간 초과 — 다시 누르면 된다
    } finally {
      if (!unmountedRef.current) {
        setPhotoBusy(false);
        setPhotoNote(note);
        clearTimeout(photoNoteTimerRef.current);
        photoNoteTimerRef.current = setTimeout(() => setPhotoNote(null), note === "taken" ? 2000 : 3500);
      }
    }
  }

  function logToolOnce(name: "pointer_used" | "freeze_used" | "anchor_used" | "guide_used" | "photo_taken") {
    if (toolsLoggedRef.current.has(name)) return;
    toolsLoggedRef.current.add(name);
    logToolUsed(roomId, name).catch(() => {});
  }

  // 지금 보이는 장면을 떠서 고객 화면에도 같은 정지 화면을 띄운다
  function freeze() {
    const video = videoRef.current;
    const session = sessionRef.current;
    if (!video || !session || lastCallRef.current !== "connected") return;
    const image = captureFrame(video);
    if (!image || !session.sendFreeze(image)) {
      setFreezeError(true);
      return;
    }
    endPress();
    setFreezeError(false);
    setFrozen(image);
    setStrokes([]);
    setGuideCmd(null);
    logToolOnce("freeze_used");
  }

  function resume() {
    flushStroke();
    sessionRef.current?.sendDraw({ t: "resume" });
    setFrozen(null);
    setStrokes([]);
  }

  function undo() {
    const last = strokes[strokes.length - 1];
    if (!last) return;
    sessionRef.current?.sendDraw({ t: "undo", id: last.id });
    setStrokes((s) => applyDrawCommand(s, { t: "undo", id: last.id }));
  }

  function clearDrawing() {
    sessionRef.current?.sendDraw({ t: "clear" });
    setStrokes([]);
  }

  // 그리는 중인 선은 화면 갱신 주기마다 모아서 보낸다
  function flushStroke() {
    if (flushFrameRef.current !== null) {
      cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
    const st = strokeRef.current;
    if (!st || !st.pending.length) return;
    sessionRef.current?.sendDraw({ t: "stroke", id: st.id, pts: st.pending });
    st.pending = [];
  }

  function addPoint(p: Point) {
    const st = strokeRef.current;
    if (!st) return;
    st.pending.push(p);
    setStrokes((s) => applyDrawCommand(s, { t: "stroke", id: st.id, pts: [p] }));
    if (flushFrameRef.current === null) {
      flushFrameRef.current = requestAnimationFrame(() => {
        flushFrameRef.current = null;
        flushStroke();
      });
    }
  }

  const drawHandlers: DrawHandlers = {
    start: (p) => {
      flushStroke();
      strokeRef.current = { id: crypto.randomUUID(), pending: [] };
      addPoint(p);
    },
    move: addPoint,
    end: () => {
      flushStroke();
      strokeRef.current = null;
    },
  };

  // PC: F = 멈추고 그리기 / 라이브로 (피그마 P01 키보드 안내)
  const connectedNow = state.phase === "call" && state.call === "connected";
  const freezeToggleRef = useRef<() => void>(() => {});
  useEffect(() => {
    freezeToggleRef.current = () => (frozen ? resume() : freeze());
  });
  useEffect(() => {
    if (!connectedNow || sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyF" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      freezeToggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connectedNow, sheet]);

  // 고객 화면에 종료를 알리고(bye) 이쪽 연결·마이크·화면 켜짐을 정리한다.
  // 세션이 없어도(연결 준비 전, 새로고침 후) 기다리던 고객 화면이 '상담이 끝났어요'로 바뀌어야 한다 — REST로 보내고 잠깐 기다린다
  async function hangupAndStop() {
    const session = sessionRef.current;
    session?.hangup();
    stopSession();
    if (!session) {
      await Promise.race([
        sendBye(roomId, "engineer").catch(() => {}),
        new Promise((r) => setTimeout(r, BYE_WAIT_MS)),
      ]);
    }
  }

  function justShown() {
    return Date.now() - confirmShownAtRef.current < CONFIRM_ARM_MS;
  }

  // 끝내기: 연결된 적 있으면 '통화를 끝낼까요?'(E10), 없으면 '상담을 닫을까요?' (ROOM-10)
  function requestEnd() {
    confirmShownAtRef.current = Date.now();
    setSheet(everConnected ? "end" : "close");
  }

  function cancelEnd() {
    if (justShown()) return;
    setSheet(null);
  }

  // E10 '통화 끝내기'·'끝내기': 고객 화면도 끝나고 상담이 닫힌다
  function endCall() {
    if (justShown()) return;
    closeRoom("engineer");
  }

  // 연결된 적 없는 상담 닫기
  function closeSession() {
    if (justShown()) return;
    closeRoom(null);
  }

  // 상담 끝내기 (ROOM-10). 고객 화면에 종료를 먼저 알리고(bye) 이쪽 세션을 정리한 뒤 상담을 닫는다(endRoom).
  // bye가 먼저다 — 상담이 닫히면 채널 정책이 bye를 막는다. 고객이 끝낸 경우엔 고객이 이미 나갔으니 정리만 한다.
  // 통화 콜백(onState)에서도 부르므로 state가 아니라 ref만 읽는다
  async function closeRoom(by: Closer) {
    if (closingRef.current) return;
    closingRef.current = true;
    confirmShownAtRef.current = 0;
    setSheet(null);
    setSaveError(false);
    setState({ phase: "closing", by });
    if (by === "customer") stopSession();
    else await hangupAndStop();
    // 종료 알림을 기다리는 동안 화면을 떠났어도 상담은 닫는다(이미 끝내기로 정했다). 화면 이동은 finish가 막는다
    finish(by);
  }

  // 상담을 닫는다. 실패하면 닫는 중 화면에서 다시 누른다(세션은 이미 닫혀 통화로 돌아가지 않는다).
  // resendBye: '다시 끝내기' — 실패 화면이 떠 있는 동안 고객이 링크를 다시 열었을 수 있어(상담이 아직 열려 있다) 종료 알림부터 다시 보낸다
  async function finish(by: Closer, resendBye = false) {
    if (endingRef.current) return;
    endingRef.current = true;
    setSaveError(false);
    if (resendBye) await hangupAndStop();
    let result: EndRoomResult | null = null;
    try {
      result = await endRoom(roomId, by !== null);
    } catch {
      // 네트워크 오류 — 아래에서 안내
    }
    if (unmountedRef.current) return;
    endingRef.current = false;
    // 닫기 실패 화면에서 이미 저장한 사진은 다시 묻지 않는다
    const hasPhotos = photosRef.current.length > 0 && !photosSavedRef.current;
    if (result?.ok) {
      // 찍은 사진이 있으면 지워지기 전에 저장할지 묻는다. 없으면 고객이 끝낸 경우만 알리고, 내가 끝냈으면 바로 목록으로
      if (hasPhotos) setState({ phase: "photos", by, relogin: false });
      else if (by === "customer") setState({ phase: "ended" });
      else router.replace("/dashboard");
      return;
    }
    if (result?.reason === "auth") {
      // 다시 로그인하면 끝내지 못한 이 상담으로 돌아온다. 사진은 로그인 화면으로 가면 지워지니 먼저 묻는다
      if (hasPhotos) setState({ phase: "photos", by, relogin: true });
      else router.replace(`/login?next=/room/${roomId}`);
      return;
    }
    setSaveError(true);
  }

  const endLabel = everConnected ? "통화 종료" : "상담 닫기";

  // 끝내기 확인 창 (통화 중이면 통화가 계속되는 채로 위에 뜬다)
  const endSheets = (inCall: boolean) => (
    <>
      <Sheet
        open={sheet === "end"}
        onClose={() => setSheet(null)}
        title={inCall ? "통화를 끝낼까요?" : "상담을 끝낼까요?"}
        description={inCall ? "고객님 화면도 같이 끊겨요." : "고객님께 보낸 링크도 더는 안 열려요."}
        testId="eng-end-sheet"
      >
        <Button variant="danger" size="xl" block onClick={endCall}>
          {inCall ? "통화 끝내기" : "끝내기"}
        </Button>
        <Button variant="secondary" size="xl" block onClick={cancelEnd}>
          {inCall ? "계속 통화하기" : "취소"}
        </Button>
      </Sheet>
      <Sheet
        open={sheet === "close"}
        onClose={() => setSheet(null)}
        title="상담을 닫을까요?"
        description="고객님께 보낸 링크도 더는 안 열려요."
        testId="eng-close-sheet"
      >
        <Button variant="danger" size="xl" block onClick={closeSession}>
          닫기
        </Button>
        <Button variant="secondary" size="xl" block onClick={cancelEnd}>
          취소
        </Button>
      </Sheet>
    </>
  );

  // TURN 없이 STUN만으로 동작 중 — 모바일망(5G/LTE)끼리는 연결이 실패할 수 있다
  const turnBanner = turnError && (
    <Banner tone="warning" icon={<AlertIcon className="size-[22px]" />} sub={`모바일 데이터끼리는 연결이 안 될 수 있어요 (${turnError})`}>
      중계 서버 없이 연결하고 있어요
    </Banner>
  );

  const peerNotice = peerChanged && (
    <Banner
      tone="warning"
      role="alert"
      icon={<AlertIcon className="size-[22px]" />}
      sub="고객님이 새로고침했거나 다른 기기로 들어왔어요. 모르는 사람이면 통화를 끝내세요."
    >
      고객 쪽 기기가 바뀌었어요
    </Banner>
  );

  if (state.phase === "photos") {
    return (
      <PhotoSaveView
        photos={photos}
        byCustomer={state.by === "customer"}
        relogin={state.relogin}
        onLeave={() => router.replace(state.relogin ? `/login?next=/room/${roomId}` : "/dashboard")}
      />
    );
  }

  if (state.phase === "ended") {
    return (
      <NoticeScreen
        testId="eng-customer-ended"
        tone="neutral"
        icon={<PhoneOffIcon className="size-10" />}
        title="고객님이 통화를 끝냈어요"
        actions={
          <Button size="xl" block onClick={() => router.replace("/dashboard")}>
            상담 목록으로
          </Button>
        }
      >
        상담도 같이 끝났어요.
      </NoticeScreen>
    );
  }

  if (state.phase === "closing") {
    const { by } = state;
    const text = CLOSING_TEXT[by === null ? "close" : "end"];
    return (
      <NoticeScreen
        testId="eng-closing"
        tone="neutral"
        icon={saveError ? <AlertIcon className="size-10" /> : <Spinner className="size-10" />}
        title={saveError ? text.failed : by === "customer" ? "고객님이 통화를 끝냈어요" : text.busy}
        actions={
          saveError && (
            <>
              <Button size="xl" block variant="danger" onClick={() => finish(by, true)}>
                {text.retry}
              </Button>
              {/* 사진은 이 기기 메모리에만 있다. 상담이 안 닫혀도(인터넷이 끊겨도) 저장은 되니 먼저 챙길 수 있게 (CALL-16) */}
              {photos.length > 0 && (
                <SavePhotosFirst
                  photos={photos}
                  saved={photosSaved}
                  onSaved={() => {
                    photosSavedRef.current = true;
                    setPhotosSaved(true);
                  }}
                />
              )}
            </>
          )
        }
      >
        {saveError
          ? `인터넷 연결을 확인하고 '${text.retry}'를 눌러 주세요.`
          : by === "customer"
            ? `${text.busy}.`
            : "잠시만 기다려 주세요."}
      </NoticeScreen>
    );
  }

  // 대시보드 탭에서 마이크를 받아 스스로 시작하는 중이면 바로 링크 보내기 화면
  if (state.phase === "idle" && !autoStarting) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]">
        <AppBar
          right={
            <AppBarAction onClick={requestEnd} disabled={starting}>
              {endLabel}
            </AppBarAction>
          }
        />
        <section className="flex flex-col gap-2 pt-3">
          <div className="mb-5 grid size-14 place-items-center rounded-full bg-primary-tint text-icon-brand">
            <MicIcon className="size-7" />
          </div>
          <h1 className="text-title-l">
            {everConnected ? (
              "다시 연결할까요?"
            ) : (
              "마이크부터 켜 주세요"
            )}
          </h1>
          <p className="text-body-m text-text-secondary">
            {everConnected ? "고객님 화면이 열려 있으면 바로 이어져요" : "켜면 고객님께 보낼 링크가 나와요"}
          </p>
        </section>
        <BottomCta>
          <Button size="xl" block onClick={() => start()} loading={starting} icon={<MicIcon className="size-6" />}>
            {starting ? "준비 중…" : everConnected ? "마이크 켜고 다시 연결" : "마이크 켜고 연결 준비"}
          </Button>
        </BottomCta>
        {endSheets(false)}
      </main>
    );
  }

  const call = state.phase === "call" ? state.call : "waiting";
  const peerPresent = state.phase === "call" ? state.peerPresent : false;

  if (call === "connected" || (call === "connecting" && peerPresent)) {
    const connected = call === "connected";
    const unstable = connected && quality === "unstable";
    const endControl = (
      <CallControl state="danger" icon={<PhoneOffIcon />} label="종료" onClick={requestEnd} testId="eng-end" />
    );
    const toolsLeft = frozen ? (
      <>
        <CallControl icon={<UndoIcon />} label="되돌리기" onClick={undo} disabled={!strokes.length} />
        <CallControl icon={<EraserIcon />} label="모두 지우기" onClick={clearDrawing} disabled={!strokes.length} />
      </>
    ) : (
      <>
        <CallControl icon={<FreezeIcon />} label="멈추고 그리기" onClick={freeze} disabled={!connected} />
        <CallControl
          icon={<FlipCameraIcon />}
          label="카메라 바꾸기"
          onClick={() => sendCamera("flip")}
          disabled={!connected || camPending}
        />
      </>
    );
    // 멈춘 동안에도 손전등 자리는 남겨 둔다(보이지 않게) — 옆 종료 버튼이 움직이지 않게
    const torchControl = (
      <span className={frozen ? "invisible" : "contents"} aria-hidden={frozen ? true : undefined}>
      <CallControl
        icon={<FlashlightIcon />}
        label={camState && !camState.torchSupported ? "손전등 없음" : camState?.torch ? "손전등 끄기" : "손전등"}
        state={camState?.torch ? "active" : "default"}
        pressed={camState?.torchSupported ? camState.torch : undefined}
        onClick={() => sendCamera("torch")}
        disabled={!!frozen || !connected || camPending || !camState?.torchSupported}
      />
      </span>
    );
    const center = frozen ? (
      // 멈춘 동안 지금 누를 것은 '라이브로' 하나라 파랑, 방향 지시는 없다 (피그마 E08)
      <div className="flex h-[216px] w-[160px] flex-col items-center justify-center gap-3">
        <Button size="xl" block onClick={resume} icon={<PlayIcon className="size-6" />}>
          라이브로
        </Button>
        <p className="text-center text-caption text-call-text-secondary">멈춘 화면에서는 방향을 알려 줄 수 없어요</p>
      </div>
    ) : (
      <GuideDpad onSend={sendGuide} onHint={setPadHint} disabled={!connected || unstable} />
    );

    return (
      <main className="fixed inset-0 z-30 flex flex-col bg-call-bg text-call-text">
        {/* 위쪽 바 (피그마 CallTopBar · PC는 P01처럼 로고와 종료 버튼) */}
        <header className="flex items-center gap-3 border-b border-call-border/60 bg-call-surface px-4 pt-[max(8px,env(safe-area-inset-top))] pb-2">
          <span className="hidden lg:block">
            <Brand tone="dark" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-label-l">원격 A/S · {createdLabel}</span>
            <span data-testid="eng-call-status" className="text-body-s text-call-text-secondary">
              {connected ? (
                <>통화 중 · {connectedAt && <CallTimer since={connectedAt} />}</>
              ) : (
                "고객님 영상 연결 중…"
              )}
            </span>
          </div>
          {turnError && (
            <button
              type="button"
              onClick={() => setTurnOpen((o) => !o)}
              aria-expanded={turnOpen}
              aria-label="연결 경고 보기"
              className="grid size-9 flex-none place-items-center rounded-full bg-warning-tint text-text-warning"
            >
              <AlertIcon className="size-5" />
            </button>
          )}
          <QualityPill quality={quality} connecting={!connected} />
          <span className="hidden lg:block">
            <Button variant="call-danger" size="m" onClick={requestEnd} icon={<PhoneOffIcon className="size-5" />}>
              통화 종료
            </Button>
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div
            data-testid="eng-stage"
            onPointerDown={frozen ? undefined : onPressDown}
            onPointerMove={frozen ? undefined : onPressMove}
            onPointerUp={frozen ? undefined : onPressUp}
            onPointerCancel={endPress}
            onContextMenu={(e) => e.preventDefault()}
            className="relative min-h-0 flex-1 touch-none overflow-hidden bg-black select-none [-webkit-touch-callout:none]"
          >
            <video
              ref={videoRef}
              data-testid="eng-video"
              autoPlay
              playsInline
              className="absolute inset-0 h-full w-full object-contain"
            />
            {anchorLink && (
              <EngineerAnchorLayer
                video={videoRef}
                link={anchorLink}
                apiRef={anchorApiRef}
                hidden={!!frozen}
              />
            )}
            {press && !frozen && (
              <LongPressRing x={press.x} y={press.y} durationMs={LONG_PRESS_MS} />
            )}
            {frozen ? (
              <FreezeCanvas
                image={frozen}
                strokes={strokes}
                lineWidth={6}
                draw={drawHandlers}
              />
            ) : (
              <PointerMarker marker={marker} size={56} />
            )}
            {(!connected || unstable) && (
              // 피그마 E09: 다시 연결하는 중
              <div className="absolute inset-0 grid place-items-center bg-black-50">
                <div className="flex flex-col items-center gap-3 rounded-2xl bg-black-80 px-6 py-5 text-label-l">
                  <Spinner className="size-7" />
                  {connected ? "다시 연결하는 중…" : "연결하는 중…"}
                </div>
              </div>
            )}
            {/* 알림은 영상 위쪽에 겹친다 (AR 상태 칩 아래) */}
            <div className="pointer-events-none absolute inset-x-3 top-14 z-20 flex flex-col gap-2">
              {unstable && (
                <Banner tone="warning" role="status" sub="다시 연결하고 있어요">
                  연결이 불안정해요
                </Banner>
              )}
              {frozen && (
                <Banner tone="info" icon={<FreezeIcon className="size-[22px]" />} sub="손가락으로 그리면 고객님 화면에도 그려져요">
                  화면을 멈췄어요
                </Banner>
              )}
              {turnOpen && turnBanner}
              {peerNotice}
              {freezeError && !frozen && (
                <Banner tone="error" role="alert">
                  연결이 불안정해 화면을 멈추지 못했어요. 다시 눌러 주세요.
                </Banner>
              )}
              {connected && camState?.error === "needs_tap" && (
                <Banner tone="warning" role="alert" icon={<FlipCameraIcon className="size-[22px]" />}>
                  고객님께 화면의 &lsquo;카메라 바꾸기&rsquo;를 눌러 달라고 말씀해 주세요
                </Banner>
              )}
              {connected && camState?.error === "failed" && (
                <Banner tone="error" role="alert">
                  고객 폰에서 바꾸지 못했어요
                </Banner>
              )}
              {!micOn && (
                <Banner tone="warning" icon={<MicOffIcon className="size-[22px]" />} sub="고객님은 기사님 목소리를 못 들어요">
                  마이크가 꺼져 있어요
                </Banner>
              )}
              {photoNote === "taken" && (
                <Banner tone="success" role="status" icon={<CameraIcon className="size-[22px]" />} sub="통화를 끝낼 때 저장할 수 있어요">
                  사진 {photos.length}장 찍었어요
                </Banner>
              )}
              {photoNote === "failed" && (
                <Banner tone="error" role="alert">
                  사진을 받지 못했어요. 다시 눌러 주세요.
                </Banner>
              )}
              {connected && peerMic === false && (
                <Banner tone="info" icon={<MicOffIcon className="size-[22px]" />} sub="말씀은 전화로 나눠 주세요">
                  고객님 마이크가 꺼져 있어요
                </Banner>
              )}
            </div>
            {/* 찍는 순간 영상이 잠깐 밝아진다 */}
            {photoFlash > 0 && (
              <div
                key={photoFlash}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-10 animate-[fade-in_0.35s_ease-out_reverse_both] bg-gray-0/70"
              />
            )}
            {/* 사진 찍기 (CALL-16): 영상 오른쪽 아래, 카메라 셔터처럼. 찍은 장수 표시 */}
            {connected && !frozen && (
              <button
                type="button"
                data-testid="eng-photo"
                aria-label={photos.length ? `사진 찍기, 지금까지 ${photos.length}장` : "사진 찍기"}
                onClick={takePhoto}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                disabled={photoBusy || unstable}
                className="absolute right-3 bottom-3 z-20 grid size-14 place-items-center rounded-full bg-gray-0 text-gray-900 shadow-float active:scale-95 disabled:opacity-60"
              >
                {photoBusy ? <Spinner className="size-6" /> : <CameraIcon className="size-7" />}
                {photos.length > 0 && (
                  <span
                    data-testid="eng-photo-count"
                    className="absolute -top-1 -right-1 grid h-6 min-w-6 place-items-center rounded-full bg-call-bg px-1.5 text-label-s text-call-text ring-2 ring-gray-0"
                  >
                    {photos.length}
                  </span>
                )}
              </button>
            )}
            {/* 아래: 처음 쓸 때만 제스처 안내, 그리고 지금 고객 화면에 뜬 방향 지시 (PC는 오른쪽 패널에) */}
            {connected && (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-3">
                {!frozen && !gestureLearned && (
                  <p className="w-fit max-w-full rounded-full bg-black-80 px-4 py-2 text-center text-label-s text-call-text">
                    <b className="text-gray-0">톡</b> 누르면 빨간 동그라미, <b className="text-gray-0">꾹</b> 누르면 핀
                  </p>
                )}
                <span className="lg:hidden">
                  <GuidePill cmd={guideCmd} frozen={!!frozen} hint={padHint} />
                </span>
              </div>
            )}
          </div>

          {/* 도구판 (피그마 E05: 가운데 방향 링·알약, 양옆 원형 버튼) · PC는 오른쪽 패널 (P01) */}
          <aside className="bg-call-surface px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:flex lg:w-[400px] lg:flex-col lg:gap-5 lg:overflow-y-auto lg:border-l lg:border-call-border lg:p-6">
            <div className="hidden flex-col gap-1 lg:flex">
              <h2 className="text-title-s">방향 지시</h2>
              <p className="text-body-s text-call-text-secondary">누르는 동안만 고객 화면에 떠요.</p>
              <span className="mt-2">
                <GuidePill cmd={guideCmd} frozen={!!frozen} hint={padHint} />
              </span>
            </div>
            <div className="mx-auto grid w-full max-w-[420px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
              <div className="flex flex-col items-center gap-3">{toolsLeft}</div>
              {center}
              <div className="flex flex-col items-center gap-3">
                {torchControl}
                <span className="contents lg:hidden">{endControl}</span>
              </div>
            </div>
            <div className="hidden lg:block">
              <ShortcutsBox />
            </div>
          </aside>
        </div>
        {endSheets(true)}
      </main>
    );
  }

  if (call === "replaced") {
    return (
      <NoticeScreen
        tone="neutral"
        icon={<PhoneIcon className="size-10" />}
        title="다른 기기에서 이어받았어요"
        actions={
          <>
            <Button size="xl" block onClick={() => start()} loading={starting}>
              {starting ? "준비 중…" : "여기서 다시 받기"}
            </Button>
            <Link href="/dashboard" className="py-3 text-center text-body-m text-text-secondary underline underline-offset-4">
              상담 목록으로
            </Link>
          </>
        }
      >
        이 기기는 통화에서 빠졌어요.
        <br />
        여기서 계속하려면 아래 버튼을 누르세요.
      </NoticeScreen>
    );
  }

  if (call === "denied") {
    return (
      <NoticeScreen
        tone="danger"
        icon={<AlertIcon className="size-10" />}
        title="통화 권한을 확인하지 못했어요"
        actions={
          <Button size="xl" block onClick={() => router.replace(`/login?next=/room/${roomId}`)}>
            다시 로그인
          </Button>
        }
      >
        로그인이 풀렸을 수 있어요.
        <br />
        다시 로그인하면 이 화면으로 돌아와요.
      </NoticeScreen>
    );
  }

  // 고객 부르기: 링크 보내기(E03) → 고객 진행 상황(E04). 연결 실패도 여기서 링크를 다시 보낸다
  return (
    <WaitingView
      joinUrl={joinUrl}
      roomId={roomId}
      kakaoArgs={kakaoArgs}
      createdLabel={createdLabel}
      micOn={state.phase === "call" ? micOn : null}
      sentVia={sentVia}
      onSent={setSentVia}
      progress={progress}
      peerPresent={peerPresent}
      failed={call === "failed"}
      everConnected={everConnected}
      banners={
        <>
          {turnBanner}
          {peerNotice}
        </>
      }
      onClose={requestEnd}
      closeLabel={endLabel}
      closeDisabled={starting && !autoStarting}
      sheets={endSheets(false)}
    />
  );
}
