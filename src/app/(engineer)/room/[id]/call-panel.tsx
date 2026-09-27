"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CallSession, sendBye, type CallState } from "@/lib/webrtc/call";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { toVideoPos } from "@/lib/webrtc/pointer";
import {
  applyDrawCommand,
  captureFrame,
  type Point,
  type Stroke,
} from "@/lib/webrtc/draw";
import { keepScreenOn } from "@/lib/wake-lock";
import type { CameraState } from "@/lib/webrtc/camera";
import { PointerMarker, usePointerMarker } from "@/components/pointer-marker";
import { FreezeCanvas, type DrawHandlers } from "@/components/freeze-canvas";
import {
  EngineerAnchorLayer,
  type EngineerAnchorApi,
} from "@/components/anchor/engineer-anchor";
import { LongPressRing } from "@/components/anchor/long-press-ring";
import { GuideDpad } from "@/components/guide-dpad";
import type { GuideMsg } from "@/lib/webrtc/guide";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { NoticeScreen } from "@/components/ui/notice-screen";
import {
  AlertIcon,
  CarIcon,
  CheckIcon,
  ChevronLeftIcon,
  EraserIcon,
  FlashlightIcon,
  FlipCameraIcon,
  MicIcon,
  MicOffIcon,
  PencilIcon,
  PhoneIcon,
  PhoneOffIcon,
  PlayIcon,
  Spinner,
  UndoIcon,
} from "@/components/ui/icons";
import { endRoom, logToolUsed, markRoomActive } from "./actions";
import { ShareButtons } from "./share-buttons";
import { CallBanner, CallTimer, ToolButton } from "./call-ui";

type PanelState =
  | { phase: "idle" }
  | { phase: "call"; call: CallState; peerPresent: boolean }
  // 종료 후 확인. by: 누가 끝냈는지
  | { phase: "confirm-end"; by: "engineer" | "customer" };

// 끝내기 확인 창: end = 해결 여부를 고르면 끝남(연결된 적 있음), close = 연결 없이 닫기
type EndSheetKind = "end" | "close" | null;

// 확인 화면이 뜬 직후의 탭은 무시한다. 종료 버튼을 두 번 누르면 두 번째 탭이
// 같은 자리에 뜬 답 버튼에 떨어져 핵심 지표가 잘못 저장된다
const CONFIRM_ARM_MS = 600;

// 길게 누르기(AR 핀, CALL-14) 판정: 이 시간 이상 누르고, 그동안 손가락이 이 거리 안에 있으면 핀.
// 그보다 짧게 떼면 레이저 포인터(CALL-08). 움직이면 둘 다 아님(스크롤·실수 방지)
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 12;

