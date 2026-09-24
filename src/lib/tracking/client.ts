import type { GrayImage, Mat3, Rect, ReferenceInfo, TrackerConfig, TrackUpdate } from "./types";
import type { WorkerRequest, WorkerResponse } from "./tracker.worker";
import { FrameSource, type FrameSourceOptions, type FrameSourceStats, type Size } from "./frame-source";

// 메인 스레드 추적 오케스트레이터: <video> → FrameSource → tracker.worker → TrackUpdate.
// - 앵커가 있을 때만 프레임 루프를 돌린다 (유휴 비용 0). Worker는 첫 앵커 때 만들어 재사용.
// - 한 번에 프레임 1장만 Worker에 가 있다 (FrameSource 역압). 버퍼는 transfer로 왕복해 재사용.
// - 세대(gen) 번호로 앵커 교체 전에 보낸 프레임의 결과를 버린다.
// - Worker 오류는 UI로 던지지 않는다: 'lost' 갱신 + console.warn, 가능하면 Worker를 되살려 탐색 모드로 재개.
//
// import 시점에 window/Worker를 건드리지 않는다 (SSR 안전).

/** Worker에서 쓰는 부분만 (테스트에서 가짜를 넣기 위함) */
export interface WorkerLike {
  postMessage(msg: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
}

/** FrameSource에서 쓰는 부분만 */
export interface FrameSourceLike {
  start(): void;
  stop(): void;
  release(buffer?: ArrayBuffer | ArrayBufferView | null, processMs?: number): void;
  grab(): GrayImage | null;
  destroy(): void;
  frameSize(): Size | null;
  getStats?(): FrameSourceStats;
}

export interface AnchorTrackerOptions {
  /** fps 상한 (엔지니어 30, 고객 20). 기본 30 */
  fps?: number;
  /** 작업 해상도 긴 변 (기본 320) */
  longSide?: number;
  onUpdate?: (u: TrackUpdate) => void;
  trackerConfig?: Partial<TrackerConfig>;
  /** Worker가 죽었을 때 앵커당 되살리기 최대 횟수 (기본 3) */
  maxRestarts?: number;
  /** 테스트·주입용 */
  createWorker?: () => WorkerLike;
  createFrameSource?: (video: HTMLVideoElement, opts: FrameSourceOptions) => FrameSourceLike;
}

export interface AnchorSpec {
  id: string;
  /** 기준 프레임 (작업 해상도 그레이). 복사해서 보내므로 호출측이 계속 써도 된다 */
  ref: GrayImage;
  /** ref 픽셀 ROI */
  roi: Rect;
  /** 있으면 "지금 프레임이 곧 기준"(엔지니어: 단위행렬) — 탐색 없이 바로 tracking */
  initialH?: Mat3 | null;
}

function defaultCreateWorker(): WorkerLike {
  // Turbopack/webpack이 이 형태를 보고 Worker 번들을 따로 만든다 (리터럴 그대로 둘 것)
  return new Worker(new URL("./tracker.worker.ts", import.meta.url), {
    type: "module",
    name: "anchor-tracker",
  }) as unknown as WorkerLike;
}

function isValidGray(g: GrayImage | null | undefined): g is GrayImage {
  return (
    !!g &&
    Number.isInteger(g.width) &&
    Number.isInteger(g.height) &&
    g.width > 0 &&
    g.height > 0 &&
    !!g.data &&
    g.data.length === g.width * g.height
  );
}

interface ActiveAnchor {
  spec: AnchorSpec;
  gen: number;
  restarts: number;
  refSize: Size;
}

export class AnchorTracker {
  private worker: WorkerLike | null = null;
  private readonly source: FrameSourceLike;
  private gen = 0;
  private anchor: ActiveAnchor | null = null;
  private latestUpdate: TrackUpdate | null = null;
  private lastFrameSize: Size | null = null;
  private readonly pending = new Map<number, (info: ReferenceInfo | null) => void>();
  private destroyed = false;
  private inFlight = false;

  constructor(
    video: HTMLVideoElement,
    private readonly opts: AnchorTrackerOptions = {},
  ) {
    const make = opts.createFrameSource ?? ((v, o) => new FrameSource(v, o));
    this.source = make(video, { maxFps: opts.fps ?? 30, longSide: opts.longSide, onFrame: this.handleFrame });
  }

