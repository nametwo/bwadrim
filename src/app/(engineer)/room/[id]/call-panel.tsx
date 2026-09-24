"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallState } from "@/lib/webrtc/call";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { endRoom, markRoomActive } from "./actions";

type PanelState =
  | { phase: "idle" }
  | { phase: "call"; call: CallState; peerPresent: boolean }
  | { phase: "confirm-end" }; // 종료 후 "원격 해결?" 확인

// 엔지니어 통화 패널. 폰 한 손 조작 기준: 버튼 크게, 도구 최소.
export function CallPanel({ roomId, code }: { roomId: string; code: string }) {
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const [micOn, setMicOn] = useState(false);
  const [ending, setEnding] = useState(false);
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
        setState((prev) => ({
          phase: "call",
          call,
          peerPresent: prev.phase === "call" ? prev.peerPresent : false,
        }));
        if (call === "connected") markRoomActive(roomId);
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
  }

  function hangup() {
    sessionRef.current?.hangup();
    setState({ phase: "confirm-end" });
  }

  async function finish(resolvedRemotely: boolean) {
    setEnding(true);
    try {
      await endRoom(roomId, resolvedRemotely); // 성공 시 대시보드로 redirect
    } catch {
      setEnding(false);
    }
  }

  if (state.phase === "idle") {
    return (
      <section className="mt-auto flex flex-col gap-2 py-4">
        <button
          onClick={start}
          className="h-16 w-full rounded-2xl bg-blue-600 text-xl font-semibold text-white active:opacity-80"
        >
          🎤 연결 준비
        </button>
        <p className="text-center text-sm text-gray-400">
          누르면 마이크가 켜지고, 고객님이 접속하면 자동으로 연결됩니다.
        </p>
      </section>
    );
  }

  if (state.phase === "confirm-end") {
    return (
      <section className="mt-auto flex flex-col gap-3 py-4">
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
        <div className="flex items-center gap-3">
          {!micOn && (
            <span className="text-sm text-amber-600">마이크 꺼짐(보기만)</span>
          )}
          <button
            onClick={hangup}
            className="ml-auto h-14 rounded-xl bg-red-600 px-8 text-lg font-semibold text-white active:opacity-80"
          >
            종료
          </button>
        </div>
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
        <button
          onClick={hangup}
          className="mt-2 h-12 rounded-xl border border-gray-300 px-6 text-gray-700"
        >
          세션 종료
        </button>
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
    </section>
  );
}
