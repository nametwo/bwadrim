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
// - 획득 방식은 아래 "프레임 소스" 참고: VideoFrame을 Worker로 넘기는 것이 기본 (메인 스레드는 픽셀을 안 만짐).
//   VideoFrame 경로의 축소 = Y 평면 정확한 면적 평균 (벤치 downscaleArea와 비트 단위로 같음, limited→full 변환 포함).
//   캔버스 경로(대안)는 단계별(한 단계 ≤ 2배) 쌍선형으로 면적 평균에 가깝게 (Chromium 실측: 정확한 값과 평균 0.86계조 차이)
// - 버퍼 재사용: 돌려받은 버퍼를 풀에 넣고 다음 프레임에 다시 쓴다. VideoFrame 복사 버퍼도 재사용 (프레임마다 할당 없음)
// - 같은 <video>에 새 srcObject(카메라 전환)·크기 변화(회전) → emptied/loadedmetadata/resize에서 예약을 다시 건다
//
// 실측 (Chromium 141 headless, CDP CPU 4배 감속, 프레임당 메인 스레드 TaskDuration, 빈 루프 기준선 뺌):
//   640×480  canvas 11.9ms · videoframe(메인 읽기) 2.2ms · videoframe-worker 0.9ms · createImageBitmap 16~17ms
//   1280×720 canvas 36.1ms · videoframe 9.4ms · videoframe-worker 0.9ms
//   1920×1080 canvas 62ms · videoframe 19ms · videoframe-worker 0.6ms
//   (GPU 없는 환경이라 캔버스가 소프트웨어 — willReadFrequently 캔버스는 실기기에서도 CPU다)
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

// ───────────────────────── 면적 평균 리샘플 (벤치와 같은 필터) ─────────────────────────
//
// 축소는 정확한 면적 평균 (scripts/tracking-bench/imageops.ts downscaleArea와 같은 겹침 가중치·반올림:
// floor(평균 + 0.5 + 1e-4)). 정수배면 박스 합 + 조회표(LUT)로 정수 연산만 한다 (2배 = 2×2 평균).
// 확대(수신 해상도가 작업 해상도보다 작을 때)는 픽셀 중심 정렬 선형 보간 (캔버스 확대와 같은 종류).
// limited(16~235) 휘도는 (Y−16)·255/219로 전체 범위로 편다 — 캔버스 경로의 YUV→RGB→회색과 같은 값
// (BT.601 행렬이면 색차 항이 상쇄되어 회색 = 1.164·(Y−16)).

interface AxisWeights {
  start: Int32Array;
  count: Int32Array;
  w: Float32Array;
  stride: number;
}

const axisCache = new Map<string, AxisWeights>();

function axisWeights(src: number, dst: number): AxisWeights {
  const key = `${src}>${dst}`;
  const hit = axisCache.get(key);
  if (hit) return hit;
  let res: AxisWeights;
  if (dst <= src) {
    // 면적 평균: 출력 칸 i = 입력 구간 [i·r, (i+1)·r)
    const r = src / dst;
    const stride = Math.ceil(r) + 2;
    const start = new Int32Array(dst);
    const count = new Int32Array(dst);
    const w = new Float32Array(dst * stride);
    for (let i = 0; i < dst; i++) {
      const a = i * r;
      const b = (i + 1) * r;
      const s0 = Math.floor(a);
      const s1 = Math.min(src, Math.ceil(b - 1e-9));
      start[i] = s0;
      count[i] = s1 - s0;
      for (let k = s0; k < s1; k++) w[i * stride + (k - s0)] = (Math.min(b, k + 1) - Math.max(a, k)) / r;
    }
    res = { start, count, w, stride };
  } else {
    // 선형 보간 (픽셀 중심 정렬, 가장자리 복제)
    const r = src / dst;
    const start = new Int32Array(dst);
    const count = new Int32Array(dst);
    const w = new Float32Array(dst * 2);
    for (let i = 0; i < dst; i++) {
      const s = Math.min(src - 1, Math.max(0, (i + 0.5) * r - 0.5));
      const s0 = Math.min(src - 1, Math.floor(s));
      const f = s - s0;
      start[i] = s0;
      if (s0 + 1 < src && f > 1e-9) {
        count[i] = 2;
        w[i * 2] = 1 - f;
        w[i * 2 + 1] = f;
      } else {
        count[i] = 1;
        w[i * 2] = 1;
      }
    }
    res = { start, count, w, stride: 2 };
  }
  if (axisCache.size > 32) axisCache.clear();
  axisCache.set(key, res);
  return res;
}

