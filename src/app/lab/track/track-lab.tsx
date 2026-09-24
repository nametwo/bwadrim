"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { fromRTCDataChannel, type DataLink } from "@/lib/webrtc/data-link";
import {
  EMPTY_ENGINEER_SNAPSHOT,
  EngineerAnchorSession,
  type CustomerAnchorSession,
  type EngineerSnapshot,
} from "@/lib/tracking/session";
import { AnchorOverlay } from "@/components/anchor-overlay";
import { EngineerCallView } from "@/components/call/engineer-call-view";
import { CustomerCallView } from "@/components/call/customer-call-view";
import { SessionHolder } from "@/components/call/session-holder";
import { LabRecorder, emptyStats, type SideProbe, type SideStats } from "./instrument";

// 추적 실험실 (/lab/track). 실기기·배포 미리보기에서 폰으로 열어 확인하는 도구.
//  (a) 카메라 1대: 후면 카메라(또는 영상 파일) 위를 탭 → 엔지니어식 즉시 고정(initialH = I). HUD: 상태·fps·처리 ms·인라이어
//  (b) 루프백: 고객 화면 + 엔지니어 화면을 한 페이지에서 RTCPeerConnection 쌍 + 실제 DataChannel로 연결.
//      운영 통화 화면 컴포넌트(EngineerCallView·CustomerCallView)와 세션 클래스를 그대로 쓴다.
//  (c) 카메라 대신 영상 파일 (폰으로 찍은 클립을 다시 재생)
// 카메라는 "시작" 버튼을 누른 뒤에만 켠다. 아무것도 저장하지 않는다 (메모리만).

type Mode = "single" | "loopback";
type Source = "camera" | "file";

export interface TrackLabProps {
  /** e2e: 프레임 번호 띠 기록 + window.__lab */
  e2e?: boolean;
  /** 패널 크기 "390x844" (스크린숏용) */
  pane?: string | null;
  initialMode?: Mode;
  /** 테스트용 합성 카메라: "blank" = 무늬 없는 회색 면 (무늬 부족), "repeat" = 똑같은 타일 반복 (반복 무늬) */
  synthetic?: SyntheticKind | null;
}

interface Running {
  mode: Mode;
  stream: MediaStream | null;
  fileUrl: string | null;
  /** 파일 루프백용 재생 요소 (captureStream 원본) */
  fileVideo: HTMLVideoElement | null;
  source: Source;
  /** 합성 카메라 그리기 루프 정지 */
  stopSynthetic: (() => void) | null;
  /** 합성 카메라 가리기 (e2e) */
  cover?: (on: boolean) => void;
}

const NULL_LINK: DataLink = {
  send: () => false,
  onMessage: () => () => {},
  onOpenChange: () => () => {},
  isOpen: () => false,
  bufferedAmount: () => 0,
};

/** ?pane=390x844 → 고정 크기 (스크린숏·e2e). 없으면 null (화면 크기에 맞춤) */
function fixedPane(pane: string | null | undefined): CSSProperties | null {
  const m = pane ? /^(\d{2,4})x(\d{2,4})$/.exec(pane) : null;
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** 카메라 1대 모드의 패널 크기 */
const SINGLE_PANE: CSSProperties = { width: "min(100%, 420px)", height: "min(844px, 78svh)" };

type CaptureCapable = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

type SyntheticKind = "blank" | "repeat";

interface SyntheticCamera {
  stream: MediaStream;
  stop(): void;
  /** 손으로 가린 것처럼 화면을 어둡게 덮기 (e2e: 놓침 → 다시 탭 안내 확인) */
  cover(on: boolean): void;
}

/** 똑같은 무늬 타일 (고정 시드) — 반복 무늬(콘센트 줄·환풍구·키 배열) 흉내 */
function repeatTile(): HTMLCanvasElement {
  const t = document.createElement("canvas");
  t.width = 72;
  t.height = 72;
  const g = t.getContext("2d")!;
  g.fillStyle = "#9a9a9a";
  g.fillRect(0, 0, 72, 72);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 14; i++) {
    const v = Math.round(30 + rnd() * 200);
    g.fillStyle = `rgb(${v},${v},${v})`;
    const x = rnd() * 60;
    const y = rnd() * 60;
    if (i % 2) g.fillRect(x, y, 4 + rnd() * 14, 4 + rnd() * 14);
    else {
      g.beginPath();
      g.arc(x + 6, y + 6, 2 + rnd() * 7, 0, Math.PI * 2);
      g.fill();
    }
  }
  return t;
}

