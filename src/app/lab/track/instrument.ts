import { AnchorTracker, type WorkerLike } from "@/lib/tracking/client";
import { captureReference, type CapturedReference } from "@/lib/tracking/capture";
import type { CreateTracker, TrackerLike } from "@/lib/tracking/session";
import type { TrackResult, TrackUpdate } from "@/lib/tracking/types";
import type { WorkerRequest, WorkerResponse } from "@/lib/tracking/tracker.worker";

// 실험실 계측: 운영 세션 클래스(Engineer/CustomerAnchorSession)는 그대로 쓰고, 추적기 생성만 감싼다.
//  - Worker 메시지를 엿봐 TrackResult의 인라이어·추적 점 수·재검출 여부를 HUD에 (TrackUpdate엔 없다)
//  - e2e 모드: 벤치 y4m의 프레임 번호 띠(맨 아래 8행)를 프레임마다 읽어 갱신마다 번호를 붙인다 → 정답(GT)과 비교
// 운영 코드에는 들어가지 않는다 (/lab/track 전용).

export type Side = "eng" | "cust";

export interface SideStats {
  /** 마지막 갱신 */
  state: TrackUpdate["state"] | null;
  reason: string | null;
  confidence: number;
  processMs: number;
  inliers: number;
  tracked: number;
  redetected: boolean;
  /** 최근 1초 갱신 수 */
  fps: number;
  frame: { width: number; height: number } | null;
  /** 프레임 획득 방식 (session.trackerStats().acquisition) */
  acquisition: string | null;
  /** 프레임 한 장 획득에 메인 스레드에서 쓴 시간 EMA (ms, trackerStats().grabMsEma) */
  grabMs: number | null;
  /** 획득 방식이 내려간 기록 (예: "videoframe-worker: aspect") */
  demoted: string | null;
}

export interface LogRow {
  side: Side;
  t: number;
  /** 이 갱신을 만든 프레임의 번호 (띠를 못 읽으면 null) */
  idx: number | null;
  anchorId: string;
  state: TrackUpdate["state"];
  H: number[] | null;
  hint: number[] | null;
  reason: string | null;
  frameSize: { width: number; height: number };
  refSize: { width: number; height: number };
  processMs: number;
  inliers: number;
}

export interface RefRow {
  t: number;
  idx: number | null;
  width: number;
  height: number;
}

const MAX_LOG = 20000;

/** 벤치 y4m 프레임 번호 띠 해독 (scripts/tracking-bench/y4m.ts decodeMarker와 같은 규칙) */
export function decodeMarker(y: ArrayLike<number>, w: number, h: number, rows = 8): number | null {
  const cy = Math.min(h - 1, Math.floor(h - rows / 2));
  const cell = w / 16;
  const bit = (i: number) => y[cy * w + Math.floor((i + 0.5) * cell)] > 128;
  if (!bit(0) || bit(15)) return null;
  let v = 0;
  for (let b = 0; b < 14; b++) if (bit(b + 1)) v |= 1 << b;
  return v;
}

/** <video>의 지금 프레임에서 번호 띠 읽기 (맨 아래 8행만 작은 캔버스로) */
export class MarkerReader {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  read(video: HTMLVideoElement): number | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (video.readyState < 2 || !(vw > 0) || !(vh > 0)) return null;
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.width = 160;
      this.canvas.height = 1;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = this.ctx;
    if (!ctx) return null;
    // 띠는 원본 맨 아래 8행 — WebRTC가 줄여 보내도(¾) 맨 아래 3행은 항상 띠 안이다
    const rows = Math.min(3, vh);
    try {
      ctx.drawImage(video, 0, vh - rows, vw, rows, 0, 0, 160, 1);
      const d = ctx.getImageData(0, 0, 160, 1).data;
      const y = new Uint8Array(160);
      for (let i = 0; i < 160; i++) y[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
      return decodeMarker(y, 160, 1, 2);
    } catch {
      return null;
    }
  }
}

/** Worker 메시지 엿보기 */
class TapWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;

  constructor(
    private readonly w: Worker,
    private readonly hooks: { request?(m: WorkerRequest): void; response?(m: WorkerResponse): void },
  ) {
    w.onmessage = (e) => {
      try {
        this.hooks.response?.(e.data as WorkerResponse);
      } catch {
        // 계측 오류는 무시
      }
      this.onmessage?.(e);
    };
    w.onerror = (e) => this.onerror?.(e);
    w.onmessageerror = (e) => this.onmessageerror?.(e);
  }

  postMessage(msg: WorkerRequest, transfer?: Transferable[]): void {
    try {
      this.hooks.request?.(msg);
    } catch {
      // 무시
    }
    this.w.postMessage(msg, transfer ?? []);
  }

  terminate(): void {
    this.w.terminate();
  }
}