// 엔지니어 통화 패널 (ROOM-05, CALL-01·04). 화면은 상태마다 하나의 할 일만 보여 준다:
//   준비(마이크 켜기) → 대기(고객님께 링크 보내기) → 통화(어두운 전체 화면, 영상 + 십자키·도구) → 해결 여부
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
  const [sheet, setSheet] = useState<EndSheetKind>(null);
  const [ending, setEnding] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [turnOpen, setTurnOpen] = useState(false);
  // 처음 연결된 시각 — 통화 시간 표시
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  // 고객 쪽 소리가 오는지. 고객이 전화 통화 중이라 마이크 없이 카메라만 켰으면 false (JOIN-04)
  const [peerMic, setPeerMic] = useState<boolean | null>(null);
  // 처음 쓰기 전까지만 보이는 사용법 안내 (영상 제스처, 십자키)
  const [gestureLearned, setGestureLearned] = useState(false);
  const [dpadLearned, setDpadLearned] = useState(false);
  // 고객 쪽 기기가 바뀐 직후 잠깐 알린다 (BUG-04: 링크가 새서 다른 사람이 들어온 경우를 알아채게)
  const [peerChanged, setPeerChanged] = useState(false);
  const peerChangedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef<CallSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  // 화면을 떠난 뒤 늦게 끝난 start()·finish()가 세션을 만들거나 화면을 옮기지 않게 한다
  const unmountedRef = useRef(false);
  // 저장 중에는 고객이 다시 들어와도 확인 화면에 머문다
  const endingRef = useRef(false);
  const lastCallRef = useRef<CallState>("waiting");
  const confirmShownAtRef = useRef(0);
  const releaseWakeLockRef = useRef<(() => void) | null>(null);
  const toolsLoggedRef = useRef(new Set<"pointer_used" | "freeze_used" | "anchor_used" | "guide_used">());
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

  // 마이크 요청은 반드시 버튼 탭(제스처) 이후
  async function start() {
    if (starting || sessionRef.current) return;
    setStarting(true);
    releaseWakeLockRef.current?.();
    releaseWakeLockRef.current = keepScreenOn();
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // 마이크 거부/없음 — 영상 보기만이라도 진행
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
        }
        if (call === "connected") {
          setEverConnected(true);
          setConnectedAt((t) => t ?? Date.now());
          // 연결된 적 없는 세션의 '닫을까요?'는 더 맞지 않다 (해결 여부를 물어야 한다)
          setSheet((s) => (s === "close" ? null : s));
          markRoomActive(roomId);
        }
        if (call === "ended") {
          // 고객이 끊으면 열려 있던 확인 창은 해결 여부 화면으로 대체된다
          confirmShownAtRef.current = Date.now();
          setSaveError(false);
          setSheet(null);
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
          if (prev.phase === "confirm-end") {
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
          if (call === "ended") return { phase: "confirm-end", by: "customer" };
          return {
            phase: "call",
            call,
            peerPresent: prev.phase === "call" ? prev.peerPresent : false,
          };
        });
      },
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
    setState({ phase: "call", call: "waiting", peerPresent: false });
    setStarting(false);
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

  // 방향 지시(CALL-15): 누르는 동안 십자키가 0.4초마다 hold를 보낸다. 닫혀 있으면 send가 false(버림)
  function sendGuide(msg: GuideMsg) {
    if (!guideLink || lastCallRef.current !== "connected") return;
    if (guideLink.send(JSON.stringify(msg)) && msg.kind === "hold") {
      setDpadLearned(true);
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

  // 끝내기: 연결된 적 있으면 해결 여부를 고르는 창, 없으면 닫을지 확인하는 창 (ROOM-10)
  function requestEnd() {
    confirmShownAtRef.current = Date.now();
    setSaveError(false);
    setSheet(everConnected ? "end" : "close");
  }

  function cancelEnd() {
    if (justShown()) return;
    setSheet(null);
  }

  // 확인 창에서 답을 고르면 그때 통화를 끊고 저장한다. 고르기 전에는 통화가 이어진다
  function answerAndEnd(resolvedRemotely: boolean | null) {
    if (justShown() || endingRef.current) return;
    hangupAndStop();
    setSheet(null);
    setState({ phase: "confirm-end", by: "engineer" });
    confirmShownAtRef.current = 0; // 방금 확인한 결정이므로 대기 없이 저장
    finish(resolvedRemotely);
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
      // 확인 화면에 있는 동안 고객이 다시 들어왔을 수 있다 — 세션이 없어도 떠나기 전에 종료를 알린다
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
        prev.phase === "confirm-end" && prev.by === "customer"
          ? { phase: "call", call: last, peerPresent: true }
          : prev,
      );
    }
  }

  const saveErrorText = saveError && (
    <p role="alert" className="text-center text-body-m font-medium text-text-danger">
      저장에 실패했어요. 다시 눌러 주세요.
    </p>
  );

  // 해결 여부 두 답은 같은 무게로 보여 준다 — 한쪽을 강조하면 핵심 지표(원격 해결률)가 기운다
  const answerButtons = (dark: boolean) => (
    <>
      <Button
        variant={dark ? "call" : "secondary"}
        size="xl"
        block
        disabled={ending}
        onClick={() => (state.phase === "confirm-end" ? finish(true) : answerAndEnd(true))}
        icon={<CheckIcon className="size-6 text-success" />}
        className="justify-start"
      >
        네, 원격으로 해결했어요
      </Button>
      <Button
        variant={dark ? "call" : "secondary"}
        size="xl"
        block
        disabled={ending}
        onClick={() => (state.phase === "confirm-end" ? finish(false) : answerAndEnd(false))}
        icon={<CarIcon className="size-6 text-text-warning" />}
        className="justify-start"
      >
        아니요, 출장이 필요해요
      </Button>
    </>
  );

  const endLabel = everConnected ? "통화 종료" : "상담 닫기";

  // 끝내기 확인 창 (통화 중이면 어두운 창)
  const endSheet = (dark: boolean) => (
    <>
      <Sheet
        open={sheet === "end"}
        onClose={() => setSheet(null)}
        tone={dark ? "dark" : "light"}
        title="출장 없이 해결됐나요?"
        description={dark ? "고르면 통화가 끝나고 저장돼요." : "고르면 상담이 끝나고 저장돼요."}
        testId="eng-end-sheet"
      >
        {answerButtons(dark)}
        <Button variant={dark ? "call-ghost" : "ghost"} size="l" block onClick={cancelEnd}>
          {dark ? "계속 통화하기" : "취소"}
        </Button>
        {saveErrorText}
      </Sheet>
      <Sheet
        open={sheet === "close"}
        onClose={() => setSheet(null)}
        tone={dark ? "dark" : "light"}
        title="상담을 닫을까요?"
        description="고객님께 보낸 링크도 더 이상 열리지 않아요."
        testId="eng-close-sheet"
      >
        <Button variant="danger" size="xl" block disabled={ending} onClick={() => answerAndEnd(null)}>
          네, 닫기
        </Button>
        <Button variant={dark ? "call-ghost" : "ghost"} size="l" block onClick={cancelEnd}>
          취소
        </Button>
        {saveErrorText}
      </Sheet>
    </>
  );

  const header = <RoomHeader createdLabel={createdLabel} micOn={state.phase === "call" ? micOn : null} />;

  // TURN 없이 STUN만으로 동작 중 — 모바일망(5G/LTE)끼리는 연결이 실패할 수 있다
  const turnText = turnError && (
    <span className="flex gap-2">
      <AlertIcon className="mt-0.5 size-4 flex-none" />
      <span>TURN 서버 없이 연결 중 — 모바일망끼리는 실패할 수 있어요 ({turnError})</span>
    </span>
  );

  const peerNotice = peerChanged && (
    <CallBanner tone="warning" role="alert">
      고객 쪽 연결이 새로 바뀌었어요 (고객 새로고침 또는 다른 기기). 모르는 사람이면 종료하세요.
    </CallBanner>
  );

  const endLink = (
    <Button variant="ghost" size="m" block onClick={requestEnd} disabled={starting}>
      {endLabel}
    </Button>
  );

  if (state.phase === "idle") {
    return (
      <LightLayout header={header}>
        <section className="flex flex-1 flex-col justify-center gap-6 py-8">
          <div className="grid size-20 place-items-center rounded-full bg-primary-tint text-icon-brand">
            <MicIcon className="size-10" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-title-l">{everConnected ? "다시 연결할까요?" : "먼저 마이크를 켜 주세요"}</h1>
            <p className="text-body-m text-text-secondary">
              {everConnected
                ? "고객님 화면이 열려 있으면 누르는 대로 바로 이어져요."
                : "마이크를 켜고 고객님께 링크를 보내면, 고객님이 카메라를 켜는 대로 자동으로 연결돼요."}
            </p>
          </div>
          {!everConnected && (
            <ol className="flex flex-col gap-3 rounded-2xl bg-bg-subtle p-4 text-body-m">
              <FlowStep n={1} active>
                마이크 켜기 <span className="text-text-secondary">(지금)</span>
              </FlowStep>
              <FlowStep n={2}>고객님께 문자로 링크 보내기</FlowStep>
              <FlowStep n={3}>고객님이 카메라를 켜면 자동 연결</FlowStep>
            </ol>
          )}
        </section>
        <BottomActions>
          <Button
            size="xl"
            block
            onClick={start}
            disabled={starting}
            icon={starting ? <Spinner className="size-6" /> : <MicIcon className="size-6" />}
          >
            {starting ? "준비 중…" : everConnected ? "마이크 켜고 다시 연결" : "마이크 켜고 연결 준비"}
          </Button>
          {endLink}
        </BottomActions>
        {endSheet(false)}
      </LightLayout>
    );
  }

  if (state.phase === "confirm-end") {
    const byCustomer = state.by === "customer";
    return (
      <LightLayout header={<RoomHeader createdLabel={createdLabel} micOn={null} back={false} />}>
        <section className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center">
          <div className="grid size-20 place-items-center rounded-full bg-bg-muted text-icon-secondary">
            <PhoneOffIcon className="size-10" />
          </div>
          <p className="text-title-s text-text-secondary">
            {byCustomer ? "고객님이 통화를 끝냈어요" : ending ? "저장하는 중…" : "통화를 끝냈어요"}
          </p>
          {everConnected ? (
            <h1 className="text-title-l">출장 없이 해결됐나요?</h1>
          ) : (
            <h1 className="text-title-l">고객님과 연결되지 않은 상담이에요</h1>
          )}
          {byCustomer && (
            <p className="text-body-m text-text-secondary">고객님이 링크를 다시 열면 통화로 돌아가요.</p>
          )}
        </section>
        <BottomActions>
          {everConnected ? (
            answerButtons(false)
          ) : (
            <Button size="xl" block variant="danger" onClick={() => finish(null)} disabled={ending}>
              상담 닫기
            </Button>
          )}
          {saveErrorText}
        </BottomActions>
      </LightLayout>
    );
  }

  const { call, peerPresent } = state;

  if (call === "connected" || (call === "connecting" && peerPresent)) {
    const connected = call === "connected";
    return (
      <main className="fixed inset-0 z-30 flex flex-col bg-call-bg text-call-text lg:flex-row">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* 위쪽 상태 줄: 통화 시간, 마이크, 경고 */}
          <div className="flex flex-wrap items-center gap-2 px-3 pt-[max(10px,env(safe-area-inset-top))] pb-2">
            <span
              data-testid="eng-call-status"
              className="inline-flex items-center gap-2 rounded-full bg-call-control px-3 py-1.5 text-label-s"
            >
              {connected ? (
                <>
                  <span aria-hidden="true" className="size-2.5 rounded-full bg-success" />
                  통화 중 · {connectedAt && <CallTimer since={connectedAt} />}
                </>
              ) : (
                <>
                  <Spinner className="size-3.5" />
                  연결 중…
                </>
              )}
            </span>
            {!micOn && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-tint px-3 py-1.5 text-label-s text-text-warning">
                <MicOffIcon className="size-4" />
                마이크 꺼짐(보기만)
              </span>
            )}
            {connected && peerMic === false && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-call-control px-3 py-1.5 text-label-s text-call-text">
                <MicOffIcon className="size-4" />
                고객 마이크 없음 · 전화로 말씀하세요
              </span>
            )}
            {turnError && (
              <button
                type="button"
                onClick={() => setTurnOpen((o) => !o)}
                aria-expanded={turnOpen}
                aria-label="연결 경고 보기"
                className="ml-auto grid size-9 place-items-center rounded-full bg-warning-tint text-text-warning"
              >
                <AlertIcon className="size-5" />
              </button>
            )}
          </div>

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
            {!connected && (
              <p className="absolute inset-0 flex items-center justify-center gap-2 text-body-m text-call-text-secondary">
                <Spinner className="size-5" />
                고객님 영상 연결 중…
              </p>
            )}
            {connected && (frozen || !gestureLearned) && (
              <p className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit max-w-[92%] rounded-full bg-black-80 px-4 py-2 text-center text-label-s text-call-text">
                {frozen ? (
                  "손가락으로 그리면 고객님 화면에도 보여요"
                ) : (
                  <>
                    <b className="text-gray-0">톡</b> 빨간 동그라미 3초 · <b className="text-gray-0">꾹</b> 물체에 붙는 핀
                  </>
                )}
              </p>
            )}
            {/* 알림은 영상 위쪽에 겹친다 (AR 상태 칩 아래) */}
            <div className="pointer-events-none absolute inset-x-3 top-14 z-20 flex flex-col gap-2">
              {turnOpen && turnText && <CallBanner tone="warning">{turnText}</CallBanner>}
              {peerNotice}
              {freezeError && !frozen && (
                <CallBanner tone="danger" role="alert">
                  연결이 불안정해 화면을 멈추지 못했어요. 다시 눌러 주세요.
                </CallBanner>
              )}
              {connected && camState?.error === "needs_tap" && (
                <CallBanner tone="warning" role="alert">
                  고객님께 화면의 &lsquo;카메라 바꾸기&rsquo;를 눌러 달라고 말씀해 주세요
                </CallBanner>
              )}
              {connected && camState?.error === "failed" && (
                <CallBanner tone="danger" role="alert">
                  고객 폰에서 바꾸지 못했어요
                </CallBanner>
              )}
            </div>
          </div>
        </div>

        {/* 아래 도구: 가운데 십자키, 양옆에 도구. 엄지가 닿는 곳 */}
        <aside className="relative z-10 rounded-t-3xl bg-call-surface px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:flex lg:w-[400px] lg:flex-col lg:justify-center lg:rounded-none lg:border-l lg:border-call-border">
          <div className="mx-auto grid w-full max-w-[440px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2">
            <div className="flex flex-col gap-2">
              {frozen ? (
                <>
                  <ToolButton tone="primary" icon={<PlayIcon className="size-7" />} label="다시 보기" onClick={resume} />
                  <ToolButton
                    icon={<UndoIcon className="size-7" />}
                    label="되돌리기"
                    onClick={undo}
                    disabled={!strokes.length}
                  />
                </>
              ) : (
                <>
                  <ToolButton
                    icon={<PencilIcon className="size-7" />}
                    label="멈추고 그리기"
                    onClick={freeze}
                    disabled={!connected}
                  />
                  <ToolButton
                    icon={<FlipCameraIcon className="size-7" />}
                    label="카메라 바꾸기"
                    onClick={() => sendCamera("flip")}
                    disabled={!connected || camPending}
                  />
                </>
              )}
            </div>
            <GuideDpad onSend={sendGuide} disabled={!!frozen || !connected} />
            <div className="flex flex-col gap-2">
              {frozen ? (
                <ToolButton
                  icon={<EraserIcon className="size-7" />}
                  label="지우기"
                  onClick={clearDrawing}
                  disabled={!strokes.length}
                />
              ) : (
                <ToolButton
                  icon={<FlashlightIcon className="size-7" />}
                  label={camState && !camState.torchSupported ? "손전등 없음" : camState?.torch ? "손전등 끄기" : "손전등"}
                  tone={camState?.torch ? "on" : "default"}
                  pressed={camState?.torchSupported ? camState.torch : undefined}
                  onClick={() => sendCamera("torch")}
                  disabled={!connected || camPending || !camState?.torchSupported}
                />
              )}
              <ToolButton tone="danger" icon={<PhoneOffIcon className="size-7" />} label="종료" onClick={requestEnd} />
            </div>
          </div>
          {/* 안내가 사라져도 자리는 남긴다 — 십자키가 엄지 밑에서 움직이지 않게 */}
          <p
            aria-hidden={!(connected && (frozen || !dpadLearned))}
            className={`mt-2 text-center text-caption text-call-text-secondary ${
              connected && (frozen || !dpadLearned) ? "" : "invisible"
            }`}
          >
            {frozen
              ? "멈춘 화면에서는 방향을 알려 줄 수 없어요"
              : "십자키를 누르고 있는 동안 고객님 화면에 방향이 떠요"}
          </p>
        </aside>
        {endSheet(true)}
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
            <Button size="xl" block onClick={start} disabled={starting}>
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

  // 대기(고객 미접속) · 연결 실패: 고객님께 링크를 (다시) 보내는 화면
  const failed = call === "failed";
  return (
    <LightLayout header={header}>
      <div className="flex flex-col gap-2 pt-2">
        {turnText && <CallBanner tone="warning">{turnText}</CallBanner>}
        {peerNotice}
      </div>
      <section className="flex items-center gap-4 py-6" aria-live="polite">
        <WaitingDot tone={failed ? "danger" : peerPresent ? "success" : "brand"} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-title-m" data-testid="eng-wait-title">
            {failed
              ? "연결에 실패했어요"
              : peerPresent
                ? "고객님이 들어왔어요"
                : everConnected
                  ? "고객님을 다시 기다리고 있어요"
                  : "고객님을 기다리고 있어요"}
          </h1>
          <p className="text-body-m text-text-secondary">
            {failed
              ? "고객님께 링크를 다시 열어 달라고 말씀해 주세요."
              : peerPresent
                ? "연결하는 중이에요…"
                : "고객님이 링크를 열고 카메라를 켜면 자동으로 연결돼요."}
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-3xl bg-bg-page p-4 shadow-card ring-1 ring-border">
        <h2 className="text-title-s">고객님께 링크 보내기</h2>
        <ShareButtons joinUrl={joinUrl} />
      </section>

      <details className="group mt-4 rounded-2xl bg-bg-subtle px-4 py-3 text-body-m">
        <summary className="flex min-h-touch cursor-pointer list-none items-center justify-between font-semibold">
          고객님께 이렇게 말씀해 주세요
          <ChevronLeftIcon className="size-5 -rotate-90 text-icon-secondary transition-transform group-open:rotate-90" />
        </summary>
        <p className="pb-1 text-text-secondary">
          &ldquo;문자로 보내 드린 링크를 누르시고, 파란색 <b className="text-text-primary">카메라 켜기</b>를 누른 다음{" "}
          <b className="text-text-primary">허용</b>을 눌러 주세요. 그리고 고장 난 곳을 비춰 주세요.&rdquo;
        </p>
      </details>

      <BottomActions sticky={false}>{endLink}</BottomActions>
      {endSheet(false)}
    </LightLayout>
  );
}

