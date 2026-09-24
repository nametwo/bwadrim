import type { GrayImage } from "./types";
import { rgbaToGray } from "./cv/color";

// <video> → 작업 해상도 그레이 프레임 (README "런타임").
//
// - requestVideoFrameCallback으로 새 프레임마다 깨어난다 (없으면 rAF + currentTime 변화 감지)
// - 한 번에 1장만 in-flight: 소비자(Worker)가 release()로 돌려줄 때까지 다음 프레임을 잡지 않는다
// - fps 상한 + 적응형: 처리 시간(EMA)이 길면 간격을 늘려 저가 폰의 CPU 여유를 남긴다
// - 탭이 숨겨지면 멈추고, 보이면 이어서
// - 긴 변을 항상 WORKING_LONG_SIDE로 맞춘다 (확대 포함). 통화 중 수신 해상도가 바뀌어도
//   작업 좌표계의 기하가 그대로여서 추적이 끊기지 않는다. 비율이 바뀌면(회전) 크기가 바뀐다.
// - 축소는 단계별(한 단계 ≤ 2배)로 해서 쌍선형 보간이 면적 평균에 가깝게 (앨리어싱 방지)
// - 버퍼 재사용: 돌려받은 버퍼를 풀에 넣고 다음 프레임에 다시 쓴다
//
// import 시점에 window/document를 건드리지 않는다 (SSR 안전).

export const WORKING_LONG_SIDE = 320;

export interface Size {
  width: number;
  height: number;
}

/** 영상 크기 → 작업 해상도 (긴 변 longSide, 비율 유지). 크기를 모르면 null */
export function workingSize(videoWidth: number, videoHeight: number, longSide = WORKING_LONG_SIDE): Size | null {
  if (!(videoWidth > 0) || !(videoHeight > 0) || !Number.isFinite(videoWidth) || !Number.isFinite(videoHeight)) {
    return null;
  }
  if (videoWidth >= videoHeight) {
    return { width: longSide, height: Math.max(1, Math.round((videoHeight * longSide) / videoWidth)) };
  }
  return { width: Math.max(1, Math.round((videoWidth * longSide) / videoHeight)), height: longSide };
}

/**
 * 단계별 축소의 중간 크기들 (최종 크기 제외). 한 단계 배율이 2 이하가 될 때까지 반씩 줄인다.
 * 2배 쌍선형 축소 = 2×2 평균이므로 결과가 면적 평균 축소에 가깝다.
 */
export function downscaleSteps(sw: number, sh: number, dw: number, dh: number): Size[] {
  const steps: Size[] = [];
  let w = sw;
  let h = sh;
  while (w / dw > 2 || h / dh > 2) {
    w = Math.max(dw, Math.round(w / 2));
    h = Math.max(dh, Math.round(h / 2));
    if (w === dw && h === dh) break;
    steps.push({ width: w, height: h });
    if (steps.length > 8) break;
  }
  return steps;
}

/**
 * 프레임 간격 조절.
 * - 기본 간격 1000/maxFps, 처리 시간 EMA × headroom이 더 길면 그쪽 (적응형)
 * - 오차 확산: 다음 기한을 '지금+간격'이 아니라 '이전 기한+간격'으로 → 30fps 영상에서 20fps 상한이면 3장 중 2장
 */
export class RateController {
  private emaMs = 0;
  private hasEma = false;
  private nextDue = 0;
  private started = false;

  constructor(
    private maxFps: number,
    private readonly opts: { headroom?: number; minFps?: number; alpha?: number; toleranceMs?: number } = {},
  ) {}

  setMaxFps(fps: number) {
    this.maxFps = fps;
  }

  /** 현재 목표 간격 (ms) */
  intervalMs(): number {
    const base = 1000 / Math.max(0.1, this.maxFps);
    const adaptive = this.hasEma ? this.emaMs * (this.opts.headroom ?? 1.5) : 0;
    const floor = 1000 / (this.opts.minFps ?? 2);
    return Math.max(base, Math.min(floor, adaptive));
  }

  processMsEma(): number {
    return this.emaMs;
  }

  ready(now: number): boolean {
    return !this.started || now >= this.nextDue - (this.opts.toleranceMs ?? 4);
  }

  onGrab(now: number) {
    const iv = this.intervalMs();
    if (!this.started || now - this.nextDue > iv) this.nextDue = now + iv;
    else this.nextDue += iv;
    this.started = true;
  }

