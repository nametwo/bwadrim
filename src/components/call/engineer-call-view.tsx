"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DataLink } from "@/lib/webrtc/data-link";
import type { TrackState } from "@/lib/tracking/types";
import {
  EMPTY_ENGINEER_SNAPSHOT,
  EngineerAnchorSession,
  type EngineerSessionOptions,
  type EngineerSnapshot,
} from "@/lib/tracking/session";
import { AnchorOverlay } from "@/components/anchor-overlay";
import { SessionHolder } from "./session-holder";
import { PointerUsageTracker, engineerChip, type ChipTone, type PointerUsedProps } from "./usage";
import { AnnotatedPhoto } from "./annotated-photo";
import { EraseIcon, HangupIcon, MicOffIcon, PauseIcon, PlayIcon, TapIcon } from "./icons";

// 엔지니어 통화 화면 (연결됨). 폰 한 손 조작 기준:
//  - 화면 전체가 영상 + 터치 입력 (탭 = 핀, 끌기 = 선). 버튼은 아래쪽 엄지 영역에 3개뿐 (지우기·정지/재생·종료)
//  - 위쪽엔 읽기 전용 정보만: 고객 화면 상태칩, 정지·마이크 표시, 고객에게 카드가 보이는 동안 그 카드 미리보기
//  - 첫 주석 전까지 "화면을 탭하면 고객 화면에 표시돼요" 안내, 무늬가 적어 고정이 어려우면 토스트
// 부모 크기를 가득 채운다 (통화 패널은 fixed inset-0로 감싸고, 실험실은 폰 크기 상자에 넣는다).
// 미디어·추적 로직은 세션(src/lib/tracking/session)에 있고, 여기선 화면만 그린다.

export interface FreezeUsedProps {
  /** 정지 순간 주석이 있었나 */
  hasAnchor: boolean;
  customerState: TrackState | null;
}

export interface EngineerCallViewProps {
  /** 고객 영상 (원격 스트림). 소리도 함께 재생한다 */
  stream: MediaStream | null;
  /** 'draw' DataChannel 링크 */
  link: DataLink;
  /** 아직 미디어 연결 전 (고객은 접속함) */
  connecting?: boolean;
  micOn?: boolean;
  /** 오른쪽 위 정보 칸에 띄울 짧은 경고 (예: TURN 없이 연결 중). 영상을 가리지 않게 한 줄로 */
  notice?: ReactNode;
  onHangup(): void;
  /** 주석이 확정될 때마다 (지표 pointer_used) */
  onPointerUsed?(props: PointerUsedProps): void;
  /** 정지 화면을 켤 때 (지표 freeze_used) */
  onFreezeUsed?(props: FreezeUsedProps): void;
  /** 세션 옵션 추가 (실험실 계측용). 세션을 만들 때 한 번 읽는다 */
  sessionOptions?: Partial<Omit<EngineerSessionOptions, "video" | "link" | "fit">>;
  /** 세션 생성·파괴 알림 (실험실 진단용) */
  onSession?(session: EngineerAnchorSession | null): void;
  className?: string;
}

/** 무늬 부족 토스트 표시 시간 (ms) */
const TOAST_MS = 6000;
/** 캡처한 카드 미리보기 긴 변 (px) */
const PREVIEW_LONG_SIDE = 480;

const TONE_DOT: Record<ChipTone, string> = {
  ok: "bg-green-400",
  wait: "bg-amber-300",
  bad: "bg-red-500",
  guide: "bg-sky-400",
};

interface ViewState {
  anchor: EngineerSnapshot["anchor"];
  customerState: EngineerSnapshot["customerState"];
  customerArrow: boolean;
  customerReason: EngineerSnapshot["customerReason"];
  trackable: boolean | null;
  frozen: boolean;
}

function selectView(s: EngineerSnapshot): ViewState {
  return {
    anchor: s.anchor,
    customerState: s.customerState,
    customerArrow: s.customerArrow,
    customerReason: s.customerReason,
    trackable: s.trackable,
    frozen: s.frozen,
  };
}