  /**
   * 앵커 설정 (이전 앵커 대체). 기준 설정 결과(ReferenceInfo)로 resolve.
   * 대체·해제·파괴되거나 실패하면 null. 절대 reject하지 않는다.
   */
  setAnchor(spec: AnchorSpec): Promise<ReferenceInfo | null> {
    if (this.destroyed) return Promise.resolve(null);
    if (!isValidGray(spec.ref) || !spec.id) {
      console.warn("[tracker] 잘못된 기준 이미지 — 앵커를 설정하지 않음");
      return Promise.resolve(null);
    }
    const gen = ++this.gen;
    this.flushPending();
    this.anchor = {
      spec: { ...spec, roi: { ...spec.roi }, initialH: spec.initialH ? spec.initialH.slice() : null },
      gen,
      restarts: 0,
      refSize: { width: spec.ref.width, height: spec.ref.height },
    };
    this.latestUpdate = null;
    const p = new Promise<ReferenceInfo | null>((resolve) => this.pending.set(gen, resolve));
    if (!this.postReference(this.anchor, true)) {
      this.failAnchor("Worker를 만들 수 없음");
      return p;
    }
    this.source.start();
    return p;
  }

  clearAnchor(): void {
    if (!this.anchor) return;
    const gen = ++this.gen;
    this.anchor = null;
    this.latestUpdate = null;
    this.flushPending();
    this.source.stop();
    this.safePost({ type: "clear", gen });
  }

  /** 지금 영상 프레임 (작업 해상도 그레이, 새 버퍼). 영상 준비 전이면 null */
  captureGray(): GrayImage | null {
    if (this.destroyed) return null;
    return this.source.grab();
  }

  /** 현재 영상의 작업 해상도 (메타데이터 전이면 null) */
  frameSize(): Size | null {
    return this.source.frameSize();
  }

  latest(): TrackUpdate | null {
    return this.latestUpdate;
  }

  anchorId(): string | null {
    return this.anchor?.spec.id ?? null;
  }

  stats(): FrameSourceStats | null {
    return this.source.getStats?.() ?? null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.anchor = null;
    this.latestUpdate = null;
    this.flushPending();
    this.source.destroy();
    this.killWorker();
  }

  // ───────────────────────── 내부 ─────────────────────────