  onProcessed(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const a = this.opts.alpha ?? 0.2;
    this.emaMs = this.hasEma ? this.emaMs + a * (ms - this.emaMs) : ms;
    this.hasEma = true;
  }

  /** 간격 위상만 초기화 (EMA는 유지 — 같은 기기) */
  resetPhase() {
    this.started = false;
  }
}

/**
 * 추적기에 넘길 타임스탬프. 프레임의 미디어 시각(ms)을 우선 쓰고(표시 시각보다 촬영 간격에 가깝다),
 * 없거나 거꾸로 가거나 크게 튀면 직전 값 + 벽시계 경과로 대신한다. 항상 단조 증가.
 */
export class FrameClock {
  private last = Number.NEGATIVE_INFINITY;
  private lastWall = 0;

  next(mediaMs: number | undefined, wallMs: number): number {
    let ts: number;
    const first = this.last === Number.NEGATIVE_INFINITY;
    if (mediaMs !== undefined && Number.isFinite(mediaMs) && (first || (mediaMs > this.last && mediaMs - this.last < 2000))) {
      ts = mediaMs;
    } else if (first) {
      ts = wallMs;
    } else {
      ts = this.last + Math.min(2000, Math.max(1, wallMs - this.lastWall));
    }
    this.last = ts;
    this.lastWall = wallMs;
    return ts;
  }
}

// ───────────────────────── 캔버스 ─────────────────────────

export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function defaultCreateCanvas(width: number, height: number): CanvasLike {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  throw new Error("canvas unavailable");
}

export function get2d(canvas: CanvasLike, willReadFrequently: boolean): Ctx2D | null {
  const opts: CanvasRenderingContext2DSettings = { alpha: false, willReadFrequently };
  return (canvas as HTMLCanvasElement).getContext("2d", opts) as Ctx2D | null;
}

/**
 * 고품질 축소기: 중간 캔버스(GPU)로 단계 축소 → 최종 캔버스(willReadFrequently, CPU 읽기용).
 * 캔버스는 크기가 바뀔 때만 다시 잡는다.
 */
export class CanvasScaler {
  private stages: { canvas: CanvasLike; ctx: Ctx2D }[] = [];
  private final: { canvas: CanvasLike; ctx: Ctx2D } | null = null;

  constructor(
    private readonly createCanvas: (w: number, h: number) => CanvasLike = defaultCreateCanvas,
    private readonly finalWillRead = true,
  ) {}

  /** src(sw×sh)를 dw×dh로 그린 최종 컨텍스트. 실패하면 null */
  draw(src: CanvasImageSource, sw: number, sh: number, dw: number, dh: number): Ctx2D | null {
    const steps = downscaleSteps(sw, sh, dw, dh);
    let source: CanvasImageSource = src;
    for (let i = 0; i < steps.length; i++) {
      const st = this.stage(i, steps[i], false);
      if (!st) return null;
      prep(st.ctx);
      st.ctx.drawImage(source, 0, 0, steps[i].width, steps[i].height);
      source = st.canvas as CanvasImageSource;
    }
    const fin = this.finalStage(dw, dh);
    if (!fin) return null;
    prep(fin.ctx);
    fin.ctx.drawImage(source, 0, 0, dw, dh);
    return fin.ctx;
  }

  /** 최종 캔버스 (JPEG 인코딩 등에 쓴다) */
  finalCanvas(): CanvasLike | null {
    return this.final?.canvas ?? null;
  }

  private stage(i: number, size: Size, willRead: boolean) {
    let st: { canvas: CanvasLike; ctx: Ctx2D } | undefined = this.stages[i];
    if (!st) {
      const canvas = this.createCanvas(size.width, size.height);
      const ctx = get2d(canvas, willRead);
      if (!ctx) return null;
      st = { canvas, ctx };
      this.stages[i] = st;
    } else if (st.canvas.width !== size.width || st.canvas.height !== size.height) {
      st.canvas.width = size.width;
      st.canvas.height = size.height;
    }
    return st;
  }

  private finalStage(w: number, h: number) {
    if (!this.final) {
      const canvas = this.createCanvas(w, h);
      const ctx = get2d(canvas, this.finalWillRead);
      if (!ctx) return null;
      this.final = { canvas, ctx };
    } else if (this.final.canvas.width !== w || this.final.canvas.height !== h) {
      this.final.canvas.width = w;
      this.final.canvas.height = h;
    }
    return this.final;
  }
}

function prep(ctx: Ctx2D) {
  // 캔버스 크기를 바꾸면 상태가 초기화되므로 매번 설정 (싸다)
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
}