const LIMITED_SCALE = 255 / 219;
const boxLutCache = new Map<string, Uint8Array>();

/** 박스 합(0..255·area) → 출력 값 (평균 + 반올림 + 범위 변환) */
function boxLut(area: number, limited: boolean): Uint8Array {
  const key = `${area}:${limited ? 1 : 0}`;
  let lut = boxLutCache.get(key);
  if (lut) return lut;
  lut = new Uint8Array(255 * area + 1);
  for (let s = 0; s < lut.length; s++) {
    let v = s / area;
    if (limited) v = (v - 16) * LIMITED_SCALE;
    const q = Math.floor(v + 0.5 + 1e-4);
    lut[s] = q < 0 ? 0 : q > 255 ? 255 : q;
  }
  if (boxLutCache.size > 16) boxLutCache.clear();
  boxLutCache.set(key, lut);
  return lut;
}

let resampleTmp: Float32Array | null = null;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const M = 0x00ff00ff;

/**
 * 2·4·6배 정사각 박스를 32비트 읽기로 (한 번에 4바이트, 바이트 쌍 합을 16비트 칸 두 개에 나눠 담는다).
 * 칸 하나에 쌓이는 최대값: 6배에서 6행 × 510 = 3060 < 65536. 조건이 안 맞으면 false (호출측이 일반 경로).
 */
function swarBox(
  src: Uint8Array | Uint8ClampedArray,
  stride: number,
  sx: number,
  sy: number,
  dst: Uint8Array,
  dw: number,
  dh: number,
  k: number,
  lut: Uint8Array,
): boolean {
  const base = src.byteOffset + sy * stride + sx;
  if (!LITTLE_ENDIAN || (base & 3) !== 0 || (stride & 3) !== 0) return false;
  // 한 번에 처리하는 출력 칸: 2배 = 2칸(4바이트), 4배 = 1칸(4바이트), 6배 = 2칸(12바이트)
  const group = k === 4 ? 1 : 2;
  if (dw % group !== 0) return false;
  const span = (dh * k - 1) * stride + dw * k; // 읽는 범위 (바이트)
  const len = (span + 3) >> 2;
  if (base + len * 4 > src.buffer.byteLength) return false;
  const W = new Uint32Array(src.buffer, base, len);
  const ws = stride >> 2;
  if (k === 2) {
    for (let y = 0; y < dh; y++) {
      let a = 2 * y * ws;
      let b = a + ws;
      let o = y * dw;
      for (let x = 0; x < dw; x += 2, a++, b++, o += 2) {
        const p = W[a];
        const q = W[b];
        const s = (p & M) + ((p >>> 8) & M) + (q & M) + ((q >>> 8) & M);
        dst[o] = lut[s & 0xffff];
        dst[o + 1] = lut[s >>> 16];
      }
    }
    return true;
  }
  if (k === 4) {
    for (let y = 0; y < dh; y++) {
      const r0 = 4 * y * ws;
      let o = y * dw;
      for (let x = 0; x < dw; x++, o++) {
        let i = r0 + x;
        let s = 0;
        for (let j = 0; j < 4; j++, i += ws) {
          const p = W[i];
          s += (p & M) + ((p >>> 8) & M);
        }
        dst[o] = lut[(s & 0xffff) + (s >>> 16)];
      }
    }
    return true;
  }
  // k === 6: 12바이트(워드 3개) = 출력 2칸. 칸0 = w0 전체 + w1 아래 2바이트, 칸1 = w1 위 2바이트 + w2 전체
  for (let y = 0; y < dh; y++) {
    const r0 = 6 * y * ws;
    let o = y * dw;
    for (let x = 0; x < dw; x += 2, o += 2) {
      let i = r0 + (x >> 1) * 3;
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let j = 0; j < 6; j++, i += ws) {
        const p0 = W[i];
        const p1 = W[i + 1];
        const p2 = W[i + 2];
        a0 += (p0 & M) + ((p0 >>> 8) & M);
        a1 += (p1 & M) + ((p1 >>> 8) & M);
        a2 += (p2 & M) + ((p2 >>> 8) & M);
      }
      dst[o] = lut[(a0 & 0xffff) + (a0 >>> 16) + (a1 & 0xffff)];
      dst[o + 1] = lut[(a1 >>> 16) + (a2 & 0xffff) + (a2 >>> 16)];
    }
  }
  return true;
}