// ───────────── 밝은 화면(준비·대기·해결 여부) 공용 틀 ─────────────

function LightLayout({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]">
      {header}
      {children}
    </main>
  );
}

function RoomHeader({
  createdLabel,
  micOn,
  back = true,
}: {
  createdLabel: string;
  /** null이면 마이크 표시 없음 */
  micOn: boolean | null;
  back?: boolean;
}) {
  return (
    <header className="flex min-h-14 items-center gap-2">
      {back ? (
        <Link
          href="/dashboard"
          className="-ml-2 flex h-touch items-center gap-0.5 rounded-xl pr-3 pl-1 text-body-m text-text-secondary active:bg-bg-muted"
        >
          <ChevronLeftIcon className="size-6" />
          상담 목록
        </Link>
      ) : (
        <span className="text-label-l">원격 A/S</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {micOn !== null && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-label-s ${
              micOn ? "bg-success-tint text-text-success" : "bg-warning-tint text-text-warning"
            }`}
          >
            {micOn ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
            {micOn ? "마이크 켜짐" : "마이크 꺼짐(보기만)"}
          </span>
        )}
        <span className="text-body-s text-text-secondary">{createdLabel}</span>
      </div>
    </header>
  );
}

function BottomActions({ children, sticky = true }: { children: ReactNode; sticky?: boolean }) {
  return (
    <div
      className={`-mx-5 mt-auto flex flex-col gap-2 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] ${
        sticky ? "sticky bottom-0 bg-bg-page/95 backdrop-blur" : ""
      }`}
    >
      {children}
    </div>
  );
}

function FlowStep({ n, active = false, children }: { n: number; active?: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={`grid size-7 flex-none place-items-center rounded-full text-label-m ${
          active ? "bg-primary text-on-primary" : "bg-bg-page text-text-secondary ring-1 ring-border"
        }`}
      >
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

// 기다리는 중: 점 둘레로 고리가 퍼진다
function WaitingDot({ tone }: { tone: "brand" | "success" | "danger" }) {
  const color = tone === "danger" ? "bg-danger" : tone === "success" ? "bg-success" : "bg-primary";
  return (
    <span aria-hidden="true" className="relative grid size-12 flex-none place-items-center">
      {tone !== "danger" && (
        <span className={`motion-decor absolute inset-2 rounded-full ${color} animate-[ripple_1.6s_ease-out_infinite]`} />
      )}
      <span className={`relative size-5 rounded-full ${color}`} />
    </span>
  );
}
