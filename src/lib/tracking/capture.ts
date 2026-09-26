import type { GrayImage, Point, Rect } from "./types";
import { rgbaToGray } from "./cv/color";
import {
  CanvasScaler,
  WORKING_LONG_SIDE,
  defaultCreateCanvas,
  workingSize,
  type CanvasLike,
  type Size,
} from "./frame-source";
import { PROTOCOL_LIMITS } from "./protocol";

// 기준 프레임 캡처·전송용 JPEG·수신측 복원, 그리고 초기 ROI 계산.
//
// 기준 JPEG는 작업 해상도의 정확히 2배(긴 변 640)로 만든다 → 비율이 ref와 정확히 같고,
// 고객 쪽에서 2배 축소(= 2×2 평균)로 같은 크기의 그레이를 얻는다.
// 그레이와 JPEG는 같은 순간의 같은 영상 프레임에서 나온다 (양쪽 기준이 어긋나지 않게).

export const REFERENCE_JPEG_SCALE = 2;
export const REFERENCE_JPEG_QUALITY = 0.8;
/** 탭 ROI: 짧은 변의 이 비율을 한 변으로 하는 정사각형 */
export const TAP_ROI_FRACTION = 0.5;
/** 선 ROI: 선의 외접 사각형을 짧은 변의 이 비율만큼 넓힌다 */
export const STROKE_ROI_PAD_FRACTION = 0.15;
/** ROI가 가장자리에서 줄어들 때의 최소 반폭 (짧은 변 비율) */
const MIN_ROI_HALF_FRACTION = 0.1;

export interface CapturedReference {
  /** 작업 해상도 그레이 (추적 기준) */
  gray: GrayImage;
  /** 컬러 JPEG (작업 해상도 × 2). 512KB를 넘으면 품질을 낮춰 다시 인코딩, 그래도 넘으면 reject */
  jpeg: Promise<Blob>;
  jpegSize: Size;
}

export interface CaptureOptions {
  longSide?: number;
  jpegScale?: number;
  quality?: number;
  maxBytes?: number;
  createCanvas?: (width: number, height: number) => CanvasLike;
}

/** captureReference가 쓰는 비디오 속성 */
export type CaptureSource = Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "readyState">;

/**
 * 지금 영상 프레임을 기준으로 캡처. 영상이 아직 준비 전이면 null.
 * 그레이는 동기로 바로, JPEG는 비동기(브라우저가 스레드 밖에서 인코딩).
 */
export function captureReference(video: CaptureSource, opts: CaptureOptions = {}): CapturedReference | null {
  if (video.readyState < 2) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const work = workingSize(vw, vh, opts.longSide ?? WORKING_LONG_SIDE);
  if (!work) return null;
  const k = opts.jpegScale ?? REFERENCE_JPEG_SCALE;
  const jpegSize = { width: work.width * k, height: work.height * k };
  const create = opts.createCanvas ?? defaultCreateCanvas;
  try {
    const color = new CanvasScaler(create, false);
    if (!color.draw(video as unknown as CanvasImageSource, vw, vh, jpegSize.width, jpegSize.height)) return null;
    const colorCanvas = color.finalCanvas()!;
    const small = new CanvasScaler(create, true);
    const ctx = small.draw(colorCanvas as CanvasImageSource, jpegSize.width, jpegSize.height, work.width, work.height);
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, work.width, work.height);
    const gray = rgbaToGray(img.data, work.width, work.height);
    const jpeg = encodeJpeg(colorCanvas, opts.quality ?? REFERENCE_JPEG_QUALITY, opts.maxBytes ?? PROTOCOL_LIMITS.maxImageBytes);
    // 아무도 기다리지 않다가 실패해도 unhandled rejection이 안 나게
    jpeg.catch(() => {});
    return { gray, jpeg, jpegSize };
  } catch (e) {
    console.warn("[capture] 기준 캡처 실패:", e);
    return null;
  }
}

function canvasToBlob(canvas: CanvasLike, quality: number): Promise<Blob> {
  if (typeof (canvas as OffscreenCanvas).convertToBlob === "function") {
    return (canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality });
  }
  return new Promise((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality,
    );
  });
}

