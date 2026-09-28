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
import { Brand } from "@/components/ui/brand";
import { Button } from "@/components/ui/button";
import { CallControl } from "@/components/ui/call-control";
import { Sheet } from "@/components/ui/sheet";
import { NoticeScreen } from "@/components/ui/notice-screen";
import {
  AlertIcon,
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
import { endRoom, getJoinProgress, logToolUsed, markRoomActive, type JoinProgress } from "./actions";
import type { SentVia } from "./share-buttons";
import { AppBar, CallTimer, QualityPill, ShortcutsBox } from "./call-ui";
import { WaitingView } from "./waiting-view";
import { RecordView, type CallSummary } from "./record-view";

type PanelState =
  | { phase: "idle" }
  | { phase: "call"; call: CallState; peerPresent: boolean }
  // 결과 기록(E11). by: 누가 통화를 끝냈는지
  | { phase: "record"; by: "engineer" | "customer" }
  // 연결된 적 없는 상담을 닫는 중(저장)
  | { phase: "closing" };

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

const NO_SUMMARY: CallSummary = { talkSec: null, pointer: 0, guide: 0, draw: 0 };

// 방향키 등 텍스트 입력 중인지 (F 단축키가 입력을 가로채지 않게)
function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// 엔지니어 세션 화면 (피그마 E03~E11·P01, ROOM-05·10·13, CALL-01·04).
//   고객 부르기(링크 보내기 → 고객 진행 상황) → 통화(어두운 전체 화면, 영상 + 십자키·도구) → 통화를 끝낼까요? → 결과 기록
// 대시보드의 '새 A/S 시작'·'이어하기' 탭에서 마이크를 미리 받아 두면(mic-ahead) 화면이 뜨자마자 통화 대기를 시작한다.
// 폰 한 손 조작 기준: 누를 것은 아래쪽에, 크게.
export function CallPanel({
  roomId,
  joinToken,
  joinUrl,
  createdLabel,
  everConnected: initialEverConnected,
}: {
  roomId: string;
  // 고객 링크 토큰. TURN 자격증명 발급에 쓴다
  joinToken: string;
  // 고객에게 보낼 링크 (ROOM-06~08)
  joinUrl: string;
  // '오늘 오후 5:00' — 이 상담을 만든 시각
  createdLabel: string;
  // 이미 '연결됨'인 세션인지. 한 번도 연결 안 된 세션은 원격 해결 여부를 묻지 않는다
  everConnected: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const [everConnected, setEverConnected] = useState(initialEverConnected);
  const [micOn, setMicOn] = useState(false);
  const [starting, setStarting] = useState(false);
  // 대시보드에서 마이크를 미리 받아 와 스스로 시작하는 중 (버튼 없이 링크 보내기 화면을 먼저 보여 준다)
  const [autoStarting, setAutoStarting] = useState(false);
  const [sheet, setSheet] = useState<EndSheetKind>(null);
  const [ending, setEnding] = useState(false);
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
  // 결과 기록 화면에 보여 줄 통화 요약
  const [summary, setSummary] = useState<CallSummary>(NO_SUMMARY);
  // 고객 쪽 기기가 바뀐 직후 잠깐 알린다 (BUG-04: 링크가 새서 다른 사람이 들어온 경우를 알아채게)
  const [peerChanged, setPeerChanged] = useState(false);
  const peerChangedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef<CallSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  // 화면을 떠난 뒤 늦게 끝난 start()·finish()가 세션을 만들거나 화면을 옮기지 않게 한다
  const unmountedRef = useRef(false);
  // 저장 중에는 고객이 다시 들어와도 기록 화면에 머문다
  const endingRef = useRef(false);
  const lastCallRef = useRef<CallState>("waiting");
  const confirmShownAtRef = useRef(0);
  const releaseWakeLockRef = useRef<(() => void) | null>(null);
  const toolsLoggedRef = useRef(new Set<"pointer_used" | "freeze_used" | "anchor_used" | "guide_used">());
  // 통화 요약용 횟수 (가리키기·핀, 방향 지시 누름, 그린 선)
  const usageRef = useRef({ pointer: 0, guide: 0, draw: 0 });
  const lastGuideRef = useRef<GuideCmd | null>(null);
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

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      clearTimeout(camTimerRef.current);
      clearTimeout(peerChangedTimerRef.current);
      if (pressRef.current) clearTimeout(pressRef.current.timer);
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
      if (!stopped && p) setProgress(p);
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
    if (unmountedRef.current) {
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
      onState: (call) => {
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
          setEverConnected(true);
          if (connectedAtRef.current === null) connectedAtRef.current = Date.now();
          setConnectedAt(connectedAtRef.current);
          // 연결된 적 없는 세션의 '닫을까요?'는 더 맞지 않다 (해결 여부를 물어야 한다)
          setSheet((s) => (s === "close" ? null : s));
          markRoomActive(roomId);
        }
        if (call === "ended") {
          // 고객이 끊으면 열려 있던 확인 창은 결과 기록 화면으로 대체된다
          confirmShownAtRef.current = Date.now();
          setSaveError(false);
          setSheet(null);
          setSummary(snapshotSummary());
        }
        if (call === "connecting") setSaveError(false);
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
        setState((prev) => {
          if (prev.phase === "record") {
            // 답하기 전에 다른 기기가 이어받았으면 여기서는 답하지 않는다 (이어받은 기기가 계속한다)
            if (call === "replaced" && !endingRef.current) {
              return { phase: "call", call, peerPresent: false };
            }
            // 고객이 종료한 뒤 링크를 다시 열고 들어오면 통화로 돌아간다
            return prev.by === "customer" &&
              !endingRef.current &&
              (call === "connecting" || call === "connected")
              ? { phase: "call", call, peerPresent: true }
              : prev;
          }
          if (prev.phase === "closing") return prev;
          if (call === "ended") return { phase: "record", by: "customer" };
          return {
            phase: "call",
            call,
            peerPresent: prev.phase === "call" ? prev.peerPresent : false,
          };
        });
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
    session.join();
    setState((prev) => (prev.phase === "idle" ? { phase: "call", call: "waiting", peerPresent: false } : prev));
    setStarting(false);
    setAutoStarting(false);
  }

  function stopSession() {
    sessionRef.current?.destroy();
    sessionRef.current = null;
    setAnchorLink(null);
    setGuideLink(null);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    releaseWakeLockRef.current?.();
    releaseWakeLockRef.current = null;
  }

  function snapshotSummary(): CallSummary {
    const u = usageRef.current;
    const at = connectedAtRef.current;
    return { talkSec: at === null ? null : (Date.now() - at) / 1000, pointer: u.pointer, guide: u.guide, draw: u.draw };
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
    usageRef.current.pointer++;
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
        usageRef.current.pointer++;
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

  // 방향 지시(CALL-15): 누르는 동안 십자키가 0.4초마다 hold를 보낸다. 닫혀 있으면 send가 false(버림)
  function sendGuide(msg: GuideMsg) {
    if (msg.kind === "release") {
      lastGuideRef.current = null;
      setGuideCmd(null);
      if (guideLink && lastCallRef.current === "connected") guideLink.send(JSON.stringify(msg));
      return;
    }
    if (!guideLink || lastCallRef.current !== "connected") return;
    if (guideLink.send(JSON.stringify(msg))) {
      // 0.4초마다 다시 오는 hold는 세지 않고, 새로 누르거나 방향을 바꿀 때만 센다
      if (lastGuideRef.current !== msg.cmd) usageRef.current.guide++;
      lastGuideRef.current = msg.cmd;
      setGuideCmd(msg.cmd);
      logToolOnce("guide_used");
    }
  }

  function logToolOnce(name: "pointer_used" | "freeze_used" | "anchor_used" | "guide_used") {
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
      usageRef.current.draw++;
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

  // 고객에게 종료를 알리고 이쪽 연결·마이크를 정리한다.
  // 세션이 없어도(연결 준비 전, 새로고침 후) 기다리던 고객 화면이 '상담이 끝났어요'로 바뀌어야 한다
  function hangupAndStop() {
    if (sessionRef.current) sessionRef.current.hangup();
    else sendBye(roomId, "engineer").catch(() => {});
    stopSession();
  }

  function justShown() {
    return Date.now() - confirmShownAtRef.current < CONFIRM_ARM_MS;
  }

  // 끝내기: 연결된 적 있으면 '통화를 끝낼까요?'(E10), 없으면 '상담을 닫을까요?' (ROOM-10)
  function requestEnd() {
    confirmShownAtRef.current = Date.now();
    setSaveError(false);
    setSheet(everConnected ? "end" : "close");
  }

  function cancelEnd() {
    if (justShown()) return;
    setSheet(null);
  }

  // E10 '통화 끝내기': 고객 화면도 끝나고 결과 기록(E11)으로
  function endCall() {
    if (justShown()) return;
    setSummary(snapshotSummary());
    hangupAndStop();
    setSheet(null);
    confirmShownAtRef.current = 0;
    setState({ phase: "record", by: "engineer" });
  }

  // 연결된 적 없는 상담 닫기. 고객에게 알리고 해결 여부 없이 저장
  function closeSession() {
    if (justShown() || endingRef.current) return;
    hangupAndStop();
    setSheet(null);
    setState({ phase: "closing" });
    confirmShownAtRef.current = 0; // 방금 확인한 결정이므로 대기 없이 저장
    finish(null);
  }

  // 연결은 저장이 성공해 화면을 떠날 때 정리된다(언마운트). 그래야 저장에 실패해도
  // 고객이 먼저 끊은 경우 계속 기다렸다가 이어받을 수 있다
  async function finish(resolvedRemotely: boolean | null) {
    if (justShown() || endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    setSaveError(false);
    let result: Awaited<ReturnType<typeof endRoom>> | null = null;
    try {
      result = await endRoom(roomId, resolvedRemotely);
    } catch {
      // 네트워크 오류 — 아래에서 안내
    }
    if (unmountedRef.current) return;
    if (result?.ok) {
      // 기록 화면에 있는 동안 고객이 다시 들어왔을 수 있다 — 세션이 없어도 떠나기 전에 종료를 알린다
      hangupAndStop();
      router.replace("/dashboard");
      return;
    }
    if (result?.reason === "auth") {
      // 다시 로그인하면 답하지 못한 이 세션으로 돌아온다
      router.replace(`/login?next=/room/${roomId}`);
      return;
    }
    endingRef.current = false;
    setEnding(false);
    setSaveError(true);
    // 저장 중 고객이 다시 들어와 연결됐으면 통화 화면으로 돌아간다
    const last = lastCallRef.current;
    if (sessionRef.current && (last === "connecting" || last === "connected")) {
      setState((prev) =>
        prev.phase === "record" && prev.by === "customer"
          ? { phase: "call", call: last, peerPresent: true }
          : prev,
      );
    }
  }

  const endLabel = everConnected ? "통화 종료" : "상담 닫기";

  // 끝내기 확인 창 (통화 중이면 통화가 계속되는 채로 위에 뜬다)
  const endSheets = (inCall: boolean) => (
    <>
      <Sheet
        open={sheet === "end"}
        onClose={() => setSheet(null)}
        title={inCall ? "통화를 끝낼까요?" : "상담을 끝낼까요?"}
        description={inCall ? "고객 화면도 함께 끝나요. 끝낸 뒤 결과를 기록해요." : "끝낸 뒤 결과를 기록해요."}
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
        description="고객님께 보낸 링크도 더 이상 열리지 않아요."
        testId="eng-close-sheet"
      >
        <Button variant="danger" size="xl" block disabled={ending} onClick={closeSession}>
          네, 닫기
        </Button>
        <Button variant="secondary" size="xl" block onClick={cancelEnd}>
          취소
        </Button>
      </Sheet>
    </>
  );

  // TURN 없이 STUN만으로 동작 중 — 모바일망(5G/LTE)끼리는 연결이 실패할 수 있다
  const turnBanner = turnError && (
    <Banner tone="warning" icon={<AlertIcon className="size-[22px]" />}>
      TURN 서버 없이 연결 중 — 모바일망끼리는 실패할 수 있어요 ({turnError})
    </Banner>
  );

  const peerNotice = peerChanged && (
    <Banner tone="warning" role="alert" icon={<AlertIcon className="size-[22px]" />}>
      고객 쪽 연결이 새로 바뀌었어요 (고객 새로고침 또는 다른 기기). 모르는 사람이면 종료하세요.
    </Banner>
  );

  if (state.phase === "record") {
    return (
      <RecordView
        createdLabel={createdLabel}
        byCustomer={state.by === "customer"}
        summary={summary}
        saving={ending}
        saveError={saveError}
        onSubmit={finish}
      />
    );
  }

  if (state.phase === "closing") {
    return (
      <NoticeScreen
        tone="neutral"
        icon={ending ? <Spinner className="size-10" /> : <AlertIcon className="size-10" />}
        title={ending ? "상담을 닫는 중이에요" : "상담을 닫지 못했어요"}
        actions={
          !ending && (
            <Button size="xl" block variant="danger" onClick={() => finish(null)}>
              다시 닫기
            </Button>
          )
        }
      >
        {saveError ? "저장에 실패했어요. 다시 눌러 주세요." : "잠시만 기다려 주세요."}
      </NoticeScreen>
    );
  }

  // 대시보드 탭에서 마이크를 받아 스스로 시작하는 중이면 바로 링크 보내기 화면
  if (state.phase === "idle" && !autoStarting) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]">
        <AppBar
          title={everConnected ? "원격 A/S" : "새 A/S 시작"}
          right={
            <button
              type="button"
              onClick={requestEnd}
              disabled={starting}
              className="-mr-2 h-touch rounded-xl px-3 text-label-m text-text-secondary active:bg-bg-muted disabled:opacity-40"
            >
              {endLabel}
            </button>
          }
        />
        <section className="flex flex-1 flex-col justify-center gap-6 py-8">
          <div className="grid size-20 place-items-center rounded-full bg-primary-tint text-icon-brand">
            <MicIcon className="size-10" />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-title-l">{everConnected ? "다시 연결할까요?" : "마이크를 켜고 시작해요"}</h2>
            <p className="text-body-m text-text-secondary">
              {everConnected
                ? "고객님 화면이 열려 있으면 누르는 대로 바로 이어져요."
                : "마이크를 켜면 고객님께 보낼 링크가 나와요. 고객님이 카메라를 켜는 대로 자동으로 연결돼요."}
            </p>
          </div>
        </section>
        <div className="sticky bottom-0 -mx-5 mt-auto bg-bg-page/95 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur">
          <Button size="xl" block onClick={() => start()} loading={starting} icon={<MicIcon className="size-6" />}>
            {starting ? "준비 중…" : everConnected ? "마이크 켜고 다시 연결" : "마이크 켜고 연결 준비"}
          </Button>
        </div>
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
    const torchControl = !frozen && (
      <CallControl
        icon={<FlashlightIcon />}
        label={camState && !camState.torchSupported ? "손전등 없음" : camState?.torch ? "손전등 끄기" : "손전등"}
        state={camState?.torch ? "active" : "default"}
        pressed={camState?.torchSupported ? camState.torch : undefined}
        onClick={() => sendCamera("torch")}
        disabled={!connected || camPending || !camState?.torchSupported}
      />
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
                <Banner tone="warning" role="status">
                  연결이 불안정해요 · 다시 연결하는 중
                </Banner>
              )}
              {frozen && (
                <Banner tone="info" icon={<FreezeIcon className="size-[22px]" />}>
                  화면을 멈췄어요 · 손가락으로 그리면 고객님 화면에도 보여요
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
                <Banner tone="warning" icon={<MicOffIcon className="size-[22px]" />}>
                  마이크 꺼짐(보기만) · 고객님은 기사님 목소리를 못 들어요
                </Banner>
              )}
              {connected && peerMic === false && (
                <Banner tone="info" icon={<MicOffIcon className="size-[22px]" />}>
                  고객 마이크 없음 · 전화로 말씀하세요
                </Banner>
              )}
            </div>
            {/* 아래: 처음 쓸 때만 제스처 안내, 그리고 지금 고객 화면에 뜬 방향 지시 (PC는 오른쪽 패널에) */}
            {connected && (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-3">
                {!frozen && !gestureLearned && (
                  <p className="w-fit max-w-full rounded-full bg-black-80 px-4 py-2 text-center text-label-s text-call-text">
                    <b className="text-gray-0">톡</b> 빨간 동그라미 3초 · <b className="text-gray-0">꾹</b> 물체에 붙는 핀
                  </p>
                )}
                <span className="lg:hidden">
                  <GuidePill cmd={guideCmd} frozen={!!frozen} hint={padHint} />
                </span>
              </div>
            )}
          </div>

          {/* 도구판 (피그마 E05: 가운데 십자키, 양옆 원형 버튼) · PC는 오른쪽 패널 (P01) */}
          <aside className="bg-call-surface px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:flex lg:w-[400px] lg:flex-col lg:gap-5 lg:overflow-y-auto lg:border-l lg:border-call-border lg:p-6">
            <div className="hidden flex-col gap-1 lg:flex">
              <h2 className="text-title-s">방향 지시</h2>
              <p className="text-body-s text-call-text-secondary">누르고 있는 동안만 고객 화면에 표시돼요. 떼면 사라져요.</p>
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
        여기서 계속하려면 아래를 누르세요.
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