function createLabWorker(): Worker {
  // client.ts의 기본 Worker와 같은 파일 (번들러가 이 형태를 보고 Worker 번들을 만든다)
  return new Worker(new URL("../../../lib/tracking/tracker.worker.ts", import.meta.url), {
    type: "module",
    name: "lab-anchor-tracker",
  });
}

export function emptyStats(): SideStats {
  return {
    state: null,
    reason: null,
    confidence: 0,
    processMs: 0,
    inliers: 0,
    tracked: 0,
    redetected: false,
    fps: 0,
    frame: null,
    acquisition: null,
    grabMs: null,
    demoted: null,
  };
}

/** 한 쪽(엔지니어/고객)의 계측 상태 */
export class SideProbe {
  readonly stats: SideStats = emptyStats();
  tracker: AnchorTracker | null = null;
  private times: number[] = [];
  private lastResult: TrackResult | null = null;
  private inflightIdx: number | null = null;
  private resultIdx: number | null = null;
  private readonly marker = new MarkerReader();

  constructor(
    readonly side: Side,
    private readonly lab: LabRecorder,
  ) {}

  createTracker: CreateTracker = (video, o): TrackerLike => {
    const tracker = new AnchorTracker(video, {
      fps: o.fps,
      acquisition: o.acquisition,
      onUpdate: (u) => {
        this.onUpdate(u);
        o.onUpdate(u);
      },
      createWorker: () =>
        new TapWorker(createLabWorker(), {
          request: (m) => {
            if (this.lab.recordMarkers && (m.type === "frame" || m.type === "videoFrame")) {
              this.inflightIdx = this.marker.read(video);
            }
          },
          response: (m) => {
            if (m.type === "result") {
              this.lastResult = m.result;
              this.resultIdx = this.inflightIdx;
            }
          },
        }),
    });
    this.tracker = tracker;
    return tracker;
  };

  private onUpdate(u: TrackUpdate) {
    const now = performance.now();
    this.times.push(now);
    while (this.times.length && now - this.times[0] > 1000) this.times.shift();
    const r = this.lastResult;
    const s = this.stats;
    s.state = u.state;
    s.reason = u.reason ?? null;
    s.confidence = u.confidence;
    s.processMs = u.processMs;
    s.inliers = r?.inliers ?? 0;
    s.tracked = r?.tracked ?? 0;
    s.redetected = !!r?.redetected;
    s.fps = this.times.length;
    s.frame = u.frameSize;
    const fs = this.tracker?.stats() ?? null;
    s.acquisition = fs?.acquisition ?? null;
    s.grabMs = fs && Number.isFinite(fs.grabMsEma) ? fs.grabMsEma : null;
    s.demoted = fs && fs.demoted.length ? fs.demoted.map((d) => `${d.mode}: ${d.reason}`).join(", ") : null;
    if (this.lab.recordMarkers && this.lab.log.length < MAX_LOG) {
      this.lab.log.push({
        side: this.side,
        t: now,
        idx: this.resultIdx,
        anchorId: u.anchorId,
        state: u.state,
        H: u.H ? u.H.slice() : null,
        hint: u.hint ? u.hint.slice() : null,
        reason: u.reason ?? null,
        frameSize: { ...u.frameSize },
        refSize: { ...u.refSize },
        processMs: u.processMs,
        inliers: r?.inliers ?? 0,
      });
    }
  }
}

/** 실험실 전체 기록 (e2e가 window.__lab으로 읽는다) */
export class LabRecorder {
  readonly log: LogRow[] = [];
  readonly refs: RefRow[] = [];
  readonly events: { t: number; name: string; props: unknown }[] = [];
  readonly eng: SideProbe;
  readonly cust: SideProbe;

  constructor(readonly recordMarkers: boolean) {
    this.eng = new SideProbe("eng", this);
    this.cust = new SideProbe("cust", this);
  }

  /** 엔지니어 기준 캡처 (기준 프레임 번호 기록) */
  capture = (video: HTMLVideoElement): CapturedReference | null => {
    const c = captureReference(video);
    if (c && this.recordMarkers) {
      this.refs.push({
        t: performance.now(),
        idx: decodeMarker(c.gray.data, c.gray.width, c.gray.height, 4),
        width: c.gray.width,
        height: c.gray.height,
      });
    }
    return c;
  };

  event(name: string, props: unknown) {
    this.events.push({ t: performance.now(), name, props });
    if (this.events.length > 500) this.events.shift();
  }
}
