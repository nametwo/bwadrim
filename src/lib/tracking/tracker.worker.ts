import type {
  GrayImage,
  Mat3,
  PlanarTrackerApi,
  Point,
  Rect,
  ReferenceInfo,
  TrackerConfig,
  TrackResult,
} from "./types";
import { PlanarTracker } from "./tracker";
import { isLostReason } from "./protocol";
import { UnsupportedFrameError, VideoFrameReader, type VideoFrameLike } from "./frame-source";

// 추적 Worker. PlanarTracker(순수 계산)를 메인 스레드 밖에서 돌린다.
// 생성: new Worker(new URL("./tracker.worker.ts", import.meta.url), { type: "module" })  (client.ts)
//
// 메인 → Worker
//   config        { type, config }                     — 추적기 설정 (다음 setReference부터)
//   setReference  { type, gen, ref, roi, initialH?, anchor? } — 기준 설정 (ref는 복사로 받는다). anchor = 주석 기준점(ref px)
//   clear         { type, gen }
//   frame         { type, gen, frame, ts }             — frame.data 버퍼는 transfer
//   videoFrame    { type, gen, frame, width, height, ts } — VideoFrame을 transfer. Worker가 Y 평면을 읽어
//                 width×height(작업 해상도) 그레이로 면적 평균 축소한 뒤 추적하고, 읽자마자 close()한다
// Worker → 메인
//   ready         { type }                              — 모듈 로드 완료
//   reference     { type, gen, info | null, error? }
//   result        { type, gen, result | null, frame, processMs, error?, acquireMs?, acquireError?, unsupported? }
//                 gray 프레임이면 frame.data 버퍼를 되돌려준다(transfer). videoFrame이면 frame.data는 빈 배열.
//                 processMs = 읽기(acquireMs) + 추적. acquireError = VideoFrame을 못 읽음 (추적기 오류 아님):
//                 unsupported면 이 형식은 앞으로도 못 읽으니 메인이 다른 획득 방식으로 바꾼다
//   error         { type, message }                     — 처리 못 한 메시지 등
//
// gen: 메인이 setReference/clear 때마다 올리는 세대 번호. 다른 세대의 프레임은 처리하지 않고 버퍼만 돌려준다.

export interface WireGray {
  width: number;
  height: number;
  data: Uint8Array;
}

export type WorkerRequest =
  | { type: "config"; config: Partial<TrackerConfig> }
  | { type: "setReference"; gen: number; ref: WireGray; roi: Rect; initialH?: Mat3 | null; anchor?: Point | null }
  | { type: "clear"; gen: number }
  | { type: "frame"; gen: number; frame: WireGray; ts: number }
  | { type: "videoFrame"; gen: number; frame: VideoFrameLike; width: number; height: number; ts: number };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "reference"; gen: number; info: ReferenceInfo | null; error?: string }
  | {
      type: "result";
      gen: number;
      result: TrackResult | null;
      frame: WireGray;
      processMs: number;
      error?: string;
      /** videoFrame: 읽기·축소에 쓴 시간 (ms) */
      acquireMs?: number;
      /** videoFrame을 읽지 못함 (추적기 오류가 아님) */
      acquireError?: string;
      /** acquireError가 형식 문제라 다시 시도해도 소용없음 */
      unsupported?: boolean;
    }
  | { type: "error"; message: string };

export type PostFn = (msg: WorkerResponse, transfer: Transferable[]) => void;

function isGray(v: unknown): v is WireGray {
  if (typeof v !== "object" || v === null) return false;
  const g = v as { width?: unknown; height?: unknown; data?: unknown };
  return (
    typeof g.width === "number" &&
    typeof g.height === "number" &&
    Number.isInteger(g.width) &&
    Number.isInteger(g.height) &&
    g.width > 0 &&
    g.height > 0 &&
    (g.data instanceof Uint8Array || g.data instanceof Uint8ClampedArray) &&
    g.data.length === g.width * g.height
  );
}

function isRect(v: unknown): v is Rect {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k] as number));
}

function isMat3(v: unknown): v is Mat3 {
  return Array.isArray(v) && v.length === 9 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

function isPoint(v: unknown): v is Point {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y);
}

const REF_REASONS: readonly NonNullable<ReferenceInfo["reason"]>[] = ["low_texture", "pin_blank", "ambiguous"];