/** JPEG 인코딩. maxBytes를 넘으면 품질을 낮춰 재시도 */
export async function encodeJpeg(canvas: CanvasLike, quality: number, maxBytes: number): Promise<Blob> {
  const qualities = [quality, 0.65, 0.5, 0.35].filter((q, i) => i === 0 || q < quality);
  for (const q of qualities) {
    const blob = await canvasToBlob(canvas, q);
    if (blob.size <= maxBytes) return blob;
  }
  throw new Error("reference JPEG too large");
}

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function loadImage(blob: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch (e) {
      if (typeof Image === "undefined") throw e;
      // 일부 구형 Safari: Blob용 createImageBitmap 미지원 → <img>로
    }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined") throw new Error("no image decoder");
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * 받은 기준 JPEG → 작업 해상도 그레이.
 * target이 숫자면 긴 변 길이(비율 유지), 크기면 정확히 그 크기 (고객: 앵커의 refWidth×refHeight).
 */
export async function decodeReference(
  blob: Blob,
  target: number | Size = WORKING_LONG_SIDE,
  createCanvas: (width: number, height: number) => CanvasLike = defaultCreateCanvas,
): Promise<GrayImage> {
  if (blob.size > PROTOCOL_LIMITS.maxImageBytes) throw new Error("reference image too large");
  const img = await loadImage(blob);
  try {
    const size = typeof target === "number" ? workingSize(img.width, img.height, target) : target;
    if (!size || !(size.width > 0) || !(size.height > 0)) throw new Error("bad reference size");
    const scaler = new CanvasScaler(createCanvas, true);
    const ctx = scaler.draw(img.source, img.width, img.height, size.width, size.height);
    if (!ctx) throw new Error("canvas unavailable");
    const data = ctx.getImageData(0, 0, size.width, size.height);
    return rgbaToGray(data.data, size.width, size.height);
  } finally {
    img.close();
  }
}

/**
 * JPEG 헤더(SOF)에서 크기만 읽는다 — 디코딩 전에 거대한 이미지(압축 폭탄)를 거르기 위함.
 * JPEG가 아니거나 SOF를 못 찾으면 null.
 */
export function readJpegSize(bytes: Uint8Array): Size | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < n) {
    if (bytes[i] !== 0xff) return null;
    let marker = bytes[i + 1];
    // 채움 바이트(0xFF 연속)
    while (marker === 0xff && i + 2 < n) {
      i++;
      marker = bytes[i + 1];
    }
    i += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // 길이 없는 마커
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS 전에 SOF가 없었다
    if (i + 1 >= n) return null;
    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 6 >= n) return null;
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += len;
  }
  return null;
}

// ───────────────────────── 초기 ROI ─────────────────────────

/**
 * 중심을 보존하는 ROI. 추적기는 요청 ROI의 중심을 핀 위치의 대리값으로 쓰므로(화면 밖 판정·핀 주변 무늬 검사)
 * 가장자리에서는 ROI를 밀어 넣지 않고 대칭으로 줄인다. 최소 반폭(짧은 변의 10%) 아래로는 줄이지 않아
 * 가장자리 근처에서 프레임 밖으로 조금 넘칠 수 있다 (추적기가 안쪽으로 맞춘다, 프로토콜 범위 [-0.5, 1.5] 안).
 */
function centeredRoi(cx: number, cy: number, hx: number, hy: number, width: number, height: number): Rect {
  const x = Math.min(width, Math.max(0, Number.isFinite(cx) ? cx : width / 2));
  const y = Math.min(height, Math.max(0, Number.isFinite(cy) ? cy : height / 2));
  const floor = MIN_ROI_HALF_FRACTION * Math.min(width, height);
  const ax = Math.max(Math.min(hx, x, width - x), Math.min(hx, floor));
  const ay = Math.max(Math.min(hy, y, height - y), Math.min(hy, floor));
  return { x: x - ax, y: y - ay, width: 2 * ax, height: 2 * ay };
}

/** 탭 → ROI (ref 픽셀). 한 변 = fraction × 짧은 변인 정사각형, 탭 위치가 중심 */
export function roiFromTap(p: Point, width: number, height: number, fraction = TAP_ROI_FRACTION): Rect {
  const half = (fraction * Math.min(width, height)) / 2;
  return centeredRoi(p.x, p.y, half, half, width, height);
}

/** 선 → ROI (ref 픽셀). 선의 외접 사각형(프레임 안으로 자름)을 padFraction × 짧은 변만큼 넓힌다 */
export function roiFromStroke(
  points: readonly Point[],
  width: number,
  height: number,
  padFraction = STROKE_ROI_PAD_FRACTION,
): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const x = Math.min(width, Math.max(0, p.x));
    const y = Math.min(height, Math.max(0, p.y));
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!(x1 >= x0)) return roiFromTap({ x: width / 2, y: height / 2 }, width, height);
  const pad = padFraction * Math.min(width, height);
  return centeredRoi((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + pad, (y1 - y0) / 2 + pad, width, height);
}