/**
 * 합성 카메라 (캔버스 captureStream, 30fps). 테스트·시연용
 *  - blank: 무늬 없는 회색 면 (아주 약한 밝기 기울기) → 무늬 부족 경로
 *  - repeat: 화면 전체가 똑같은 타일 반복 + 아주 느린 흔들림 → 반복 무늬(ambiguous) 경로
 */
function syntheticCamera(kind: SyntheticKind): SyntheticCamera | null {
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 640;
  const ctx = c.getContext("2d");
  const cap = (c as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
  if (!ctx || typeof cap !== "function") return null;
  const g = ctx.createLinearGradient(0, 0, 0, 640);
  g.addColorStop(0, "#8a8a8a");
  g.addColorStop(1, "#7e7e7e");
  const pattern = kind === "repeat" ? ctx.createPattern(repeatTile(), "repeat") : null;
  let n = 0;
  let covered = false;
  const draw = () => {
    n++;
    if (covered) {
      ctx.fillStyle = n % 2 ? "#2a2522" : "#2b2623";
      ctx.fillRect(0, 0, 480, 640);
      return;
    }
    if (pattern) {
      const dx = Math.sin(n / 40) * 3;
      const dy = Math.cos(n / 55) * 2;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillStyle = pattern;
      ctx.fillRect(-10, -10, 500, 660);
      ctx.restore();
      return;
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 480, 640);
    // 새 프레임으로 인식되도록 한 픽셀만 바꾼다 (캔버스가 바뀌어야 captureStream이 프레임을 낸다)
    ctx.fillStyle = n % 2 ? "#858585" : "#868686";
    ctx.fillRect(0, 0, 1, 1);
  };
  draw();
  const stream = cap.call(c, 30);
  const timer = setInterval(draw, 33);
  return {
    stream,
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
    cover: (on) => {
      covered = on;
    },
  };
}

function stopAll(r: Running | null) {
  r?.stopSynthetic?.();
  r?.stream?.getTracks().forEach((t) => t.stop());
  if (r?.fileVideo) {
    r.fileVideo.pause();
    r.fileVideo.removeAttribute("src");
    r.fileVideo.load();
  }
  if (r?.fileUrl) URL.revokeObjectURL(r.fileUrl);
}

export function TrackLab({ e2e = false, pane = null, initialMode = "loopback", synthetic = null }: TrackLabProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [source, setSource] = useState<Source>("camera");
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recorder, setRecorder] = useState(() => new LabRecorder(e2e));
  const runningRef = useRef<Running | null>(null);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => () => stopAll(runningRef.current), []);

  // e2e: 합성 카메라 가리기 (손으로 가린 상황 → 놓침)
  useEffect(() => {
    if (!e2e) return;
    (window as unknown as { __labCamera?: unknown }).__labCamera = { cover: running?.cover ?? null };
  }, [e2e, running]);

  // 카메라·파일 재생은 반드시 이 버튼 탭(사용자 제스처) 안에서 시작
  async function start() {
    setError(null);
    setBusy(true);
    try {
      let stream: MediaStream | null = null;
      let fileUrl: string | null = null;
      let fileVideo: HTMLVideoElement | null = null;
      let stopSynthetic: (() => void) | null = null;
      let cover: ((on: boolean) => void) | undefined;
      if (synthetic) {
        const cam = syntheticCamera(synthetic);
        if (!cam) throw new Error("합성 카메라를 만들 수 없어요");
        stream = cam.stream;
        stopSynthetic = cam.stop;
        cover = cam.cover;
      } else if (source === "camera") {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } else {
        if (!file) throw new Error("영상 파일을 먼저 고르세요");
        fileUrl = URL.createObjectURL(file);
        if (mode === "loopback") {
          const v = document.createElement("video") as CaptureCapable;
          v.src = fileUrl;
          v.muted = true;
          v.loop = true;
          v.playsInline = true;
          await v.play();
          stream = v.captureStream?.() ?? v.mozCaptureStream?.() ?? null;
          fileVideo = v;
          if (!stream) {
            stopAll({ mode, stream: null, fileUrl, fileVideo: v, source, stopSynthetic: null });
            throw new Error("이 브라우저는 영상 파일 루프백을 못 해요 — '카메라 1대' 모드로 재생하세요");
          }
        }
      }
      setRecorder(new LabRecorder(e2e));
      setRunning({ mode, stream, fileUrl, fileVideo, source: synthetic ? "file" : source, stopSynthetic, cover });
    } catch (e) {
      setError(e instanceof Error ? `${e.name === "Error" ? "" : e.name + ": "}${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    stopAll(running);
    setRunning(null);
  }

  const fixed = fixedPane(pane);

  return (
    <main className="min-h-screen bg-neutral-950 px-3 py-2 text-neutral-100 md:py-3">
      <header className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 pb-2 md:pb-3">
        <h1 className="mr-2 text-lg font-bold">추적 실험실</h1>
        <Segmented
          value={mode}
          disabled={!!running}
          onChange={(v) => setMode(v as Mode)}
          options={[
            ["single", "카메라 1대"],
            ["loopback", "루프백"],
          ]}
          testId="lab-mode"
        />
        <Segmented
          value={source}
          disabled={!!running}
          onChange={(v) => setSource(v as Source)}
          options={[
            ["camera", "카메라"],
            ["file", "영상 파일"],
          ]}
          testId="lab-source"
        />
        {source === "file" && !running && (
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="max-w-[14rem] text-sm file:mr-2 file:rounded-lg file:border-0 file:bg-neutral-700 file:px-3 file:py-2 file:text-neutral-100"
          />
        )}
        {running ? (
          <button
            type="button"
            onClick={stop}
            className="ml-auto h-11 rounded-xl bg-neutral-700 px-5 font-semibold active:bg-neutral-600"
          >
            멈춤
          </button>
        ) : (
          <button
            type="button"
            id="lab-start"
            onClick={start}
            disabled={busy || (source === "file" && !file)}
            className="ml-auto h-11 rounded-xl bg-blue-600 px-5 font-semibold active:bg-blue-500 disabled:opacity-50"
          >
            {busy ? "켜는 중…" : "시작"}
          </button>
        )}
      </header>

      {error && <p className="mx-auto mb-3 max-w-5xl rounded-lg bg-red-900/60 px-3 py-2 text-sm">{error}</p>}

      {!running && (
        <section className="mx-auto max-w-2xl space-y-2 text-sm leading-relaxed break-keep text-neutral-300">
          <p>
            <b>카메라 1대</b>: 후면 카메라로 평면(단말기·공유기·명판 등)을 비추고 화면을 탭하면 그 자리에 핀이 고정돼요
            (엔지니어 쪽과 같은 즉시 고정). 끌면 선. HUD에 상태·fps·처리 시간·인라이어가 나와요.
          </p>
          <p>
            <b>루프백</b>: 같은 카메라 영상을 WebRTC로 한 바퀴 돌려 <b>엔지니어 화면</b>에 보여 주고, 거기서 탭하면
            DataChannel로 <b>고객 화면</b>에 전달돼 고객 쪽이 스스로 찾아 붙여요. 실제 통화 화면 그대로예요.
          </p>
          <p>
            <b>영상 파일</b>: 폰으로 찍어 둔 클립을 카메라 대신 반복 재생해요. 파일은 이 기기 안에서만 쓰고 어디에도 올리지
            않아요.
          </p>
        </section>
      )}

      {running?.mode === "single" && (
        <SingleLab run={running} probe={recorder.eng} recorder={recorder} style={fixed ?? SINGLE_PANE} e2e={e2e} />
      )}
      {running?.mode === "loopback" && running.stream && (
        <LoopbackLab stream={running.stream} canFlip={running.source === "camera"} recorder={recorder} fixed={fixed} e2e={e2e} />
      )}
    </main>
  );
}

function Segmented({
  value,
  options,
  onChange,
  disabled,
  testId,
}: {
  value: string;
  options: [string, string][];
  onChange(v: string): void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex rounded-xl bg-neutral-800 p-1" role="radiogroup" data-testid={testId}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`h-9 rounded-lg px-3 text-sm font-semibold disabled:opacity-60 ${
            value === v ? "bg-neutral-100 text-neutral-900" : "text-neutral-300"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── HUD ─────────────────────────

function useStats(probe: SideProbe): SideStats {
  const [s, setS] = useState<SideStats>(emptyStats);
  useEffect(() => {
    const t = setInterval(() => setS({ ...probe.stats }), 250);
    return () => clearInterval(t);
  }, [probe]);
  return s;
}

function Hud({ probe, testId, label, compactOnPhone = false }: { probe: SideProbe; testId?: string; label?: string; compactOnPhone?: boolean }) {
  const s = useStats(probe);
  const color =
    s.state === "tracking"
      ? "text-green-400"
      : s.state === "weak"
        ? "text-yellow-300"
        : s.state === "lost"
          ? "text-red-400"
          : "text-neutral-400";
  return (
    <>
      {compactOnPhone && (
        // 폰: 한 줄 요약 (두 화면이 한 화면에 다 들어오게)
        <p className="truncate font-mono text-[11px] leading-tight text-neutral-300 md:hidden">
          <span className="text-neutral-500">{label} </span>
          <span className={color}>
            {s.state ?? "—"}
            {s.reason ? `/${s.reason}` : ""}
          </span>{" "}
          · {s.fps}fps · {s.processMs.toFixed(1)}ms · 획득 {s.grabMs === null ? "—" : s.grabMs.toFixed(1)}ms · 인라이어{" "}
          {s.inliers}/{s.tracked}
          {s.redetected ? " R" : ""}
        </p>
      )}
      <div
        data-testid={testId}
        className={`${compactOnPhone ? "hidden md:grid" : "grid"} w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 overflow-hidden rounded-lg bg-black/70 px-2.5 py-1.5 font-mono text-[12px] leading-tight [&>span]:truncate`}
      >
        <span className="text-neutral-400">상태</span>
        <span className={color}>
          {s.state ?? "—"}
          {s.reason ? `/${s.reason}` : ""}
        </span>
        <span className="text-neutral-400">fps</span>
        <span>{s.fps}</span>
        <span className="text-neutral-400">처리</span>
        <span>{s.processMs.toFixed(1)}ms</span>
        <span className="text-neutral-400">인라이어</span>
        <span>
          {s.inliers}/{s.tracked}
          {s.redetected ? " R" : ""}
        </span>
        <span className="text-neutral-400">신뢰</span>
        <span>{s.confidence.toFixed(2)}</span>
        <span className="text-neutral-400">획득</span>
        <span className="truncate" title={s.demoted ? `내려감: ${s.demoted}` : undefined}>
          {s.acquisition ?? "—"}
          {s.frame ? ` ${s.frame.width}×${s.frame.height}` : ""}
        </span>
        <span className="text-neutral-400">획득ms</span>
        <span data-testid={testId ? `${testId}-grab` : undefined}>
          {s.grabMs === null ? "—" : `${s.grabMs.toFixed(2)}ms`}
          {s.demoted ? " ↓" : ""}
        </span>
      </div>
    </>
  );
}

// ───────────────────────── (a) 카메라 1대 ─────────────────────────

interface SingleView {
  anchor: EngineerSnapshot["anchor"];
  trackable: boolean | null;
  referenceReason: EngineerSnapshot["referenceReason"];
  frozen: boolean;
}

function SingleLab({
  run,
  probe,
  recorder,
  style,
  e2e,
}: {
  run: Running;
  probe: SideProbe;
  recorder: LabRecorder;
  style: CSSProperties;
  e2e: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [holder] = useState(() => new SessionHolder<EngineerAnchorSession, EngineerSnapshot>(EMPTY_ENGINEER_SNAPSHOT));
  const [view] = useState(() =>
    holder.selector(
      (s): SingleView => ({ anchor: s.anchor, trackable: s.trackable, referenceReason: s.referenceReason, frozen: s.frozen }),
    ),
  );
  const [getUpdate] = useState(() => () => holder.current()?.latestUpdate() ?? null);
  const snap = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (run.stream) v.srcObject = run.stream;
    else if (run.fileUrl) {
      v.src = run.fileUrl;
      v.loop = true;
    }
    void v.play().catch(() => {});
  }, [run]);

  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;
    const s = new EngineerAnchorSession({
      video,
      link: NULL_LINK,
      fit: "contain",
      deps: { createTracker: probe.createTracker, capture: recorder.capture },
    });
    const off = s.attachPointerInput(stage, "contain");
    holder.set(s);
    if (e2e) (window as unknown as { __lab?: unknown }).__lab = { mode: "single", recorder, eng: s };
    return () => {
      off();
      holder.set(null);
      s.destroy();
    };
  }, [holder, probe, recorder, e2e]);

  function toggleFreeze() {
    const s = holder.current();
    const v = videoRef.current;
    if (!s || !v) return;
    if (!s.getSnapshot().frozen) {
      v.pause();
      s.setFrozen(true);
    } else {
      s.setFrozen(false);
      void v.play().catch(() => {});
    }
  }

  return (
    <section className="mx-auto flex flex-col items-center gap-2">
      <div className="flex min-w-0 items-center gap-2" style={{ width: style.width, maxWidth: "100%" }}>
        <Hud probe={probe} testId="hud-single" />
        <p className="text-xs text-neutral-400">
          기준:{" "}
          {snap.trackable === null ? "—" : snap.trackable ? "추적 가능" : "무늬 부족"}
          {snap.referenceReason ? ` (${snap.referenceReason})` : ""}
        </p>
      </div>
      <div className="relative overflow-hidden rounded-2xl bg-black" style={style}>
        <div ref={stageRef} className="absolute inset-0 touch-none select-none" data-testid="single-stage">
          <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-contain" />
          <AnchorOverlay video={videoRef} fit="contain" anchor={snap.anchor} update={null} getUpdate={getUpdate} />
          {!snap.anchor && (
            <p className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-2xl bg-black/60 px-4 py-3 text-center text-base font-semibold">
              평면을 비추고 탭하세요 (끌면 선)
            </p>
          )}
          {snap.frozen && <div className="pointer-events-none absolute inset-0 ring-4 ring-inset ring-amber-400" />}
        </div>
        <div className="absolute inset-x-0 bottom-0 grid grid-cols-2 gap-2 p-3">
          <button
            type="button"
            onClick={() => holder.current()?.clear()}
            disabled={!snap.anchor}
            className="h-14 rounded-2xl bg-white/20 text-[17px] font-bold backdrop-blur-sm active:bg-white/30 disabled:opacity-40"
          >
            지우기
          </button>
          <button
            type="button"
            onClick={toggleFreeze}
            className={`h-14 rounded-2xl text-[17px] font-bold backdrop-blur-sm ${
              snap.frozen ? "bg-amber-400 text-black" : "bg-white/20 active:bg-white/30"
            }`}
          >
            {snap.frozen ? "재생" : "정지"}
          </button>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────── (b) 루프백 ─────────────────────────

interface LabWindow {
  __lab?: Record<string, unknown>;
}

function LoopbackLab({
  stream,
  canFlip,
  recorder,
  fixed,
  e2e,
}: {
  stream: MediaStream;
  canFlip: boolean;
  recorder: LabRecorder;
  /** 고정 패널 크기 (없으면 화면에 맞춤: 폰은 위아래 반씩 — 두 영상이 늘 화면 안에 있어야 한다.
   *  화면 밖 muted 자동재생 영상은 iOS·안드로이드가 멈춰서 그쪽 추적도 멈춘다) */
  fixed: CSSProperties | null;
  e2e: boolean;
}) {
  const figureStyle: CSSProperties | undefined = fixed ? { width: fixed.width, maxWidth: "100%" } : undefined;
  const paneClass = fixed
    ? "overflow-hidden rounded-2xl"
    : "h-[calc((100svh-11.5rem)/2)] w-full overflow-hidden rounded-2xl md:h-[min(844px,78svh)]";
  // 링크는 컴포넌트 수명 동안 하나씩 (연결은 effect에서 채널을 붙인다)
  const [links] = useState(() => ({ cust: fromRTCDataChannel(null), eng: fromRTCDataChannel(null) }));
  const [custStream, setCustStream] = useState<MediaStream>(stream);
  const [engStream, setEngStream] = useState<MediaStream | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<{ t: number; text: string }[]>([]);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const custStreamRef = useRef<MediaStream>(stream);
  const sessions = useRef<{ eng: EngineerAnchorSession | null; cust: CustomerAnchorSession | null }>({
    eng: null,
    cust: null,
  });
  const [engOptions] = useState(() => ({
    deps: { createTracker: recorder.eng.createTracker, capture: recorder.capture },
  }));
  const [custOptions] = useState(() => ({ deps: { createTracker: recorder.cust.createTracker } }));

  useEffect(() => {
    custStreamRef.current = custStream;
  }, [custStream]);

  // 한 페이지 안의 두 피어: pc1 = 고객(카메라 송신, draw 채널 생성), pc2 = 엔지니어(수신)
  useEffect(() => {
    let closed = false;
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pcRef.current = pc1;
    pc1.onicecandidate = (e) => {
      if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {});
    };
    pc2.onicecandidate = (e) => {
      if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {});
    };
    const src = custStreamRef.current;
    for (const t of src.getTracks()) pc1.addTrack(t, src);
    links.cust.attach(pc1.createDataChannel("draw"));
    pc2.ondatachannel = (e) => links.eng.attach(e.channel);
    pc2.ontrack = (e) => {
      if (!closed && e.streams[0]) setEngStream(e.streams[0]);
    };
    pc2.onconnectionstatechange = () => {
      if (!closed) setConnected(pc2.connectionState === "connected");
    };
    (async () => {
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);
    })().catch((e) => console.warn("[lab] 루프백 협상 실패:", e));
    if (e2e) {
      (window as unknown as LabWindow).__lab = {
        mode: "loopback",
        recorder,
        links,
        pc1,
        pc2,
        get eng() {
          return sessions.current.eng;
        },
        get cust() {
          return sessions.current.cust;
        },
        get trackers() {
          return { eng: recorder.eng.tracker, cust: recorder.cust.tracker };
        },
      };
    }
    return () => {
      closed = true;
      links.cust.attach(null);
      links.eng.attach(null);
      pc1.close();
      pc2.close();
      pcRef.current = null;
    };
  }, [links, recorder, e2e]);

  function log(text: string) {
    setEvents((ev) => [{ t: performance.now(), text }, ...ev].slice(0, 30));
  }

  // 고객 카메라 전환: 운영(camera-start)과 같은 방식 — 새 트랙으로 replaceTrack, 미리보기는 같은 <video>에 새 스트림
  async function flip() {
    const next = facing === "environment" ? "user" : "environment";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next }, audio: false });
      const track = s.getVideoTracks()[0];
      const sender = pcRef.current?.getSenders().find((x) => x.track?.kind === "video");
      await sender?.replaceTrack(track);
      custStreamRef.current.getVideoTracks().forEach((t) => t.stop());
      setCustStream(new MediaStream([track]));
      setFacing(next);
      log(`카메라 전환 → ${next}`);
    } catch (e) {
      log(`카메라 전환 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-3">
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-start md:justify-center md:gap-4">
        <figure className={`flex min-w-0 flex-col gap-1 md:gap-1.5 ${fixed ? "" : "md:w-[420px]"}`} style={figureStyle}>
          <figcaption className="hidden items-center justify-between gap-2 text-sm font-semibold text-neutral-300 md:flex">
            고객 화면 <span className="font-normal text-neutral-500">(내 카메라, cover)</span>
          </figcaption>
          <Hud probe={recorder.cust} testId="hud-cust" label="고객" compactOnPhone />
          <div className={paneClass} style={fixed ?? undefined} data-testid="pane-cust">
            <CustomerCallView
              stream={custStream}
              link={links.cust}
              statusText={connected ? "기사님이 보고 있어요" : "기사님과 연결 중…"}
              connected={connected}
              onFlip={canFlip ? flip : undefined}
              onHangup={() => log("고객: 종료 누름 (실험실에선 무시)")}
              onOutcome={(o) => {
                recorder.event("pointer_used:customer", o);
                log(
                  `고객 결과: 찾기 ${o.acquire_ms ?? "—"}ms · 표시 ${Math.round(o.tracked_fraction * 100)}% · 카드 ${o.card_ms}ms · 화살표 ${o.arrow_ms}ms (${o.end})`,
                );
              }}
              sessionOptions={custOptions}
              onSession={(s) => {
                sessions.current.cust = s;
              }}
            />
          </div>
        </figure>
        <figure className={`flex min-w-0 flex-col gap-1 md:gap-1.5 ${fixed ? "" : "md:w-[420px]"}`} style={figureStyle}>
          <figcaption className="hidden items-center justify-between gap-2 text-sm font-semibold text-neutral-300 md:flex">
            엔지니어 화면 <span className="font-normal text-neutral-500">(WebRTC 수신, contain)</span>
          </figcaption>
          <Hud probe={recorder.eng} testId="hud-eng" label="엔지니어" compactOnPhone />
          <div className={paneClass} style={fixed ?? undefined} data-testid="pane-eng">
            <EngineerCallView
              stream={engStream}
              link={links.eng}
              connecting={!connected}
              micOn
              onHangup={() => log("엔지니어: 종료 누름 (실험실에선 무시)")}
              onPointerUsed={(p) => {
                recorder.event("pointer_used", p);
                log(
                  `pointer_used ${p.kind} · 새 앵커 ${p.newAnchor ? "예" : "아니오"} · 추적 가능 ${p.trackable ?? "—"} · 고객 ${p.customerState ?? "—"}`,
                );
              }}
              onFreezeUsed={(p) => {
                recorder.event("freeze_used", p);
                log(`freeze_used · 주석 ${p.hasAnchor ? "있음" : "없음"}`);
              }}
              sessionOptions={engOptions}
              onSession={(s) => {
                sessions.current.eng = s;
              }}
            />
          </div>
        </figure>
      </div>
      <ol className="mx-auto w-full max-w-3xl space-y-1 font-mono text-xs text-neutral-400" data-testid="lab-events">
        {events.map((e) => (
          <li key={e.t}>
            {(e.t / 1000).toFixed(1)}s · {e.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