  private flushPending() {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  private settle(gen: number, info: ReferenceInfo | null) {
    const resolve = this.pending.get(gen);
    if (resolve) {
      this.pending.delete(gen);
      resolve(info);
    }
  }

  private ensureWorker(): WorkerLike | null {
    if (this.worker) return this.worker;
    if (this.destroyed) return null;
    try {
      const w = (this.opts.createWorker ?? defaultCreateWorker)();
      w.onmessage = this.handleMessage;
      w.onerror = this.handleWorkerError;
      w.onmessageerror = this.handleWorkerError;
      if (this.opts.trackerConfig) w.postMessage({ type: "config", config: this.opts.trackerConfig });
      this.worker = w;
      return w;
    } catch (e) {
      console.warn("[tracker] Worker 생성 실패:", e);
      return null;
    }
  }

  private killWorker() {
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    try {
      w.terminate();
    } catch {
      // 무시
    }
    if (this.inFlight) {
      // 돌아오지 않을 프레임 — 버퍼 없이 반환 처리
      this.inFlight = false;
      this.source.release(null);
    }
  }

  private safePost(msg: WorkerRequest, transfer?: Transferable[]): boolean {
    const w = this.worker;
    if (!w) return false;
    try {
      if (transfer) w.postMessage(msg, transfer);
      else w.postMessage(msg);
      return true;
    } catch (e) {
      console.warn("[tracker] Worker로 전송 실패:", e);
      return false;
    }
  }

  private postReference(a: ActiveAnchor, withInitialH: boolean): boolean {
    if (!this.ensureWorker()) return false;
    const { ref, roi, initialH } = a.spec;
    const data = ref.data instanceof Uint8Array ? ref.data : new Uint8Array(ref.data);
    // transfer 없이 보낸다 (구조적 복제 = 복사) → 호출측 이미지와 되살리기용 사본이 그대로 남는다
    return this.safePost({
      type: "setReference",
      gen: a.gen,
      ref: { width: ref.width, height: ref.height, data },
      roi: { ...roi },
      initialH: withInitialH && initialH ? initialH : null,
    });
  }

  private lostUpdate(a: ActiveAnchor): TrackUpdate {
    return {
      anchorId: a.spec.id,
      state: "lost",
      H: null,
      confidence: 0,
      refSize: { ...a.refSize },
      frameSize: this.lastFrameSize ? { ...this.lastFrameSize } : { ...a.refSize },
      processMs: 0,
    };
  }

  private emit(u: TrackUpdate) {
    this.latestUpdate = u;
    try {
      this.opts.onUpdate?.(u);
    } catch (e) {
      console.warn("[tracker] onUpdate 콜백 오류:", e);
    }
  }

  /** 현재 앵커를 더 추적할 수 없음: lost 알리고 루프 정지 (앵커 자체는 유지 — 다음 setAnchor까지) */
  private failAnchor(reason: string) {
    const a = this.anchor;
    if (!a) return;
    console.warn(`[tracker] 추적 중단: ${reason}`);
    this.settle(a.gen, null);
    this.source.stop();
    this.emit(this.lostUpdate(a));
  }

  /** Worker 쪽 추적기가 기준을 잃었을 때: 새 세대로 기준을 다시 보내 탐색 모드로 재개 */
  private recover(reason: string) {
    const a = this.anchor;
    if (!a) return;
    const max = this.opts.maxRestarts ?? 3;
    if (a.restarts >= max) {
      this.failAnchor(`${reason} (재시도 ${max}회 초과)`);
      return;
    }
    console.warn(`[tracker] ${reason} — 탐색 모드로 재개`);
    a.restarts++;
    const prevGen = a.gen;
    a.gen = ++this.gen;
    // 이전 세대의 setAnchor 약속은 새 세대 결과로 이어받는다
    const resolve = this.pending.get(prevGen);
    if (resolve) {
      this.pending.delete(prevGen);
      this.pending.set(a.gen, resolve);
    }
    this.emit(this.lostUpdate(a));
    // 자세를 모르므로 initialH 없이 (ORB 탐색)
    if (!this.postReference(a, false)) this.failAnchor("Worker를 만들 수 없음");
  }

  private handleFrame = (frame: GrayImage, ts: number) => {
    const a = this.anchor;
    if (this.destroyed || !a || !this.worker) {
      this.source.release(frame.data);
      return;
    }
    const data =
      frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.length);
    const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
    const ok = this.safePost(
      { type: "frame", gen: a.gen, frame: { width: frame.width, height: frame.height, data }, ts },
      whole ? [data.buffer as ArrayBuffer] : undefined,
    );
    if (ok) this.inFlight = true;
    else this.source.release(whole ? null : data);
  };

  private handleMessage = (e: MessageEvent) => {
    const m = e.data as WorkerResponse | null;
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "ready":
        return;
      case "reference": {
        if (m.error) console.warn("[tracker] 기준 설정 오류:", m.error);
        this.settle(m.gen, m.info);
        const a = this.anchor;
        if (a && a.gen === m.gen && !m.info) this.failAnchor("기준 설정 실패");
        return;
      }
      case "result": {
        this.inFlight = false;
        const data = m.frame?.data;
        this.source.release(data instanceof Uint8Array && data.byteLength > 0 ? data : null, m.processMs);
        const a = this.anchor;
        if (!a || m.gen !== a.gen) return;
        if (!m.result) {
          if (m.error) this.recover(`추적기 오류: ${m.error}`);
          return;
        }
        const r = m.result;
        const frameSize = { width: m.frame.width, height: m.frame.height };
        this.lastFrameSize = frameSize;
        const shown = (r.state === "tracking" || r.state === "weak") && Array.isArray(r.H) && r.H.length === 9;
        this.emit({
          anchorId: a.spec.id,
          state: r.state,
          H: shown ? r.H : null,
          confidence: r.confidence,
          refSize: { ...a.refSize },
          frameSize,
          processMs: m.processMs,
        });
        return;
      }
      case "error":
        console.warn("[tracker] Worker 오류 응답:", m.message);
        return;
    }
  };

  private handleWorkerError = (e: Event) => {
    const detail = (e as ErrorEvent).message ?? e.type;
    console.warn("[tracker] Worker 오류:", detail);
    this.killWorker();
    const a = this.anchor;
    if (!a) {
      this.flushPending();
      return;
    }
    this.recover(`Worker 오류: ${detail}`);
  };
}
