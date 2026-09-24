"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallState } from "@/lib/webrtc/call";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { endRoom, markRoomActive } from "./actions";

type PanelState =
  | { phase: "idle" }
  | { phase: "call"; call: CallState; peerPresent: boolean }
  // 종료 후 확인. by: 누가 끝냈는지
  | { phase: "confirm-end"; by: "engineer" | "customer" };

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

  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
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
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = mic;
      setMicOn(true);
    } catch {
      // 마이크 거부/없음 — 영상 보기만이라도 진행
      setMicOn(false);
    }

    const ice = await fetchIceServers(code);
    setTurnError(ice.turnError);
    const session = new CallSession({
      roomId,
      role: "engineer",
      iceServers: ice.iceServers,
      localStream: mic,
      onState: (call) => {
        if (call === "connected") {
          setEverConnected(true);
          setConfirmClose(false);
          markRoomActive(roomId);
        }
        setState((prev) => {
          if (prev.phase === "confirm-end") {
            // 고객이 종료한 뒤 링크를 다시 열고 들어오면 통화로 돌아간다
            return prev.by === "customer" &&
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
  }

  // 통화를 끊고 '출장 없이 해결됐나요?'로
  function endCall() {
    sessionRef.current?.hangup();
    stopSession();
    setConfirmClose(false);
    setState({ phase: "confirm-end", by: "engineer" });
  }

  // 연결된 적 있으면 해결 여부를 묻고, 없으면 닫을지만 확인한다
  function requestEnd() {
    if (everConnected) endCall();
    else setConfirmClose(true);
  }

  async function finish(resolvedRemotely: boolean | null) {
    stopSession();
    setEnding(true);
    setSaveError(false);
    try {
      await endRoom(roomId, resolvedRemotely); // 성공 시 대시보드로 redirect
    } catch {
      setEnding(false);
      setSaveError(true);
    }
  }

  // 한 번도 연결되지 않은 세션 닫기. 기다리던 고객 화면도 '상담이 끝났습니다'로 바뀐다
  function closeSession() {
    sessionRef.current?.hangup();
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
          className="mx-auto mt-2 px-4 py-2 text-sm text-gray-500 underline"
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
        <div className="relative flex-1 overflow-hidden rounded-2xl bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full object-contain"
          />
          {call !== "connected" && (
            <p className="absolute inset-0 flex items-center justify-center text-white/70">
              연결 중…
            </p>
          )}
        </div>
        {confirmClose ? (
          closeConfirm
        ) : (
          <div className="flex items-center gap-3">
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