/** 누른 순간의 영상 프레임 (엔지니어 쪽 "고객 카드" 미리보기용) */
interface Grab {
  t: number;
  canvas: HTMLCanvasElement;
}

function grabFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (video.readyState < 2 || !(vw > 0) || !(vh > 0)) return null;
  const k = Math.min(1, PREVIEW_LONG_SIDE / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(vw * k));
  c.height = Math.max(1, Math.round(vh * k));
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, c.width, c.height);
  } catch {
    return null;
  }
  return c;
}

export function EngineerCallView({
  stream,
  link,
  connecting = false,
  micOn = true,
  notice,
  onHangup,
  onPointerUsed,
  onFreezeUsed,
  sessionOptions,
  onSession,
  className,
}: EngineerCallViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [holder] = useState(
    () => new SessionHolder<EngineerAnchorSession, EngineerSnapshot>(EMPTY_ENGINEER_SNAPSHOT),
  );
  const [view] = useState(() => holder.selector(selectView));
  const [getUpdate] = useState(() => () => holder.current()?.latestUpdate() ?? null);
  const snap = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot);
  const [annotatedOnce, setAnnotatedOnce] = useState(false);
  const [toastDismissed, setToastDismissed] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ anchorId: string; url: string } | null>(null);
  const cb = useRef({ onPointerUsed, onFreezeUsed, onSession, sessionOptions });

  useEffect(() => {
    cb.current = { onPointerUsed, onFreezeUsed, onSession, sessionOptions };
  });

  // 세션: <video>가 있어야 만들 수 있다. 링크가 바뀌면 새로
  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;
    const s = new EngineerAnchorSession({ ...cb.current.sessionOptions, video, link, fit: "contain" });
    const offPointer = s.attachPointerInput(stage, "contain");
    // 화면이 다시 만들어진 경우(재연결 등) 고객 화면에 남은 이전 주석을 지운다
    if (link.isOpen()) s.clear();

    const usage = new PointerUsageTracker();
    const emit = (list: PointerUsedProps[]) => {
      for (const p of list) {
        setAnnotatedOnce(true);
        try {
          cb.current.onPointerUsed?.(p);
        } catch (e) {
          console.warn("[engineer-call] onPointerUsed 오류:", e);
        }
      }
    };

    // 카드 미리보기: 누른 순간의 프레임 = 새 앵커의 기준 프레임 (세션 리스너보다 먼저, capture 단계)
    let grab: Grab | null = null;
    let lastAnchorId: string | null = null;
    let previewUrl: string | null = null;
    let disposed = false;
    const onDown = (ev: PointerEvent) => {
      if (!ev.isPrimary) return;
      const target = ev.target as Element | null;
      if (target && target !== stage && target.closest?.("button, a, input, [data-anchor-ignore]")) return;
      const c = grabFrame(video);
      grab = c ? { t: performance.now(), canvas: c } : null;
    };
    stage.addEventListener("pointerdown", onDown, { capture: true });
    const onSnapshot = () => {
      const snapNow = s.getSnapshot();
      emit(usage.observe(snapNow, performance.now()));
      const id = snapNow.anchor?.id ?? null;
      if (id && id !== lastAnchorId && grab && performance.now() - grab.t < 2000) {
        const canvas = grab.canvas;
        grab = null;
        canvas.toBlob(
          (blob) => {
            if (!blob || disposed) return;
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            previewUrl = URL.createObjectURL(blob);
            setPreview({ anchorId: id, url: previewUrl });
          },
          "image/jpeg",
          0.8,
        );
      }
      lastAnchorId = id;
    };
    const offSnap = s.subscribe(onSnapshot);
    // trackable 대기 중인 이벤트의 시간 초과 처리
    const timer = setInterval(() => emit(usage.observe(s.getSnapshot(), performance.now())), 500);

    holder.set(s);
    cb.current.onSession?.(s);
    return () => {
      disposed = true;
      clearInterval(timer);
      offSnap();
      stage.removeEventListener("pointerdown", onDown, { capture: true });
      emit(usage.flush());
      offPointer();
      holder.set(null);
      cb.current.onSession?.(null);
      s.destroy();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [holder, link]);

  // 원격 스트림 연결. 영상은 음소거하고 소리는 <audio>로 → 정지 화면(video.pause) 중에도 고객 목소리는 들린다
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (v && v.srcObject !== stream) {
      v.srcObject = stream;
      const s = holder.current();
      if (s?.getSnapshot().frozen) s.setFrozen(false); // 새 스트림은 재생 상태로 시작
    }
    if (a && a.srcObject !== stream) a.srcObject = stream;
  }, [stream, holder]);

  const hasCommitted = !!snap.anchor && snap.anchor.annotations.some((a) => a.id !== "draft");
  const untrackableId = snap.trackable === false && hasCommitted && snap.anchor ? snap.anchor.id : null;

  // 무늬 부족 토스트는 앵커마다 한 번, 잠시 뒤 사라진다
  useEffect(() => {
    if (!untrackableId) return;
    const t = setTimeout(() => setToastDismissed(untrackableId), TOAST_MS);
    return () => clearTimeout(t);
  }, [untrackableId]);

  function clear() {
    holder.current()?.clear();
  }

  function toggleFreeze() {
    const s = holder.current();
    const v = videoRef.current;
    if (!s || !v) return;
    const cur = s.getSnapshot();
    if (!cur.frozen) {
      v.pause();
      s.setFrozen(true);
      try {
        cb.current.onFreezeUsed?.({ hasAnchor: !!cur.anchor, customerState: cur.customerState });
      } catch (e) {
        console.warn("[engineer-call] onFreezeUsed 오류:", e);
      }
    } else {
      s.setFrozen(false);
      void v.play().catch(() => {});
    }
  }

  const chip = engineerChip(snap);
  const showHint = !annotatedOnce && !snap.anchor && !connecting;
  const showToast = untrackableId !== null && untrackableId !== toastDismissed;
  // 고객에게 사진 카드가 보이는 상황 (무늬 부족 또는 고객이 놓침·찾는 중, 화살표 안내가 아닐 때)
  const customerSeesCard =
    hasCommitted &&
    (snap.trackable === false ||
      ((snap.customerState === "lost" || snap.customerState === "searching") && !snap.customerArrow));
  const previewAnchor = customerSeesCard && snap.anchor && preview?.anchorId === snap.anchor.id ? snap.anchor : null;

  return (
    <div className={`flex h-full w-full flex-col bg-black text-white ${className ?? ""}`}>
      <div
        ref={stageRef}
        data-testid="eng-stage"
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
      >
        <video
          ref={videoRef}
          data-testid="eng-video"
          autoPlay
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-contain"
        />
        <audio ref={audioRef} autoPlay />
        <AnchorOverlay
          video={videoRef}
          fit="contain"
          anchor={snap.anchor}
          update={null}
          getUpdate={getUpdate}
          guideInset={{ top: 64 }}
          className="anchor-overlay"
        />

        {snap.frozen && (
          <div className="pointer-events-none absolute inset-0 ring-4 ring-inset ring-amber-400" aria-hidden="true" />
        )}

        {/* 위쪽 정보 (읽기 전용, 터치 통과): 1줄 = 고객 상태칩 + 짧은 표시, 그 아래 오른쪽 = 경고·카드 미리보기 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3 pt-[max(12px,env(safe-area-inset-top))]">
          <div className="flex flex-wrap items-start gap-2">
            {chip && (
              <span
                data-testid="eng-chip"
                data-tone={chip.tone}
                role="status"
                className="flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full bg-black/70 px-4 py-2 text-[15px] font-semibold leading-tight shadow-lg backdrop-blur-sm"
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[chip.tone]}`} aria-hidden="true" />
                {chip.text}
              </span>
            )}
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {snap.frozen && (
                <span className="whitespace-nowrap rounded-full bg-amber-400 px-3 py-2 text-sm font-bold text-black shadow-lg">
                  정지 화면
                </span>
              )}
              {!micOn && (
                <span className="flex items-center gap-1 whitespace-nowrap rounded-full bg-black/70 px-3 py-2 text-sm font-medium text-amber-300">
                  <MicOffIcon className="h-4 w-4" />
                  마이크 꺼짐
                </span>
              )}
            </div>
          </div>
          {(notice || (previewAnchor && preview)) && (
            <div className="flex flex-col items-end gap-2">
              {notice}
              {previewAnchor && preview && (
                <div
                  data-testid="eng-card-preview"
                  className="w-28 rounded-xl bg-white p-1.5 text-center text-xs font-semibold leading-tight text-gray-800 shadow-xl"
                >
                  <AnnotatedPhoto src={preview.url} anchor={previewAnchor} className="h-24 w-full" rounded={8} />
                  <p className="mt-1 whitespace-nowrap">고객이 보는 카드</p>
                </div>
              )}
            </div>
          )}
        </div>

        {showHint && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
            <div
              data-testid="eng-hint"
              className="flex flex-col items-center gap-2 rounded-3xl bg-black/65 px-6 py-5 text-center break-keep shadow-2xl backdrop-blur-sm"
            >
              <TapIcon className="h-9 w-9" />
              <p className="text-lg font-bold leading-snug">
                화면을 탭하면
                <br />
                고객 화면에 표시돼요
              </p>
              <p className="text-sm text-white/75">손가락으로 끌면 선이 그려져요</p>
            </div>
          </div>
        )}

        {showToast && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
            <p
              data-testid="eng-toast"
              role="alert"
              className="rounded-2xl bg-amber-400 px-4 py-3 text-center text-[15px] font-semibold leading-snug break-keep text-black shadow-xl"
            >
              무늬가 적어 고정이 어려워요 —{" "}
              <br />
              고객에게 사진 카드로 보여줘요
            </p>
          </div>
        )}

        {connecting && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-lg text-white/75">
            연결 중…
          </p>
        )}
      </div>

      {/* 엄지가 쉬는 오른쪽에 자주 쓰는 도구, 통화 종료는 왼쪽 (실수로 끊지 않게) */}
      <div className="grid shrink-0 grid-cols-3 gap-2 bg-black px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          data-testid="eng-hangup"
          onClick={onHangup}
          className="flex h-14 items-center justify-center gap-1.5 rounded-2xl bg-red-600 text-[17px] font-bold active:bg-red-500"
        >
          <HangupIcon className="h-5 w-5" />
          종료
        </button>
        <button
          type="button"
          data-testid="eng-clear"
          onClick={clear}
          disabled={!snap.anchor}
          className="flex h-14 items-center justify-center gap-1.5 rounded-2xl bg-white/15 text-[17px] font-bold active:bg-white/30 disabled:opacity-35"
        >
          <EraseIcon className="h-5 w-5" />
          지우기
        </button>
        <button
          type="button"
          data-testid="eng-freeze"
          onClick={toggleFreeze}
          aria-pressed={snap.frozen}
          disabled={connecting}
          className={`flex h-14 items-center justify-center gap-1.5 rounded-2xl text-[17px] font-bold disabled:opacity-35 ${
            snap.frozen ? "bg-amber-400 text-black active:bg-amber-300" : "bg-white/15 active:bg-white/30"
          }`}
        >
          {snap.frozen ? <PlayIcon className="h-5 w-5" /> : <PauseIcon className="h-5 w-5" />}
          {snap.frozen ? "재생" : "정지"}
        </button>
      </div>
    </div>
  );
}