/**
 * 8비트 평면(행 간격 stride)의 사각형 (sx, sy, sw, sh) → dst (dw×dh, 행 간격 dw).
 * 축소 = 면적 평균, 확대 = 선형 보간. limited면 16~235 → 0~255.
 */
export function resamplePlane(
  src: Uint8Array | Uint8ClampedArray,
  stride: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dst: Uint8Array,
  dw: number,
  dh: number,
  limited = false,
): void {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0) || dst.length < dw * dh) throw new RangeError("resamplePlane: bad size");
  const kx = sw / dw;
  const ky = sh / dh;
  if (Number.isInteger(kx) && Number.isInteger(ky)) {
    const lut = boxLut(kx * ky, limited);
    if (kx === ky && (kx === 2 || kx === 4 || kx === 6) && swarBox(src, stride, sx, sy, dst, dw, dh, kx, lut)) return;
    if (kx === 2 && ky === 2) {
      for (let y = 0; y < dh; y++) {
        let a = (sy + 2 * y) * stride + sx;
        let b = a + stride;
        let o = y * dw;
        for (let x = 0; x < dw; x++, a += 2, b += 2, o++) dst[o] = lut[src[a] + src[a + 1] + src[b] + src[b + 1]];
      }
      return;
    }
    for (let y = 0; y < dh; y++) {
      const row0 = (sy + ky * y) * stride + sx;
      let o = y * dw;
      for (let x = 0; x < dw; x++, o++) {
        let s = 0;
        let r = row0 + kx * x;
        for (let j = 0; j < ky; j++, r += stride) for (let i = 0; i < kx; i++) s += src[r + i];
        dst[o] = lut[s];
      }
    }
    return;
  }
  // 일반: 분리형 (가로 → float 임시, 세로 → 출력)
  const hw = axisWeights(sw, dw);
  const vw = axisWeights(sh, dh);
  const need = dw * sh;
  if (!resampleTmp || resampleTmp.length < need) resampleTmp = new Float32Array(need);
  const tmp = resampleTmp;
  for (let y = 0; y < sh; y++) {
    const row = (sy + y) * stride + sx;
    const to = y * dw;
    for (let x = 0; x < dw; x++) {
      const s0 = row + hw.start[x];
      const n = hw.count[x];
      const wo = x * hw.stride;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += src[s0 + k] * hw.w[wo + k];
      tmp[to + x] = acc;
    }
  }
  for (let y = 0; y < dh; y++) {
    const s0 = vw.start[y];
    const n = vw.count[y];
    const wo = y * vw.stride;
    const o = y * dw;
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += tmp[(s0 + k) * dw + x] * vw.w[wo + k];
      if (limited) acc = (acc - 16) * LIMITED_SCALE;
      const q = Math.floor(acc + 0.5 + 1e-4);
      dst[o + x] = q < 0 ? 0 : q > 255 ? 255 : q;
    }
  }
}

// ───────────────────────── VideoFrame → 작업 해상도 그레이 ─────────────────────────

/** VideoFrame에서 쓰는 부분 (테스트용 가짜를 넣을 수 있게) */
export interface VideoFrameLike {
  readonly format: string | null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: { x: number; y: number; width: number; height: number } | null;
  readonly colorSpace?: { fullRange?: boolean | null } | null;
  /** Chrome 13x+: 표시할 때 적용할 회전·반전. 0/false가 아니면 픽셀이 화면과 다른 방향 */
  readonly rotation?: number;
  readonly flip?: boolean;
  allocationSize(options?: { rect?: DOMRectInit; format?: string }): number;
  copyTo(dest: AllowSharedBufferSource, options?: { rect?: DOMRectInit; format?: string }): Promise<PlaneLayout[]>;
  close(): void;
}