// ───────────────────────── 프레임 소스 ─────────────────────────

/** FrameSource가 쓰는 비디오 속성 (테스트용 가짜를 넣을 수 있게) */
export type VideoLike = Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "readyState" | "currentTime"> & {
  requestVideoFrameCallback?: (cb: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface FrameSourceEnv {
  now(): number;
  requestAnimationFrame(cb: (t: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  createCanvas(width: number, height: number): CanvasLike;
  isHidden(): boolean;
  /** 가시성 변화 구독. 반환값은 해제 함수 */
  onVisibilityChange(cb: () => void): () => void;
}

function browserEnv(): FrameSourceEnv {
  return {
    now: () => performance.now(),
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    cancelAnimationFrame: (h) => cancelAnimationFrame(h),
    createCanvas: defaultCreateCanvas,
    isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    onVisibilityChange: (cb) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
  };
}

export interface FrameSourceOptions {
  /** fps 상한 (고객 20, 엔지니어 30) */
  maxFps: number;
  /** 작업 해상도 긴 변 (기본 320) */
  longSide?: number;
  /**
   * 새 프레임. frame.data는 소비자에게 넘어간다 (Worker로 transfer 가능, 버퍼 전체를 차지).
   * 처리가 끝나면 반드시 release()를 불러야 다음 프레임이 온다.
   */
  onFrame: (frame: GrayImage, timestampMs: number) => void;
  /** 적응형 간격의 여유 배수 (기본 1.5 → Worker 점유율 ≤ ~67%) */
  headroom?: number;
  env?: Partial<FrameSourceEnv>;
}

export interface FrameSourceStats {
  grabbed: number;
  /** in-flight 또는 fps 상한 때문에 건너뛴 새 영상 프레임 */
  skipped: number;
  intervalMs: number;
  processMsEma: number;
}

/** 반환되지 않은 in-flight 프레임을 포기하는 시간 (Worker가 죽은 경우 등) */
const STALL_MS = 3000;
const POOL_MAX = 3;

export class FrameSource {
  private readonly env: FrameSourceEnv;
  private readonly longSide: number;
  private readonly rate: RateController;
  private readonly clock = new FrameClock();
  private scaler: CanvasScaler | null = null;
  private running = false;
  private destroyed = false;
  private inFlight = false;
  private inFlightSince = 0;
  private newFrame = false;
  private mediaMs: number | undefined = undefined;
  private lastCurrentTime = Number.NaN;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private offVisibility: (() => void) | null = null;
  private pool: Uint8Array[] = [];
  private warned = false;
  private stats: FrameSourceStats = { grabbed: 0, skipped: 0, intervalMs: 0, processMsEma: 0 };

  constructor(
    private readonly video: VideoLike,
    private readonly opts: FrameSourceOptions,
  ) {
    this.env = { ...browserEnv(), ...opts.env };
    this.longSide = opts.longSide ?? WORKING_LONG_SIDE;
    this.rate = new RateController(opts.maxFps, { headroom: opts.headroom });
  }

  isRunning(): boolean {
    return this.running;
  }

  setMaxFps(fps: number) {
    this.rate.setMaxFps(fps);
  }

  getStats(): FrameSourceStats {
    return { ...this.stats, intervalMs: this.rate.intervalMs(), processMsEma: this.rate.processMsEma() };
  }

  /** 현재 영상 기준 작업 해상도 (메타데이터 전이면 null) */
  frameSize(): Size | null {
    return workingSize(this.video.videoWidth, this.video.videoHeight, this.longSide);
  }

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.newFrame = true; // 시작하자마자 현재 프레임 하나 (멈춘 영상이어도)
    this.rate.resetPhase();
    this.offVisibility = this.env.onVisibilityChange(this.handleVisibility);
    this.schedule();
    this.tryGrab();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelScheduled();
    this.offVisibility?.();
    this.offVisibility = null;
  }

  /**
   * in-flight 프레임 처리 끝. 버퍼를 돌려주면 재사용한다 (Worker에서 되돌아온 ArrayBuffer도 된다).
   * processMs는 적응형 간격에 쓰인다.
   */
  release(buffer?: ArrayBuffer | ArrayBufferView | null, processMs?: number): void {
    this.inFlight = false;
    if (processMs !== undefined) this.rate.onProcessed(processMs);
    if (buffer) {
      const arr =
        buffer instanceof Uint8Array
          ? buffer
          : ArrayBuffer.isView(buffer)
            ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
            : new Uint8Array(buffer);
      // 풀에는 버퍼 전체를 차지하는 배열만 (transfer 가능해야 한다)
      if (arr.byteLength > 0 && arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength && this.pool.length < POOL_MAX) {
        this.pool.push(arr);
      }
    }
    // 기다리는 새 프레임이 있으면 바로 (다음 영상 프레임까지 기다리지 않는다)
    if (this.running && this.newFrame) this.tryGrab();
  }

  /** 지금 영상 프레임을 작업 해상도 그레이로 (새 버퍼, 풀과 무관). 영상이 준비 전이면 null */
  grab(): GrayImage | null {
    if (this.destroyed) return null;
    return this.capture(undefined);
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    this.pool = [];
    this.scaler = null;
  }

  // ───────────────────────── 내부 ─────────────────────────

  private schedule() {
    if (!this.running || this.destroyed) return;
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === "function") {
      if (this.rvfcHandle === null) this.rvfcHandle = v.requestVideoFrameCallback(this.handleVideoFrame);
    } else if (this.rafHandle === null) {
      this.rafHandle = this.env.requestAnimationFrame(this.handleAnimationFrame);
    }
  }

  private cancelScheduled() {
    if (this.rvfcHandle !== null) {
      try {
        this.video.cancelVideoFrameCallback?.(this.rvfcHandle);
      } catch {
        // 무시
      }
      this.rvfcHandle = null;
    }
    if (this.rafHandle !== null) {
      this.env.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private handleVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    this.rvfcHandle = null;
    if (!this.running) return;
    if (this.newFrame) this.stats.skipped++;
    this.newFrame = true;
    this.mediaMs = Number.isFinite(meta?.mediaTime) ? meta.mediaTime * 1000 : undefined;
    this.tryGrab();
    this.schedule();
  };

  private handleAnimationFrame = () => {
    this.rafHandle = null;
    if (!this.running) return;
    const t = this.video.currentTime;
    if (t !== this.lastCurrentTime) {
      if (this.newFrame) this.stats.skipped++;
      this.lastCurrentTime = t;
      this.newFrame = true;
      this.mediaMs = Number.isFinite(t) ? t * 1000 : undefined;
    }
    this.tryGrab();
    this.schedule();
  };

  private handleVisibility = () => {
    if (!this.running) return;
    if (this.env.isHidden()) {
      this.cancelScheduled();
    } else {
      this.newFrame = true;
      this.rate.resetPhase();
      this.cancelScheduled();
      this.schedule();
      this.tryGrab();
    }
  };

  private tryGrab() {
    if (!this.running || !this.newFrame || this.env.isHidden()) return;
    const now = this.env.now();
    if (this.inFlight) {
      if (now - this.inFlightSince < STALL_MS) return;
      this.inFlight = false; // 돌아오지 않는 프레임 — 포기
    }
    if (!this.rate.ready(now)) return;
    const size = this.frameSize();
    if (!size) return;
    const frame = this.capture(this.takeBuffer(size.width * size.height));
    if (!frame) return;
    this.newFrame = false;
    this.inFlight = true;
    this.inFlightSince = now;
    this.rate.onGrab(now);
    this.stats.grabbed++;
    const ts = this.clock.next(this.mediaMs, now);
    try {
      this.opts.onFrame(frame, ts);
    } catch (e) {
      console.warn("[frame-source] onFrame 오류:", e);
      this.inFlight = false;
    }
  }

  private takeBuffer(n: number): Uint8Array | undefined {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const b = this.pool[i];
      if (b.length === n) {
        this.pool.splice(i, 1);
        return b;
      }
    }
    // 크기가 바뀌었으면(회전) 옛 버퍼는 버린다
    this.pool.length = 0;
    return undefined;
  }

  private capture(out: Uint8Array | undefined): GrayImage | null {
    const v = this.video;
    // HAVE_CURRENT_DATA(2) 전에는 그릴 프레임이 없다
    if (v.readyState < 2) return null;
    const size = this.frameSize();
    if (!size) return null;
    try {
      if (!this.scaler) this.scaler = new CanvasScaler(this.env.createCanvas, true);
      const ctx = this.scaler.draw(v as unknown as CanvasImageSource, v.videoWidth, v.videoHeight, size.width, size.height);
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, size.width, size.height);
      return rgbaToGray(img.data, size.width, size.height, out);
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[frame-source] 프레임 캡처 실패:", e);
      }
      return null;
    }
  }
}
