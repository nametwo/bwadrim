"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallState } from "@/lib/webrtc/call";
import { fromRTCDataChannel, type ChannelDataLink } from "@/lib/webrtc/data-link";
import { fetchIceServers } from "@/lib/webrtc/ice";
import { EngineerCallView, type FreezeUsedProps } from "@/components/call/engineer-call-view";
import type { PointerUsedProps } from "@/components/call/usage";
import { endRoom, logFreezeUsed, logPointerUsed, markRoomActive } from "./actions";

type PanelState =
  | { phase: "idle" }
  | { phase: "call"; call: CallState; peerPresent: boolean }
  | { phase: "confirm-end" }; // 종료 후 "원격 해결?" 확인

/** 한 통화에서 보낼 pointer_used 상한 (폭주 방지 — 지표는 이 정도면 충분) */
const MAX_POINTER_EVENTS = 200;

// 엔지니어 통화 패널. 폰 한 손 조작 기준: 버튼 크게, 도구 최소.
// 연결되면 화면 전체를 영상으로 덮는다 (탭 = 핀, 끌기 = 선 → 고객 화면의 같은 사물 위에 표시).
export function CallPanel({ roomId, code }: { roomId: string; code: string }) {
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const [micOn, setMicOn] = useState(false);
  const [ending, setEnding] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // 'draw' DataChannel 링크 — 통화 세션마다 하나, 재연결 때는 새 채널로 attach (객체는 그대로)
  const [link, setLink] = useState<ChannelDataLink | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const linkRef = useRef<ChannelDataLink | null>(null);
  const pointerEvents = useRef(0);

  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      linkRef.current?.dispose();
    };
  }, []);

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
    const dataLink = fromRTCDataChannel(null);
    linkRef.current = dataLink;
    setLink(dataLink);
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
      onRemoteStream: (stream) => setRemoteStream(stream),
      // 고객이 다시 접속하면(새 연결) 새 채널이 온다 → 같은 링크에 갈아 끼운다
      onDataChannel: (dc) => dataLink.attach(dc),
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

  // 지표 — 실패해도 통화를 막지 않는다
  function onPointerUsed(props: PointerUsedProps) {
    if (++pointerEvents.current > MAX_POINTER_EVENTS) return;
    logPointerUsed(roomId, props).catch(() => {});
  }

  function onFreezeUsed(props: FreezeUsedProps) {
    logFreezeUsed(roomId, props).catch(() => {});
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

  if ((call === "connected" || (call === "connecting" && peerPresent)) && link) {
    // 화면 전체: 영상 + 터치 입력, 아래쪽에 버튼 3개 (한 손 조작)
    return (
      <section className="fixed inset-0 z-40 bg-black" aria-label="고객 영상">
        <EngineerCallView
          stream={remoteStream}
          link={link}
          connecting={call !== "connected"}
          micOn={micOn}
          notice={
            turnError ? (
              <span
                title={turnError}
                className="whitespace-nowrap rounded-full bg-amber-400 px-3 py-1.5 text-xs font-semibold text-black shadow-lg"
              >
                ⚠ TURN 없이 연결 중 (모바일망끼리는 끊길 수 있음)
              </span>
            ) : undefined
          }
          onHangup={hangup}
          onPointerUsed={onPointerUsed}
          onFreezeUsed={onFreezeUsed}
        />
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
