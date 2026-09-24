"use client";

import { useEffect, useRef, useState } from "react";
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
import { PointerMarker, usePointerMarker } from "@/components/pointer-marker";
import { FreezeCanvas, type DrawHandlers } from "@/components/freeze-canvas";
import { endRoom, logToolUsed, markRoomActive } from "./actions";

type PanelState =
  | { phase: "idle" }
  | { phase: "call"; call: CallState; peerPresent: boolean }
  // 종료 후 확인. by: 누가 끝냈는지
  | { phase: "confirm-end"; by: "engineer" | "customer" };

// 확인 화면이 뜬 직후의 탭은 무시한다. 종료 버튼을 두 번 누르면 두 번째 탭이
// 같은 자리에 뜬 답 버튼('아니요, 출장 필요')에 떨어져 핵심 지표가 잘못 저장된다
const CONFIRM_ARM_MS = 600;

// 엔지니어 통화 패널. 폰 한 손 조작 기준: 버튼 크게, 도구 최소.
export function CallPanel({
  roomId,
  code,
  everConnected: initialEverConnected,
}: {
  roomId: string;
  code: string;
  // 이미 '연결됨'인 세션인지. 한 번도 연결 안 된 세션은 원격 해결 여부를 묻지 않는다
  everConnected: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const [everConnected, setEverConnected] = useState(initialEverConnected);
  const [micOn, setMicOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [ending, setEnding] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
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
  const toolsLoggedRef = useRef(new Set<"pointer_used" | "freeze_used">());
  // 화면 멈춤 + 그리기 (CALL-09)
  const [frozen, setFrozen] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [freezeError, setFreezeError] = useState(false);
  const strokeRef = useRef<{ id: string; pending: Point[] } | null>(null);
  const flushFrameRef = useRef<number | null>(null);
  const { marker, show: showMarker } = usePointerMarker();

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
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
    const ice = await fetchIceServers(code);
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
      localStream: mic,
      onState: (call) => {
        lastCallRef.current = call;
        // 연결이 바뀌면 고객 쪽 정지 화면도 사라지므로 이쪽도 풀어 둔다
        if (call !== "connected") {
          setFrozen(null);
          setStrokes([]);
        }
        if (call === "connected") {
          setEverConnected(true);
          setConfirmClose(false);
          markRoomActive(roomId);
        }
        if (call === "ended") {
          // 고객이 끊으면 열려 있던 '세션을 닫을까요?'는 확인 화면으로 대체된다
          confirmShownAtRef.current = Date.now();
          setSaveError(false);
          setConfirmClose(false);
        }
        if (call === "connecting") setSaveError(false);
        setState((prev) => {
          if (prev.phase === "confirm-end") {
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
      onRemoteStream: (stream) => {
        remoteStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      },
      onPeerPresent: (present) => {
        setState((prev) =>
          prev.phase === "call" ? { ...prev, peerPresent: present } : prev,
        );
      },
    });
    sessionRef.current = session;
    session.join();
    setState({ phase: "call", call: "waiting", peerPresent: false });
    setStarting(false);
  }

  function stopSession() {
    sessionRef.current?.destroy();
    sessionRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    releaseWakeLockRef.current?.();
    releaseWakeLockRef.current = null;
  }

  // 영상을 탭한 곳을 고객 화면에 표시한다. 영상 밖 검은 여백은 무시
  function pointAt(e: React.PointerEvent<HTMLDivElement>) {
    const video = videoRef.current;
    const session = sessionRef.current;
    if (!video || !session || lastCallRef.current !== "connected") return;
    const rect = video.getBoundingClientRect();
    const pos = toVideoPos(video, e.clientX - rect.left, e.clientY - rect.top);
    if (!pos) return;
    session.sendPointer(pos);
    showMarker(video, pos);
    logToolOnce("pointer_used");
  }

  function logToolOnce(name: "pointer_used" | "freeze_used") {
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
  // 세션이 없어도(연결 준비 전, 새로고침 후) 기다리던 고객 화면이 '상담이 끝났습니다'로 바뀌어야 한다
  function hangupAndStop() {
    if (sessionRef.current) sessionRef.current.hangup();
    else sendBye(roomId, "engineer").catch(() => {});
    stopSession();
  }

  function showConfirm() {
    confirmShownAtRef.current = Date.now();
    setSaveError(false);
  }

  function justShown() {
    return Date.now() - confirmShownAtRef.current < CONFIRM_ARM_MS;
  }

  // 통화를 끊고 '출장 없이 해결됐나요?'로
  function endCall() {
    hangupAndStop();
    showConfirm();
    setConfirmClose(false);
    setState({ phase: "confirm-end", by: "engineer" });
  }

  // 연결된 적 있으면 해결 여부를 묻고, 없으면 닫을지만 확인한다
  function requestEnd() {
    if (everConnected) {
      endCall();
    } else {
      showConfirm();
      setConfirmClose(true);
    }
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

  // 한 번도 연결되지 않은 세션 닫기. 고객에게 이미 알렸으므로 되돌릴 수 없고,
  // 저장이 실패하면 확인 화면에서 다시 누르게 한다
  function closeSession() {
    if (justShown()) return;
    hangupAndStop();
    setConfirmClose(false);
    setState({ phase: "confirm-end", by: "engineer" });
    confirmShownAtRef.current = 0; // 방금 확인한 결정이므로 대기 없이 저장
    finish(null);
  }

  const saveErrorText = saveError && (
    <p role="alert" className="text-center text-sm text-red-600">
      저장에 실패했어요. 다시 눌러주세요.
    </p>
  );

  const closeConfirm = (
    <div className="flex w-full flex-col gap-2">
      <p className="text-center font-semibold">세션을 닫을까요?</p>
      <p className="text-center text-sm text-gray-500">
        고객님께 보낸 링크도 더 이상 열리지 않아요.
      </p>
      <button
        onClick={closeSession}
        disabled={ending}
        className="h-12 w-full rounded-xl bg-gray-800 font-semibold text-white disabled:opacity-50"
      >
        네, 닫기
      </button>
      <button
        onClick={() => setConfirmClose(false)}
        disabled={ending}
        className="h-12 w-full rounded-xl border border-gray-300 text-gray-700 disabled:opacity-50"
      >
        취소
      </button>
      {saveErrorText}
    </div>
  );

  const endLabel = everConnected ? "통화 종료" : "세션 닫기";

  if (state.phase === "idle") {
    if (confirmClose) {
      return <section className="mt-auto py-4">{closeConfirm}</section>;
    }
    return (
      <section className="mt-auto flex flex-col gap-2 py-4">
        <button
          onClick={start}
          disabled={starting}
          className="h-16 w-full rounded-2xl bg-blue-600 text-xl font-semibold text-white active:opacity-80 disabled:opacity-50"
        >
          {starting ? "준비 중…" : "🎤 연결 준비"}
        </button>
        <p className="text-center text-sm text-gray-400">
          누르면 마이크가 켜지고, 고객님이 접속하면 자동으로 연결됩니다.
        </p>
        <button
          onClick={requestEnd}
          disabled={starting}
          className="mx-auto mt-2 px-4 py-2 text-sm text-gray-500 underline disabled:opacity-40"
        >
          {endLabel}
        </button>
      </section>
    );
  }

  if (state.phase === "confirm-end") {
    const byCustomer = state.by === "customer";
    return (
      <section className="mt-auto flex flex-col gap-3 py-4">
        {byCustomer && (
          <p className="text-center text-base font-semibold text-gray-700">
            고객님이 통화를 종료했어요
          </p>
        )}
        {everConnected ? (
          <>
            <p className="text-center text-lg font-semibold">
              출장 없이 해결됐나요?
            </p>
            <button
              onClick={() => finish(true)}
              disabled={ending}
              className="h-14 w-full rounded-xl bg-green-600 text-lg font-semibold text-white disabled:opacity-50"
            >
              네, 원격으로 해결
            </button>
            <button
              onClick={() => finish(false)}
              disabled={ending}
              className="h-14 w-full rounded-xl border border-gray-300 text-lg font-medium text-gray-700 disabled:opacity-50"
            >
              아니요, 출장 필요
            </button>
          </>
        ) : (
          <>
            <p className="text-center text-sm text-gray-500">
              고객님과 연결되지 않은 세션이에요.
            </p>
            <button
              onClick={() => finish(null)}
              disabled={ending}
              className="h-14 w-full rounded-xl bg-gray-800 text-lg font-semibold text-white disabled:opacity-50"
            >
              세션 닫기
            </button>
          </>
        )}
        {byCustomer && (
          <p className="text-center text-sm text-gray-400">
            고객님이 링크를 다시 열면 통화로 돌아갑니다.
          </p>
        )}
        {saveErrorText}
      </section>
    );
  }

  const { call, peerPresent } = state;

  // TURN 없이 STUN만으로 동작 중 — 모바일망(5G/LTE)끼리는 연결이 실패할 수 있다
  const turnWarning = turnError && (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
      ⚠ TURN 서버 없이 연결 중 — 모바일망끼리는 실패할 수 있어요 ({turnError})
    </p>
  );

  if (call === "connected" || (call === "connecting" && peerPresent)) {
    return (
      <section className="mt-2 flex flex-1 flex-col gap-3">
        {turnWarning}
        <div
          onPointerDown={frozen ? undefined : pointAt}
          className="relative min-h-[50vh] flex-1 touch-none overflow-hidden rounded-2xl bg-black"
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="absolute inset-0 h-full w-full object-contain"
          />
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
          {call !== "connected" && (
            <p className="absolute inset-0 flex items-center justify-center text-white/70">
              연결 중…
            </p>
          )}
        </div>
        {call === "connected" && (
          <p className="text-center text-sm text-gray-400">
            {frozen
              ? "손가락으로 그리면 고객님 화면에도 보여요"
              : "영상을 누르면 고객님 화면에 빨간 동그라미가 표시돼요"}
          </p>
        )}
        {freezeError && !frozen && (
          <p role="alert" className="text-center text-sm text-red-600">
            연결이 불안정해 화면을 멈추지 못했어요. 다시 눌러주세요.
          </p>
        )}
        {confirmClose ? (
          closeConfirm
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {call === "connected" &&
              (frozen ? (
                <>
                  <button
                    onClick={resume}
                    className="h-14 rounded-xl bg-blue-600 px-4 text-base font-semibold text-white active:opacity-80"
                  >
                    ▶ 다시 보기
                  </button>
                  <button
                    onClick={undo}
                    disabled={!strokes.length}
                    className="h-14 rounded-xl border border-gray-300 px-3 text-base text-gray-700 disabled:opacity-40"
                  >
                    ↶ 되돌리기
                  </button>
                  <button
                    onClick={clearDrawing}
                    disabled={!strokes.length}
                    className="h-14 rounded-xl border border-gray-300 px-3 text-base text-gray-700 disabled:opacity-40"
                  >
                    지우기
                  </button>
                </>
              ) : (
                <button
                  onClick={freeze}
                  className="h-14 rounded-xl bg-gray-800 px-4 text-base font-semibold text-white active:opacity-80"
                >
                  ⏸ 멈추고 그리기
                </button>
              ))}
            {!micOn && (
              <span className="text-sm text-amber-600">
                마이크 꺼짐(보기만)
              </span>
            )}
            <button
              onClick={requestEnd}
              className="ml-auto h-14 rounded-xl bg-red-600 px-8 text-lg font-semibold text-white active:opacity-80"
            >
              종료
            </button>
          </div>
        )}
      </section>
    );
  }

  if (call === "failed") {
    return (
      <section className="mt-auto flex flex-col items-center gap-3 py-6 text-center">
        {turnWarning}
        <p className="text-lg font-semibold text-red-600">연결에 실패했어요</p>
        <p className="text-sm text-gray-500">
          고객님께 링크를 다시 열어달라고 말씀해 주세요.
        </p>
        {confirmClose ? (
          closeConfirm
        ) : (
          <button
            onClick={requestEnd}
            className="mt-2 h-12 rounded-xl border border-gray-300 px-6 text-gray-700"
          >
            {endLabel}
          </button>
        )}
      </section>
    );
  }

  // waiting / connecting(고객 미접속)
  return (
    <section className="mt-auto flex flex-col items-center gap-2 py-6 text-center">
      {turnWarning}
      <p className="text-lg font-semibold">
        {peerPresent ? "고객님 접속됨 — 연결 중…" : "고객님 접속 대기 중…"}
      </p>
      <p className="text-sm text-gray-400">
        {micOn ? "마이크 켜짐" : "마이크 꺼짐(보기만)"} · 링크를 보냈다면
        잠시만 기다려 주세요.
      </p>
      {confirmClose ? (
        closeConfirm
      ) : (
        <button
          onClick={requestEnd}
          className="mt-2 h-12 rounded-xl border border-gray-300 px-6 text-gray-700"
        >
          {endLabel}
        </button>
      )}
    </section>
  );
}
