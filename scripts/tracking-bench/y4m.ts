// 브라우저 E2E용 가짜 카메라 영상: Chromium --use-file-for-fake-video-capture=<file>.y4m
// 4:2:0 (BT.601 제한 범위) 30fps, 컬러. 프레임마다 정답 핀 위치를 JSON 사이드카로 함께 쓴다.
// 가짜 카메라는 파일을 반복 재생하므로, 화면 맨 아래 띠에 프레임 번호를 흑백 칸으로 새겨 동기화한다.
import fs from "node:fs";
import path from "node:path";
import type { Mat3 } from "../../src/lib/tracking/types";
import { mul3 } from "../../src/lib/tracking/geometry";
import { invertOrThrow } from "./camera";
import { Canvas } from "./png";
import type { Scenario } from "./scenarios";
import { CAMERA_FPS, buildSequence } from "./sequence";
import { CACHE_DIR } from "./textures";

export const Y4M_DIR = path.join(CACHE_DIR, "y4m");

/** 기본 내보내기: 손떨림 / 반복 패턴 이동 / 화면 밖→복귀 */
export const Y4M_DEFAULTS: { id: string; seconds: number }[] = [
  { id: "jitter/mild/pos", seconds: 3 },
  { id: "repetitive/router-lan3/pan", seconds: 4 },
  { id: "reentry/pos", seconds: 4.2 },
];

export const MARKER = { rows: 8, cells: 16 };

/** 프레임 번호 띠: 칸 0 = 흰색, 칸 15 = 검정 (방향 확인), 칸 1..14 = 번호의 비트 0..13 (흰색=1) */
export function markerBits(index: number): boolean[] {
  const bits: boolean[] = [true];
  for (let b = 0; b < MARKER.cells - 2; b++) bits.push(((index >> b) & 1) === 1);
  bits.push(false);
  return bits;
}

/** 작업 해상도·임의 크기 Y 평면에서 띠를 읽어 번호로 (E2E에서 같은 규칙으로 읽으면 된다) */
export function decodeMarker(y: Uint8Array | Uint8ClampedArray, w: number, h: number, rows = MARKER.rows): number | null {
  const cy = Math.min(h - 1, Math.floor(h - rows / 2));
  const cell = w / MARKER.cells;
  const bit = (i: number) => y[cy * w + Math.floor((i + 0.5) * cell)] > 128;
  if (!bit(0) || bit(MARKER.cells - 1)) return null;
  let v = 0;
  for (let b = 0; b < MARKER.cells - 2; b++) if (bit(b + 1)) v |= 1 << b;
  return v;
}

/** RGB 평면 3개(또는 휘도 1개) → YUV 4:2:0 (BT.601 제한 범위) */
export function rgbToYuv420(planes: Uint8Array[], w: number, h: number): Buffer {
  if (planes.length === 1) planes = [planes[0], planes[0], planes[0]];
  const [R, G, B] = planes;
  const ySize = w * h;
  const cw = w >> 1;
  const ch = h >> 1;
  const out = Buffer.alloc(ySize + 2 * cw * ch);
  for (let i = 0; i < ySize; i++) {
    const r = R[i] / 255;
    const g = G[i] / 255;
    const b = B[i] / 255;
    out[i] = Math.round(16 + 65.481 * r + 128.553 * g + 24.966 * b);
  }
  const uOff = ySize;
  const vOff = ySize + cw * ch;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = (2 * y + dy) * w + 2 * x + dx;
          r += R[i];
          g += G[i];
          b += B[i];
        }
      }
      r /= 4 * 255;
      g /= 4 * 255;
      b /= 4 * 255;
      out[uOff + y * cw + x] = Math.round(128 - 37.797 * r - 74.203 * g + 112.0 * b);
      out[vOff + y * cw + x] = Math.round(128 + 112.0 * r - 93.786 * g - 18.214 * b);
    }
  }
  return out;
}

function stampMarker(yuv: Buffer, w: number, h: number, index: number): void {
  const bits = markerBits(index);
  const cell = w / MARKER.cells;
  for (let y = h - MARKER.rows; y < h; y++) {
    for (let x = 0; x < w; x++) yuv[y * w + x] = bits[Math.min(MARKER.cells - 1, Math.floor(x / cell))] ? 235 : 16;
  }
  const cw = w >> 1;
  const ch = h >> 1;
  for (let y = (h - MARKER.rows) >> 1; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      yuv[w * h + y * cw + x] = 128;
      yuv[w * h + cw * ch + y * cw + x] = 128;
    }
  }
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export interface Y4mResult {
  file: string;
  sidecar: string;
  frames: number;
  bytes: number;
}

