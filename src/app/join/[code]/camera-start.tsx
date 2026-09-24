"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallState } from "@/lib/webrtc/call";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { keepScreenOn } from "@/lib/wake-lock";
import { PointerMarker, usePointerMarker } from "@/components/pointer-marker";
import { FreezeCanvas } from "@/components/freeze-canvas";
import { applyDrawCommand, type Stroke } from "@/lib/webrtc/draw";

type Phase = "ready" | "starting" | "call" | "denied" | "gone";

// 고객 화면: 한 화면에 한 가지 행동. 큰 버튼 하나 → 카메라 → 자동 연결.
// getUserMedia는 반드시 버튼 탭(사용자 제스처) 이후 호출 (iOS 정책)
export function CameraStart({
  roomId,
  code,
}: {
  roomId: string;
  code: string;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [callState, setCallState] = useState<CallState>("waiting");
  const [facing, setFacing] = useState<"environment" | "user">("environment");

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const releaseWakeLockRef = useRef<(() => void) | null>(null);
  const { marker, show: showMarker } = usePointerMarker();
  // 기사님이 멈춘 화면과 그 위의 선 (CALL-09)
  const [frozen, setFrozen] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);

  function releaseWakeLock() {
    releaseWakeLockRef.current?.();
    releaseWakeLockRef.current = null;
  }

  function postEvent(name: string, props: Record<string, unknown> = {}) {
    // 지표 기록 — 실패해도 진행을 막지 않는다
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name, props }),
      keepalive: true,
    }).catch(() => {});
  }

  async function start() {
    setPhase("starting");
    // 폰을 비추기만 하고 화면을 안 건드려서 자동 잠금으로 끊기기 쉽다 — 버튼 탭 안에서 요청
    releaseWakeLock();
    releaseWakeLockRef.current = keepScreenOn();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, // 후면 카메라
        audio: true,
      });
    } catch {
      postEvent("camera_denied");
      releaseWakeLock();
      setPhase("denied");
      return;
    }
    streamRef.current = stream;
    postEvent("camera_granted");

    const ice = await fetchIceServers(code);
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
      localStream: stream,
      onState: (s) => {
        setCallState(s);
        if (s !== "connected") {
          setFrozen(null);
          setStrokes([]);
        }
        if (s === "connected") {
          // relay(TURN) 경유 여부 — 원가 지표. turn: TURN 자격증명을 받았는지
          setTimeout(async () => {
            const relay = (await sessionRef.current?.usedRelay()) ?? false;
            postEvent("connected", { relay, turn: !ice.turnError });
            if (relay) postEvent("relay_used");
          }, 1000);
        }
        if (s === "ended" || s === "failed") {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          releaseWakeLock();
        }
      },
      onPointer: (pos) => showMarker(videoRef.current, pos),
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
    session.join();
    setPhase("call");
  }

  // 카메라 전/후면 전환 (replaceTrack — 재협상 불필요)
  async function flipCamera() {
    const next = facing === "environment" ? "user" : "environment";
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      await sessionRef.current?.replaceVideoTrack(newTrack);

      const old = streamRef.current;
      old?.getVideoTracks().forEach((t) => t.stop());
      const merged = new MediaStream([
        newTrack,
        ...(old?.getAudioTracks() ?? []),
      ]);
      streamRef.current = merged;
      if (videoRef.current) videoRef.current.srcObject = merged;
      setFacing(next);
    } catch {
      // 전환 실패(전면 카메라 없음 등) — 현 카메라 유지
    }
  }

  function hangup() {
    sessionRef.current?.hangup();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    releaseWakeLock();
    setCallState("ended");
  }

  // 로컬 미리보기 연결
  useEffect(() => {
    if (phase === "call" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
    if (phase === "call" && audioRef.current && remoteStreamRef.current) {
      audioRef.current.srcObject = remoteStreamRef.current;
    }
  }, [phase]);

  // 언마운트 정리
  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      releaseWakeLockRef.current?.();
    };
  }, []);

  if (phase === "gone") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
        <h1 className="text-2xl font-bold">종료된 연결이에요</h1>
        <p className="text-lg text-gray-600">
          기사님께 새 링크를 보내달라고 말씀해 주세요.
        </p>
      </main>
    );
  }

  if (phase === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-8 text-center">
        <h1 className="text-2xl font-bold">카메라를 켤 수 없어요</h1>
        <p className="text-lg text-gray-600">
          화면에 <b>&ldquo;허용&rdquo;</b> 창이 뜨면 눌러주세요.
          <br />
          창이 안 뜨면 화면을 새로고침한 뒤
          <br />
          다시 시도해 주세요.
        </p>
        <button
          onClick={start}
          className="mt-2 h-16 w-full max-w-xs rounded-2xl bg-black text-xl font-bold text-white"
        >
          다시 시도
        </button>
      </main>
    );
  }

  if (phase === "call") {
    if (callState === "ended") {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
          <h1 className="text-3xl font-bold">상담이 끝났습니다</h1>
          <p className="text-lg text-gray-600">이용해 주셔서 감사합니다.</p>
        </main>
      );
    }

    if (callState === "failed") {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-8 text-center">
          <h1 className="text-2xl font-bold">연결이 끊겼어요</h1>
          <p className="text-lg text-gray-600">
            아래 버튼을 눌러 다시 연결해 주세요.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="h-16 w-full max-w-xs rounded-2xl bg-black text-xl font-bold text-white"
          >
            다시 연결
          </button>
        </main>
      );
    }

    const statusText =
      frozen
        ? "기사님이 화면을 멈추고 설명 중이에요"
        : callState === "connected"
        ? "기사님이 보고 있어요"
        : callState === "connecting"
          ? "기사님과 연결 중…"
          : "기사님을 기다리는 중…";

    return (
      <main className="relative flex min-h-screen flex-col bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-contain"
        />
        {/* 잘림 없이 전체를 보여 줘야 기사님이 가리킨 곳이 항상 화면 안에 있다 */}
        {frozen ? (
          <FreezeCanvas image={frozen} strokes={strokes} lineWidth={8} />
        ) : (
          <PointerMarker marker={marker} size={88} />
        )}
        <audio ref={audioRef} autoPlay />

        <div className="relative mt-4 flex justify-center">
          <span
            className={`rounded-full px-4 py-2 text-sm font-medium text-white ${
              frozen
                ? "bg-amber-500/90"
                : callState === "connected"
                  ? "bg-green-600/90"
                  : "bg-black/50"
            }`}
          >
            {statusText}
          </span>
        </div>

        <div className="relative mt-auto flex items-center justify-center gap-4 bg-gradient-to-t from-black/70 to-transparent p-6 pb-10">
          <button
            onClick={flipCamera}
            className="h-16 w-16 rounded-full bg-white/20 text-2xl text-white active:bg-white/40"
            aria-label="카메라 전환"
          >
            🔄
          </button>
          <button
            onClick={hangup}
            className="h-16 rounded-full bg-red-600 px-10 text-lg font-bold text-white active:opacity-80"
          >
            종료
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-8 text-center">
      <h1 className="text-3xl font-bold">봐드림</h1>
      <p className="text-xl text-gray-700">
        아래 버튼을 누르고
        <br />
        <b>&ldquo;허용&rdquo;</b>을 눌러주세요.
      </p>
      <button
        onClick={start}
        disabled={phase === "starting"}
        className="h-20 w-full max-w-xs rounded-2xl bg-black text-2xl font-bold text-white active:opacity-80 disabled:opacity-50"
      >
        {phase === "starting" ? "카메라 켜는 중…" : "📷 카메라 켜기"}
      </button>
      <p className="text-gray-400">
        기사님이 화면을 보고 도와드립니다.
      </p>
    </main>
  );
}