const YUV_FORMATS = new Set(["I420", "I420A", "I422", "I422A", "I444", "I444A", "NV12", "NV12A"]);
const RGB_FORMATS: Record<string, [number, number, number]> = {
  RGBA: [0, 1, 2],
  RGBX: [0, 1, 2],
  BGRA: [2, 1, 0],
  BGRX: [2, 1, 0],
};

/** 이 프레임을 읽을 수 없는 이유 (그 뒤로 이 방식을 쓰지 않는다) */
export class UnsupportedFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFrameError";
  }
}

/**
 * VideoFrame → 작업 해상도 그레이 (Y 평면 직접 읽기 + 면적 평균). Worker에서 쓴다 (VideoFrame은 transfer 가능).
 * 복사 버퍼는 재사용한다 (프레임마다 할당하지 않음). 한 번에 하나씩만 (copyTo 대기 중 재진입 금지).
 * 프레임은 닫지 않는다 — 호출측 책임.
 */
export class VideoFrameReader {
  private buf: Uint8Array | null = null;
  private lum: Uint8Array | null = null;
  private busy = false;

  async read(vf: VideoFrameLike, width: number, height: number, out?: Uint8Array): Promise<GrayImage> {
    if (this.busy) throw new Error("VideoFrameReader: concurrent read");
    if (vf.rotation || vf.flip) throw new UnsupportedFrameError(`rotated frame (${vf.rotation ?? 0}, flip=${!!vf.flip})`);
    const rect = vf.visibleRect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) throw new UnsupportedFrameError("no visible rect");
    const n = width * height;
    const data = out && out.length === n ? out : new Uint8Array(n);
    this.busy = true;
    try {
      const fmt = vf.format;
      if (fmt && YUV_FORMATS.has(fmt)) {
        const layout = await vf.copyTo(this.buffer(vf.allocationSize()));
        const y = layout[0];
        // Y 평면: rect 전체 (copyTo 기본 rect = visibleRect, 좌상단부터 촘촘히)
        const limited = vf.colorSpace?.fullRange !== true;
        resamplePlane(this.buf!.subarray(y.offset), y.stride, 0, 0, rect.width, rect.height, data, width, height, limited);
        return { width, height, data };
      }
      let order = fmt ? RGB_FORMATS[fmt] : undefined;
      let opts: { format: string } | undefined;
      if (!order) {
        // 불투명(GPU) 프레임 등: 지원하면 RGBA로 변환해 받는다 (Chrome copyTo format 옵션)
        order = RGB_FORMATS.RGBA;
        opts = { format: "RGBA" };
      }
      let size: number;
      try {
        size = vf.allocationSize(opts);
      } catch (e) {
        throw new UnsupportedFrameError(`format ${fmt ?? "null"}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const layout = await vf.copyTo(this.buffer(size), opts);
      const { offset, stride } = layout[0];
      const w = rect.width;
      const h = rect.height;
      if (!this.lum || this.lum.length < w * h) this.lum = new Uint8Array(w * h);
      const lum = this.lum;
      const src = this.buf!;
      const [ri, gi, bi] = order;
      for (let yy = 0; yy < h; yy++) {
        let s = offset + yy * stride;
        let o = yy * w;
        for (let xx = 0; xx < w; xx++, s += 4, o++) {
          // cv/color.ts rgbaToGray와 같은 식
          lum[o] = (src[s + ri] * 77 + src[s + gi] * 150 + src[s + bi] * 29) >> 8;
        }
      }
      resamplePlane(lum, w, 0, 0, w, h, data, width, height, false);
      return { width, height, data };
    } finally {
      this.busy = false;
    }
  }

  private buffer(size: number): Uint8Array {
    if (!this.buf || this.buf.byteLength < size) this.buf = new Uint8Array(size);
    return this.buf;
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
//
// 획득 방식 (메인 스레드 비용 순, 실측은 README "프레임 획득"):
//   videoframe-worker — new VideoFrame(video)만 메인에서, Worker로 transfer → Worker가 Y 평면을 읽어 면적 평균.
//                       메인 비용 = 프레임 생성 + postMessage. 소비자(onPacket)가 Worker로 넘길 때만.
//   videoframe        — 같은 읽기를 메인에서 (copyTo + JS 면적 평균). Worker가 VideoFrame을 못 받을 때.
//   canvas            — drawImage + getImageData + 회색 변환 (VideoFrame이 없는 브라우저: Safari < 16.4 등).
// 기능 검사로 고르고, 실행 중 실패하면(형식·회전·전송 오류) 다음 방식으로 내려간다 (demote, 되돌리지 않음).
// createImageBitmap(video, resize) 경로는 Chromium에서 크기 조정이 메인 스레드에서 동기로 돌아
// 캔버스보다 느려서 쓰지 않는다.

export type AcquisitionMode = "videoframe-worker" | "videoframe" | "canvas";

/** 소비자에게 넘기는 한 장. videoframe이면 소비자가 반드시 close()하거나 transfer해야 한다 */
export type FramePacket =
  | { kind: "gray"; frame: GrayImage; mode: "videoframe" | "canvas" }
  | { kind: "videoframe"; frame: VideoFrameLike; width: number; height: number };

/** FrameSource가 쓰는 비디오 속성 (테스트용 가짜를 넣을 수 있게) */
export type VideoLike = Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "readyState" | "currentTime"> & {
  requestVideoFrameCallback?: (cb: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
};

export interface FrameSourceEnv {
  now(): number;
  requestAnimationFrame(cb: (t: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  createCanvas(width: number, height: number): CanvasLike;
  isHidden(): boolean;
  /** 가시성 변화 구독. 반환값은 해제 함수 */
  onVisibilityChange(cb: () => void): () => void;
  /** VideoFrame(+copyTo)을 쓸 수 있는지 */
  supportsVideoFrame?(): boolean;
  /** 지금 영상 프레임으로 VideoFrame 생성 (실패하면 throw) */
  createVideoFrame?(video: VideoLike): VideoFrameLike;
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
    supportsVideoFrame: () =>
      typeof VideoFrame === "function" && typeof (VideoFrame.prototype as { copyTo?: unknown }).copyTo === "function",
    createVideoFrame: (video) => new VideoFrame(video as HTMLVideoElement) as unknown as VideoFrameLike,
  };
}

export interface FrameSourceOptions {
  /** fps 상한 (고객 20, 엔지니어 30) */
  maxFps: number;
  /** 작업 해상도 긴 변 (기본 320) */
  longSide?: number;
  /**
   * 새 프레임(그레이). frame.data는 소비자에게 넘어간다 (Worker로 transfer 가능, 버퍼 전체를 차지).
   * 처리가 끝나면 반드시 release()를 불러야 다음 프레임이 온다. onPacket이 있으면 쓰지 않는다.
   */
  onFrame: (frame: GrayImage, timestampMs: number) => void;
  /**
   * 있으면 그레이 대신 이것으로 받는다 — videoframe-worker 방식(VideoFrame을 Worker로 넘김)을 쓸 수 있다.
   * videoframe 패킷은 소비자가 close()하거나 transfer해야 한다. 역시 release()를 불러야 다음 프레임이 온다.
   */
  onPacket?: (packet: FramePacket, timestampMs: number) => void;
  /**
   * 획득 방식 선호 순서. 기본: onPacket이 있으면 videoframe-worker → videoframe → canvas, 없으면 videoframe → canvas.
   * 지원하지 않는 방식은 빠지고, canvas는 항상 마지막 대안으로 남는다.
   */
  acquisition?: readonly AcquisitionMode[];
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
  /** 지금 쓰는 획득 방식 */
  acquisition: AcquisitionMode;
  /** 프레임 한 장 획득에 메인 스레드에서 동기로 쓴 시간 EMA (ms). videoframe은 copyTo 뒤 처리 제외 */
  grabMsEma: number;
  /** 방식이 내려간 기록 (최근 순서대로) */
  demoted: { mode: AcquisitionMode; reason: string }[];
}

/** 반환되지 않은 in-flight 프레임을 포기하는 시간 (Worker가 죽은 경우 등) */
const STALL_MS = 3000;
const POOL_MAX = 3;
/** VideoFrame 크기 비율이 <video>와 다른 프레임이 이만큼 이어지면 (회전 메타데이터 의심) videoframe을 끈다 */
const ASPECT_MISMATCH_LIMIT = 5;
/** VideoFrame 생성·읽기가 연속으로 이만큼 실패하면 그 방식을 끈다 */
const VF_FAIL_LIMIT = 3;
/** <video> 공급원 교체·크기 변화 감지 (카메라 전환 = 같은 요소에 새 srcObject, 회전) */
const VIDEO_EVENTS = ["emptied", "loadedmetadata", "resize"] as const;

const DEFAULT_ORDER: readonly AcquisitionMode[] = ["videoframe-worker", "videoframe", "canvas"];

export class FrameSource {
  private readonly env: FrameSourceEnv;
  private readonly longSide: number;
  private readonly rate: RateController;
  private readonly clock = new FrameClock();
  private scaler: CanvasScaler | null = null;
  private reader: VideoFrameReader | null = null;
  private modes: AcquisitionMode[];
  private running = false;
  private destroyed = false;
  private inFlight = false;
  private inFlightSince = 0;
  /** stop/destroy/공급원 교체마다 증가 — 늦게 끝난 비동기 읽기를 버리기 위함 */
  private epoch = 0;
  private newFrame = false;
  private mediaMs: number | undefined = undefined;
  private lastCurrentTime = Number.NaN;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private offVisibility: (() => void) | null = null;
  private videoListening = false;
  private pool: Uint8Array[] = [];
  private warned = false;
  private aspectMismatch = 0;
  /** VideoFrame 생성 연속 실패 (성공하면 0) */
  private createFailures = 0;
  /** 메인 스레드 읽기 연속 실패 (성공하면 0) */
  private readFailures = 0;
  private grabMsEma = 0;
  private stats = { grabbed: 0, skipped: 0 };
  private readonly demoted: { mode: AcquisitionMode; reason: string }[] = [];

  constructor(
    private readonly video: VideoLike,
    private readonly opts: FrameSourceOptions,
  ) {
    this.env = { ...browserEnv(), ...opts.env };
    this.longSide = opts.longSide ?? WORKING_LONG_SIDE;
    this.rate = new RateController(opts.maxFps, { headroom: opts.headroom });
    const wanted = opts.acquisition ?? DEFAULT_ORDER;
    let vfOk = false;
    try {
      vfOk = !!this.env.supportsVideoFrame?.() && typeof this.env.createVideoFrame === "function";
    } catch {
      vfOk = false;
    }
    this.modes = wanted.filter(
      (m, i) =>
        wanted.indexOf(m) === i &&
        (m === "canvas" || (vfOk && (m !== "videoframe-worker" || typeof opts.onPacket === "function"))),
    );
    if (!this.modes.includes("canvas")) this.modes.push("canvas");
  }

  isRunning(): boolean {
    return this.running;
  }

  setMaxFps(fps: number) {
    this.rate.setMaxFps(fps);
  }

  /** 지금 쓰는 획득 방식 */
  acquisition(): AcquisitionMode {
    return this.modes[0];
  }

  /**
   * 획득 방식을 끄고 다음 방식으로 (소비자가 Worker 쪽 실패를 알릴 때 등). canvas는 끌 수 없다.
   * 한 번 끈 방식은 이 FrameSource에서 다시 쓰지 않는다.
   */
  demote(mode: AcquisitionMode, reason: string): void {
    if (mode === "canvas") return;
    const i = this.modes.indexOf(mode);
    if (i < 0) return;
    this.modes.splice(i, 1);
    this.demoted.push({ mode, reason });
    this.createFailures = 0;
    this.readFailures = 0;
    this.aspectMismatch = 0;
    console.warn(`[frame-source] ${mode} 끔 (${reason}) → ${this.modes[0]}`);
  }

  getStats(): FrameSourceStats {
    return {
      ...this.stats,
      intervalMs: this.rate.intervalMs(),
      processMsEma: this.rate.processMsEma(),
      acquisition: this.modes[0],
      grabMsEma: this.grabMsEma,
      demoted: this.demoted.slice(),
    };
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
    this.listenVideo(true);
    this.schedule();
    this.tryGrab();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.epoch++;
    this.cancelScheduled();
    this.offVisibility?.();
    this.offVisibility = null;
    this.listenVideo(false);
  }

  /**
   * in-flight 프레임 처리 끝. 버퍼를 돌려주면 재사용한다 (Worker에서 되돌아온 ArrayBuffer도 된다).
   * processMs는 적응형 간격에 쓰인다.
   */
  release(buffer?: ArrayBuffer | ArrayBufferView | null, processMs?: number): void {
    this.inFlight = false;
    if (processMs !== undefined) this.rate.onProcessed(processMs);
    if (buffer) this.recycle(buffer);
    // 기다리는 새 프레임이 있으면 바로 (다음 영상 프레임까지 기다리지 않는다)
    if (this.running && this.newFrame) this.tryGrab();
  }

  /** 지금 영상 프레임을 작업 해상도 그레이로 (새 버퍼, 풀과 무관, 캔버스 경로 — 동기). 영상이 준비 전이면 null */
  grab(): GrayImage | null {
    if (this.destroyed) return null;
    return this.captureCanvas(undefined);
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    this.pool = [];
    this.scaler = null;
    this.reader = null;
  }

  // ───────────────────────── 내부 ─────────────────────────

  private recycle(buffer: ArrayBuffer | ArrayBufferView) {
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

  private listenVideo(on: boolean) {
    const v = this.video;
    if (on === this.videoListening || typeof v.addEventListener !== "function") return;
    this.videoListening = on;
    for (const t of VIDEO_EVENTS) {
      if (on) v.addEventListener(t, this.handleVideoChange);
      else v.removeEventListener?.(t, this.handleVideoChange);
    }
  }

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

  /**
   * 공급원 교체(카메라 전환: 같은 요소에 새 srcObject)·크기 변화(회전).
   * rVFC 예약을 다시 걸고(교체 시 예약이 사라지는 구현 대비), 새 프레임을 바로 잡는다.
   * 크기 비율 불일치 카운터도 초기화 (회전 중 잠깐 어긋나는 것은 정상).
   */
  private handleVideoChange = () => {
    if (!this.running) return;
    this.aspectMismatch = 0;
    this.lastCurrentTime = Number.NaN;
    this.newFrame = true;
    this.cancelScheduled();
    this.schedule();
    this.tryGrab();
  };

  private tryGrab() {
    if (!this.running || !this.newFrame || this.env.isHidden()) return;
    const now = this.env.now();
    if (this.inFlight) {
      if (now - this.inFlightSince < STALL_MS) return;
      this.inFlight = false; // 돌아오지 않는 프레임 — 포기
      this.epoch++;
    }
    if (!this.rate.ready(now)) return;
    // HAVE_CURRENT_DATA(2) 전에는 그릴 프레임이 없다
    if (this.video.readyState < 2 || !this.frameSize()) return;
    const mode = this.modes[0];
    let ok: boolean;
    if (mode === "canvas") ok = this.grabCanvas(now);
    else ok = this.grabVideoFrame(mode, now);
    if (ok) this.grabMsEma += 0.2 * (this.env.now() - now - this.grabMsEma);
  }

  /** 잡기 성공 공통 처리 → 타임스탬프 */
  private markGrabbed(now: number): number {
    this.newFrame = false;
    this.inFlight = true;
    this.inFlightSince = now;
    this.rate.onGrab(now);
    this.stats.grabbed++;
    return this.clock.next(this.mediaMs, now);
  }

  private deliver(packet: FramePacket, ts: number) {
    try {
      if (this.opts.onPacket) this.opts.onPacket(packet, ts);
      else if (packet.kind === "gray") this.opts.onFrame(packet.frame, ts);
      else {
        packet.frame.close(); // 이론상 오지 않음 (videoframe-worker는 onPacket이 있을 때만)
        this.inFlight = false;
      }
    } catch (e) {
      console.warn("[frame-source] onFrame 오류:", e);
      this.inFlight = false;
      // 소비자가 transfer하기 전에 던졌으면 닫아 준다 (안 닫힌 VideoFrame은 카메라 버퍼를 붙잡는다)
      if (packet.kind === "videoframe") safeClose(packet.frame);
    }
  }

  private grabCanvas(now: number): boolean {
    const size = this.frameSize()!;
    const frame = this.captureCanvas(this.takeBuffer(size.width * size.height));
    if (!frame) return false;
    const ts = this.markGrabbed(now);
    this.deliver({ kind: "gray", frame, mode: "canvas" }, ts);
    return true;
  }

  private grabVideoFrame(mode: "videoframe-worker" | "videoframe", now: number): boolean {
    let vf: VideoFrameLike;
    try {
      vf = this.env.createVideoFrame!(this.video);
    } catch (e) {
      // 생성 자체가 안 되면 두 방식 모두 안 된다
      if (++this.createFailures >= VF_FAIL_LIMIT) {
        this.demote("videoframe-worker", `VideoFrame 생성 실패: ${errText(e)}`);
        this.demote("videoframe", `VideoFrame 생성 실패: ${errText(e)}`);
      } else {
        this.warnOnce(`[frame-source] VideoFrame 생성 실패: ${errText(e)}`);
      }
      return this.grabCanvas(now);
    }
    this.createFailures = 0;
    const bad = this.checkVideoFrame(vf);
    if (bad) {
      try {
        vf.close();
      } catch {
        // 무시
      }
      if (bad === "rotated") {
        this.demote("videoframe-worker", "회전·반전 메타데이터");
        this.demote("videoframe", "회전·반전 메타데이터");
      }
      return this.grabCanvas(now);
    }
    const size = workingSize(vf.displayWidth, vf.displayHeight, this.longSide)!;
    const ts = this.markGrabbed(now);
    if (mode === "videoframe-worker") {
      this.deliver({ kind: "videoframe", frame: vf, width: size.width, height: size.height }, ts);
      return true;
    }
    // 메인 스레드에서 읽기 (비동기 copyTo)
    const epoch = this.epoch;
    if (!this.reader) this.reader = new VideoFrameReader();
    const out = this.takeBuffer(size.width * size.height);
    this.reader
      .read(vf, size.width, size.height, out)
      .then(
        (frame) => {
          safeClose(vf);
          if (epoch !== this.epoch || !this.running || this.destroyed) {
            this.recycle(frame.data);
            return;
          }
          this.readFailures = 0;
          this.deliver({ kind: "gray", frame, mode: "videoframe" }, ts);
        },
        (e: unknown) => {
          safeClose(vf);
          if (epoch !== this.epoch) return;
          this.inFlight = false;
          if (e instanceof UnsupportedFrameError) {
            this.demote("videoframe-worker", e.message);
            this.demote("videoframe", e.message);
          } else if (++this.readFailures >= VF_FAIL_LIMIT) {
            this.demote("videoframe", `읽기 실패: ${errText(e)}`);
          } else {
            this.warnOnce(`[frame-source] VideoFrame 읽기 실패: ${errText(e)}`);
          }
          // 이번 칸은 아무것도 못 냈으니 간격을 기다리지 않고 바로 다시 (다음 방식으로)
          this.newFrame = true;
          this.rate.resetPhase();
          if (this.running) this.tryGrab();
        },
      );
    return true;
  }

  /** 쓰면 안 되는 프레임이면 이유 */
  private checkVideoFrame(vf: VideoFrameLike): "rotated" | "size" | "aspect" | null {
    if (vf.rotation || vf.flip) return "rotated";
    if (!(vf.displayWidth > 0) || !(vf.displayHeight > 0)) return "size";
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw > 0 && vh > 0 && Math.abs((vf.displayWidth * vh) / (vf.displayHeight * vw) - 1) > 0.02) {
      // 회전 직후 한두 프레임은 어긋날 수 있다. 계속 어긋나면 표시되지 않는 회전 메타데이터로 본다
      if (++this.aspectMismatch >= ASPECT_MISMATCH_LIMIT) {
        this.demote("videoframe-worker", "화면과 프레임 비율이 계속 다름");
        this.demote("videoframe", "화면과 프레임 비율이 계속 다름");
      }
      return "aspect";
    }
    this.aspectMismatch = 0;
    return null;
  }

  private warnOnce(msg: string) {
    if (this.warned) return;
    this.warned = true;
    console.warn(msg);
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

  private captureCanvas(out: Uint8Array | undefined): GrayImage | null {
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

function safeClose(vf: VideoFrameLike) {
  try {
    vf.close();
  } catch {
    // 무시
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
