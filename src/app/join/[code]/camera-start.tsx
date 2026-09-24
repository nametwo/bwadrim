"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallState } from "@/lib/webrtc/call";
import { fromRTCDataChannel, type ChannelDataLink } from "@/lib/webrtc/data-link";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { CustomerCallView } from "@/components/call/customer-call-view";
import type { AnchorOutcome } from "@/components/call/usage";

type Phase = "ready" | "starting" | "call" | "denied";

/** 한 통화에서 보낼 추적 결과 요약 상한 (폭주 방지) */
const MAX_OUTCOME_EVENTS = 100;

// 고객 화면: 한 화면에 한 가지 행동. 큰 버튼 하나 → 카메라 → 자동 연결.
// getUserMedia는 반드시 버튼 탭(사용자 제스처) 이후 호출 (iOS 정책)
// 기사님이 영상에 표시하면 내 화면의 같은 사물 위에 자동으로 보인다 (고객은 누를 것 없음).
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
  // 미리보기 스트림 (카메라 전환 때 바뀐다 — 추적 세션은 같은 <video>로 계속)
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [link, setLink] = useState<ChannelDataLink | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const linkRef = useRef<ChannelDataLink | null>(null);
  const outcomeEvents = useRef(0);

  function postEvent(name: string, props: Record<string, unknown> = {}) {
    // 지표 기록 — 실패해도 진행을 막지 않는다 (keepalive: 페이지를 닫는 중에도 전송)
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name, props }),
      keepalive: true,
    }).catch(() => {});
  }

  async function start() {
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, // 후면 카메라
        audio: true,
      });
    } catch {
      postEvent("camera_denied");
      setPhase("denied");
      return;
    }
    streamRef.current = stream;
    setPreview(stream);
    postEvent("camera_granted");

    const ice = await fetchIceServers(code);
    const dataLink = fromRTCDataChannel(null);
    linkRef.current = dataLink;
    setLink(dataLink);
    const session = new CallSession({
      roomId,
      role: "customer",
      iceServers: ice.iceServers,
      localStream: stream,
      onState: (s) => {
        setCallState(s);
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
        }
      },
      onRemoteStream: (remote) => {
        // 기사님 음성
        remoteStreamRef.current = remote;
        if (audioRef.current) audioRef.current.srcObject = remote;
      },
      // offer마다 새 'draw' 채널 → 같은 링크에 갈아 끼운다 (재연결)
      onDataChannel: (dc) => dataLink.attach(dc),
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
      setPreview(merged);
      setFacing(next);
    } catch {
      // 전환 실패(전면 카메라 없음 등) — 현 카메라 유지
    }
  }

  function hangup() {
    sessionRef.current?.hangup();
  }

  // 기사님 표시 하나가 끝날 때마다 추적 결과 요약 (찾기까지 걸린 시간, 보인 비율 등)
  // 이벤트 이름은 고정 목록의 pointer_used (actor=customer, props.side="customer")
  function onOutcome(o: AnchorOutcome) {
    if (++outcomeEvents.current > MAX_OUTCOME_EVENTS) return;
    postEvent("pointer_used", { ...o });
  }

  // 기사님 음성 연결 (통화 화면이 뜬 뒤)
  useEffect(() => {
    if (phase === "call" && audioRef.current && remoteStreamRef.current) {
      audioRef.current.srcObject = remoteStreamRef.current;
    }
  }, [phase]);

  // 언마운트 정리
  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      linkRef.current?.dispose();
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
      callState === "connected"
        ? "기사님이 보고 있어요"
        : callState === "connecting"
          ? "기사님과 연결 중…"
          : "기사님을 기다리는 중…";

    return (
      <main className="fixed inset-0 bg-black">
        {link && (
          <CustomerCallView
            stream={preview}
            link={link}
            statusText={statusText}
            connected={callState === "connected"}
            onFlip={flipCamera}
            onHangup={hangup}
            onOutcome={onOutcome}
          />
        )}
        <audio ref={audioRef} autoPlay />
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
