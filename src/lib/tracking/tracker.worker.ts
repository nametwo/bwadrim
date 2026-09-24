import type { GrayImage, Mat3, PlanarTrackerApi, Rect, ReferenceInfo, TrackerConfig, TrackResult } from "./types";
import { PlanarTracker } from "./tracker";

// 추적 Worker. PlanarTracker(순수 계산)를 메인 스레드 밖에서 돌린다.
// 생성: new Worker(new URL("./tracker.worker.ts", import.meta.url), { type: "module" })  (client.ts)
//
// 메인 → Worker
//   config        { type, config }                     — 추적기 설정 (다음 setReference부터)
//   setReference  { type, gen, ref, roi, initialH? }   — 기준 설정 (ref는 복사로 받는다)
//   clear         { type, gen }
//   frame         { type, gen, frame, ts }             — frame.data 버퍼는 transfer
// Worker → 메인
//   ready         { type }                              — 모듈 로드 완료
//   reference     { type, gen, info | null, error? }
//   result        { type, gen, result | null, frame, processMs, error? } — frame.data 버퍼를 되돌려준다(transfer)
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
  | { type: "setReference"; gen: number; ref: WireGray; roi: Rect; initialH?: Mat3 | null }
  | { type: "clear"; gen: number }
  | { type: "frame"; gen: number; frame: WireGray; ts: number };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "reference"; gen: number; info: ReferenceInfo | null; error?: string }
  | { type: "result"; gen: number; result: TrackResult | null; frame: WireGray; processMs: number; error?: string }
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

function message(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** 결과를 복제 가능한 순수 객체로 (추적기가 내부 배열을 재사용해도 안전하게) */
function cloneResult(r: TrackResult): TrackResult {
  const timings: TrackResult["timings"] = { total: Number(r.timings?.total) || 0 };
  if (r.timings) {
    for (const k of Object.keys(r.timings)) {
      const v = r.timings[k];
      if (typeof v === "number") timings[k] = v;
    }
  }
  const hasH = (r.state === "tracking" || r.state === "weak") && isMat3(r.H);
  return {
    state: r.state,
    H: hasH ? (r.H as Mat3).slice() : null,
    confidence: Number.isFinite(r.confidence) ? r.confidence : 0,
    inliers: r.inliers | 0,
    tracked: r.tracked | 0,
    redetected: !!r.redetected,
    timings,
  };
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

  constructor(
    private readonly createTracker: (config?: Partial<TrackerConfig>) => PlanarTrackerApi,
    private readonly post: PostFn,
    private readonly now: () => number = () => performance.now(),
  ) {}

  handle(msg: unknown): void {
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
    if (!isGray(m.ref) || !isRect(m.roi) || (m.initialH != null && !isMat3(m.initialH))) {
      this.gen = null;
      this.post({ type: "reference", gen, info: null, error: "invalid reference" }, []);
      return;
    }
    try {
      const ref: GrayImage = { width: m.ref.width, height: m.ref.height, data: m.ref.data };
      const info = this.ensureTracker().setReference(ref, m.roi, m.initialH ?? undefined);
      this.gen = gen;
      this.post(
        {
          type: "reference",
          gen,
          info: { roi: { ...info.roi }, features: info.features | 0, trackable: !!info.trackable },
        },
        [],
      );
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
    if (this.gen === null || m.gen !== this.gen || !this.tracker) {
      this.post({ type: "result", gen: m.gen, result: null, frame, processMs: 0 }, transfer);
      return;
    }
    const t0 = this.now();
    try {
      const r = this.tracker.process({ width: frame.width, height: frame.height, data: frame.data }, m.ts);
      const processMs = this.now() - t0;
      this.post({ type: "result", gen: m.gen, result: cloneResult(r), frame, processMs }, transfer);
    } catch (e) {
      const processMs = this.now() - t0;
      // 내부 상태가 깨졌을 수 있다 → 추적기를 버리고 기준도 잊는다 (메인이 다시 설정한다)
      this.tracker = null;
      this.gen = null;
      this.post({ type: "result", gen: m.gen, result: null, frame, processMs, error: message(e) }, transfer);
    }
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