/**
 * 시나리오 하나를 y4m + 사이드카로. stream으로 해상도(가로/세로)를 바꿀 수 있다.
 * 사이드카 좌표는 정규화(0~1, 가장자리 규약: x/W) — 브라우저 작업 해상도와 무관하게 비교 가능.
 */
export function exportY4m(
  base: Scenario,
  opts: { stream: [number, number]; seconds?: number; marker?: boolean; outDir?: string; preview?: boolean },
): Y4mResult {
  const [W, H] = opts.stream;
  const sc: Scenario = { ...base, stream: [W, H], duration: Math.min(base.duration, opts.seconds ?? base.duration) };
  const seq = buildSequence(sc);
  const n = Math.floor(sc.duration * CAMERA_FPS + 1e-6);
  const outDir = opts.outDir ?? Y4M_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const name = `${sc.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}_${W}x${H}`;
  const file = path.join(outDir, `${name}.y4m`);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${CAMERA_FPS}:1 Ip A1:1 C420jpeg\n`);
  const marker = opts.marker !== false;
  const refIndex = Math.round(seq.refTime * CAMERA_FPS);
  const refP2S = seq.planeToStream(seq.refTime);
  const refInv = invertOrThrow(refP2S);
  const norm = (w: number, h: number): Mat3 => [1 / w, 0, 0, 0, 1 / h, 0, 0, 0, 1];
  const frames: unknown[] = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const t = i / CAMERA_FPS;
    const cam = seq.renderCamera(t, true);
    if (cam.width !== W || cam.height !== H) throw new Error("y4m: stream size changed mid-sequence (orientation scenario not supported)");
    const yuv = rgbToYuv420(cam.planes, W, H);
    if (marker) stampMarker(yuv, W, H, i);
    fs.writeSync(fd, "FRAME\n");
    fs.writeSync(fd, yuv);
    bytes += yuv.length + 6;
    if (opts.preview && i === refIndex) {
      Canvas.fromPlanes(W, H, cam.planes).writePng(path.join(outDir, `${name}_ref.png`));
    }
    const p = seq.pinStream(t);
    const inFrame = !!p && p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H;
    // ref(정규화) → 이 프레임(정규화) 호모그래피
    const Hn = mul3(mul3(norm(W, H), mul3(seq.planeToStream(t), refInv)), invertOrThrow(norm(W, H)));
    frames.push({
      i,
      t: r6(t),
      pin: p ? { x: r6(p.x / W), y: r6(p.y / H) } : null,
      inFrame,
      occluded: !!p && inFrame && seq.occludedAt(t, p),
      H: Hn.map(r6),
    });
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  const pinRefStream = seq.pinStream(seq.refTime)!;
  const sidecar = path.join(outDir, `${name}.json`);
  fs.writeFileSync(
    sidecar,
    JSON.stringify(
      {
        scenario: sc.id,
        title: sc.title,
        file: path.basename(file),
        width: W,
        height: H,
        fps: CAMERA_FPS,
        frames: n,
        loopSeconds: n / CAMERA_FPS,
        coords: "정규화 0~1, 가장자리 규약 (x_norm = x_px / W). H: ref 정규화 → 프레임 정규화",
        marker: marker
          ? {
              rows: MARKER.rows,
              cells: MARKER.cells,
              rule: "맨 아래 rows 픽셀 띠를 cells칸으로 나눔. 칸0=흰색, 칸15=검정, 칸1..14 = 프레임 번호 비트0..13 (흰색=1)",
            }
          : null,
        reference: {
          frame: refIndex,
          t: r6(seq.refTime),
          pin: { x: r6(pinRefStream.x / W), y: r6(pinRefStream.y / H) },
          landmark: sc.pin,
          roi: {
            x: r6((seq.roi.x + 0.5) / seq.ref.width),
            y: r6((seq.roi.y + 0.5) / seq.ref.height),
            width: r6(seq.roi.width / seq.ref.width),
            height: r6(seq.roi.height / seq.ref.height),
          },
        },
        frameGT: frames,
      },
      null,
      0,
    ),
  );
  return { file, sidecar, frames: n, bytes };
}