function message(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * 결과를 복제 가능한 순수 객체로 (추적기가 내부 배열을 재사용해도 안전하게).
 * 계약을 여기서 한 번 더 강제한다: H는 tracking/weak일 때만, hint·reason은 H가 없을 때만(화면 밖 화살표·안내 전용).
 */
export function cloneResult(r: TrackResult): TrackResult {
  const timings: TrackResult["timings"] = { total: Number(r.timings?.total) || 0 };
  if (r.timings) {
    for (const k of Object.keys(r.timings)) {
      const v = r.timings[k];
      if (typeof v === "number") timings[k] = v;
    }
  }
  const shown = r.state === "tracking" || r.state === "weak";
  const hasH = shown && isMat3(r.H);
  const hasHint = !shown && isMat3(r.hint);
  const out: TrackResult = {
    state: r.state,
    H: hasH ? (r.H as Mat3).slice() : null,
    hint: hasHint ? (r.hint as Mat3).slice() : null,
    confidence: Number.isFinite(r.confidence) ? r.confidence : 0,
    inliers: r.inliers | 0,
    tracked: r.tracked | 0,
    redetected: !!r.redetected,
    timings,
  };
  // 이유는 lost/searching에만 (계약: "lost/searching의 이유")
  if (!shown && isLostReason(r.reason)) out.reason = r.reason;
  return out;
}

function cloneInfo(info: ReferenceInfo): ReferenceInfo {
  const out: ReferenceInfo = { roi: { ...info.roi }, features: info.features | 0, trackable: !!info.trackable };
  if (typeof info.reason === "string" && (REF_REASONS as readonly string[]).includes(info.reason)) out.reason = info.reason;
  return out;
}

/**
 * Worker 안의 메시지 처리기 (Worker 전역과 분리해 Node 테스트에서 쓸 수 있게).
 * 추적기 예외는 모두 잡아 error 필드로 알리고, 추적기를 새로 만든다 (내부 상태가 깨졌을 수 있으므로).
 */
export class TrackerWorkerHost {
  private tracker: PlanarTrackerApi | null = null;
  private config: Partial<TrackerConfig> | undefined;
  /** 현재 기준의 세대. null이면 기준 없음 */
  private gen: number | null = null;
  private reader = new VideoFrameReader();
  /** videoFrame 읽기용 그레이 버퍼 (추적기는 process 뒤 프레임을 붙잡지 않는다 — gray 경로도 버퍼를 곧바로 돌려보낸다) */
  private grayBuf: Uint8Array | null = null;
  /** videoFrame은 비동기(copyTo)라 순서대로 하나씩 */
  private vfChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly createTracker: (config?: Partial<TrackerConfig>) => PlanarTrackerApi,
    private readonly post: PostFn,
    private readonly now: () => number = () => performance.now(),
    /** VideoFrame 읽기(copyTo) 제한 시간 — 끝나지 않는 읽기가 뒤 프레임을 막지 않게 */
    private readonly readTimeoutMs = 2000,
  ) {}

  /** 메시지 하나 처리. videoFrame이면 끝날 때 resolve되는 Promise (테스트용), 나머지는 동기 */
  handle(msg: unknown): void | Promise<void> {
    if (typeof msg !== "object" || msg === null) {
      this.post({ type: "error", message: "invalid message" }, []);
      return;
    }
    const m = msg as WorkerRequest;
    switch (m.type) {
      case "config":
        this.config = typeof m.config === "object" && m.config ? m.config : undefined;
        this.tracker = null; // 다음 사용 때 새 설정으로
        this.gen = null;
        return;
      case "setReference":
        this.setReference(m);
        return;
      case "clear":
        this.gen = null;
        try {
          this.tracker?.clearReference();
        } catch {
          this.tracker = null;
        }
        return;
      case "frame":
        this.frame(m);
        return;
      case "videoFrame": {
        const run = this.vfChain.then(() => this.videoFrame(m));
        this.vfChain = run.catch(() => {});
        return run;
      }
      default:
        this.post({ type: "error", message: `unknown message type` }, []);
    }
  }

  private ensureTracker(): PlanarTrackerApi {
    if (!this.tracker) this.tracker = this.createTracker(this.config);
    return this.tracker;
  }

  private setReference(m: Extract<WorkerRequest, { type: "setReference" }>) {
    const gen = m.gen;
    if (
      !isGray(m.ref) ||
      !isRect(m.roi) ||
      (m.initialH != null && !isMat3(m.initialH)) ||
      (m.anchor != null && !isPoint(m.anchor))
    ) {
      this.gen = null;
      this.post({ type: "reference", gen, info: null, error: "invalid reference" }, []);
      return;
    }
    try {
      const ref: GrayImage = { width: m.ref.width, height: m.ref.height, data: m.ref.data };
      const anchor = m.anchor ? { x: m.anchor.x, y: m.anchor.y } : undefined;
      const info = this.ensureTracker().setReference(ref, m.roi, m.initialH ?? undefined, anchor);
      this.gen = gen;
      this.post({ type: "reference", gen, info: cloneInfo(info) }, []);
    } catch (e) {
      this.tracker = null;
      this.gen = null;
      this.post({ type: "reference", gen, info: null, error: message(e) }, []);
    }
  }

  private frame(m: Extract<WorkerRequest, { type: "frame" }>) {
    const frame = m.frame;
    if (!isGray(frame)) {
      // 버퍼라도 돌려줄 수 있으면 돌려준다
      const data = (frame as { data?: unknown } | undefined)?.data;
      if (data instanceof Uint8Array) {
        this.post(
          { type: "result", gen: m.gen, result: null, frame: { width: 0, height: 0, data }, processMs: 0, error: "invalid frame" },
          [data.buffer],
        );
      } else {
        this.post({ type: "error", message: "invalid frame" }, []);
      }
      return;
    }
    const transfer: Transferable[] = [frame.data.buffer];
    this.track(m.gen, frame, m.ts, frame, transfer, 0);
  }

  /** 추적 한 번 + 결과 전송. reply = 메인에 돌려줄 frame 필드 */
  private track(gen: number, gray: WireGray, ts: number, reply: WireGray, transfer: Transferable[], acquireMs: number | undefined) {
    const extra = acquireMs !== undefined && acquireMs > 0 ? { acquireMs } : {};
    if (this.gen === null || gen !== this.gen || !this.tracker) {
      this.post({ type: "result", gen, result: null, frame: reply, processMs: acquireMs ?? 0, ...extra }, transfer);
      return;
    }
    const t0 = this.now();
    try {
      const r = this.tracker.process({ width: gray.width, height: gray.height, data: gray.data }, ts);
      const processMs = this.now() - t0 + (acquireMs ?? 0);
      this.post({ type: "result", gen, result: cloneResult(r), frame: reply, processMs, ...extra }, transfer);
    } catch (e) {
      const processMs = this.now() - t0 + (acquireMs ?? 0);
      // 내부 상태가 깨졌을 수 있다 → 추적기를 버리고 기준도 잊는다 (메인이 다시 설정한다)
      this.tracker = null;
      this.gen = null;
      this.post({ type: "result", gen, result: null, frame: reply, processMs, error: message(e), ...extra }, transfer);
    }
  }

  private async videoFrame(m: Extract<WorkerRequest, { type: "videoFrame" }>) {
    const vf = m.frame;
    const w = m.width;
    const h = m.height;
    const empty: WireGray = { width: Number.isInteger(w) && w > 0 ? w : 0, height: Number.isInteger(h) && h > 0 ? h : 0, data: new Uint8Array(0) };
    const valid =
      !!vf &&
      typeof (vf as { copyTo?: unknown }).copyTo === "function" &&
      empty.width > 0 &&
      empty.height > 0 &&
      empty.width <= 4096 &&
      empty.height <= 4096;
    if (!valid) {
      try {
        (vf as { close?: () => void } | null)?.close?.();
      } catch {
        // 무시
      }
      this.post({ type: "result", gen: m.gen, result: null, frame: empty, processMs: 0, error: "invalid frame" }, []);
      return;
    }
    // 기준이 없거나 다른 세대면 읽지도 않는다
    if (this.gen === null || m.gen !== this.gen || !this.tracker) {
      safeClose(vf);
      this.post({ type: "result", gen: m.gen, result: null, frame: empty, processMs: 0 }, []);
      return;
    }
    const n = w * h;
    if (!this.grayBuf || this.grayBuf.length !== n) this.grayBuf = new Uint8Array(n);
    const t0 = this.now();
    let gray: WireGray;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = this.reader.read(vf, w, h, this.grayBuf);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`VideoFrame read timeout (${this.readTimeoutMs}ms)`)), this.readTimeoutMs);
      });
      const g = await Promise.race([reading, timeout]);
      gray = { width: g.width, height: g.height, data: g.data as Uint8Array };
    } catch (e) {
      if (!(e instanceof UnsupportedFrameError)) {
        // 늦게 끝날 수 있는 읽기가 쓰던 버퍼·상태와 섞이지 않게 새로
        this.reader = new VideoFrameReader();
        this.grayBuf = null;
      }
      this.post(
        {
          type: "result",
          gen: m.gen,
          result: null,
          frame: empty,
          processMs: this.now() - t0,
          acquireError: message(e),
          unsupported: e instanceof UnsupportedFrameError,
        },
        [],
      );
      return;
    } finally {
      clearTimeout(timer);
      safeClose(vf);
    }
    this.track(m.gen, gray, m.ts, empty, [], this.now() - t0);
  }
}

function safeClose(vf: { close(): void }) {
  try {
    vf.close();
  } catch {
    // 무시
  }
}

// ───────────────────────── Worker 전역 바인딩 ─────────────────────────
// Node(테스트)·메인 스레드에서 import될 때는 아무것도 하지 않는다.

interface WorkerScope {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", cb: (e: MessageEvent) => void): void;
}

const g = globalThis as unknown as { WorkerGlobalScope?: unknown; document?: unknown };
if (typeof g.WorkerGlobalScope !== "undefined" && typeof g.document === "undefined") {
  const scope = globalThis as unknown as WorkerScope;
  const host = new TrackerWorkerHost(
    (config) => new PlanarTracker(config),
    (msg, transfer) => scope.postMessage(msg, transfer),
  );
  scope.addEventListener("message", (e) => host.handle(e.data));
  scope.postMessage({ type: "ready" } satisfies WorkerResponse, []);
}
