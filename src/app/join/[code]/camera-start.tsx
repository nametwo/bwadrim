"use client";

import { useEffect, useRef, useState } from "react";

type Phase = "ready" | "starting" | "preview" | "denied";

// 고객 화면: 한 화면에 한 가지 행동. 큰 버튼 하나 → 카메라.
// getUserMedia는 반드시 버튼 탭(사용자 제스처) 이후 호출 (iOS 정책)
export function CameraStart({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function logEvent(name: "camera_granted" | "camera_denied") {
    // 지표 기록 — 실패해도 진행을 막지 않는다
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name }),
      keepalive: true,
    }).catch(() => {});
  }

  async function start() {
    setPhase("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, // 후면 카메라
        audio: true,
      });
      streamRef.current = stream;
      logEvent("camera_granted");
      setPhase("preview");
    } catch {
      logEvent("camera_denied");
      setPhase("denied");
    }
  }

  useEffect(() => {
    if (phase === "preview" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [phase]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

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

  if (phase === "preview") {
    return (
      <main className="relative flex min-h-screen flex-col bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="relative mt-auto bg-gradient-to-t from-black/70 to-transparent p-6 pb-10 text-center">
          <p className="text-xl font-semibold text-white">
            잘 나오고 있어요!
          </p>
          <p className="mt-1 text-white/70">
            기사님과 곧 연결됩니다. (영상 연결은 다음 업데이트)
          </p>
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
