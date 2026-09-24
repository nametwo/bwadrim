// 이미지 파이프라인 조각: 면적 평균 축소(런타임 frame-source와 같은 필터), JPEG 왕복(WebRTC·기준 이미지 압축 흉내)
import jpeg from "jpeg-js";
import type { GrayImage } from "../../src/lib/tracking/types";
import { rgbaToGray } from "../../src/lib/tracking/cv/color";
import { workDims } from "./camera";

interface AreaWeights {
  start: Int32Array;
  count: Int32Array;
  w: Float32Array;
  stride: number;
}

const weightCache = new Map<string, AreaWeights>();

/** 1차원 면적 평균 가중치: 출력 칸 i는 입력 구간 [i·r, (i+1)·r)를 덮는다 (r = src/dst) */
function areaWeights(src: number, dst: number): AreaWeights {
  const key = `${src}>${dst}`;
  const hit = weightCache.get(key);
  if (hit) return hit;
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
    for (let k = s0; k < s1; k++) {
      const lo = Math.max(a, k);
      const hi = Math.min(b, k + 1);
      w[i * stride + (k - s0)] = (hi - lo) / r;
    }
  }
  const res = { start, count, w, stride };
  weightCache.set(key, res);
  return res;
}

/**
 * 면적 평균 축소 (분리형, 정확한 겹침 가중치). 정수배면 박스 평균과 같다 (2배 → 2x2 평균, 반올림).
 * 축소만 지원 (dst ≤ src).
 */
export function downscaleArea(
  src: Uint8Array | Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  out?: Uint8Array,
): Uint8Array {
  if (dw > sw || dh > sh) throw new Error(`downscaleArea: upscale not supported ${sw}x${sh}→${dw}x${dh}`);
  const dst = out && out.length === dw * dh ? out : new Uint8Array(dw * dh);
  if (dw === sw && dh === sh) {
    dst.set(src);
    return dst;
  }
  const hw = areaWeights(sw, dw);
  const vw = areaWeights(sh, dh);
  const tmp = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < dw; x++) {
      const s0 = hw.start[x];
      const n = hw.count[x];
      const wo = x * hw.stride;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += src[row + s0 + k] * hw.w[wo + k];
      tmp[y * dw + x] = acc;
    }
  }
  for (let y = 0; y < dh; y++) {
    const s0 = vw.start[y];
    const n = vw.count[y];
    const wo = y * vw.stride;
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += tmp[(s0 + k) * dw + x] * vw.w[wo + k];
      const v = Math.floor(acc + 0.5 + 1e-4);
      dst[y * dw + x] = v > 255 ? 255 : v;
    }
  }
  return dst;
}

/** 스트림 프레임 → 작업 해상도(긴 변 320) 그레이 */
export function toWorking(gray: Uint8Array, w: number, h: number): GrayImage {
  const [ww, wh] = workDims(w, h);
  return { width: ww, height: wh, data: downscaleArea(gray, w, h, ww, wh) };
}

export function grayToRgba(gray: Uint8Array, w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const v = gray[i];
    rgba[j] = v;
    rgba[j + 1] = v;
    rgba[j + 2] = v;
    rgba[j + 3] = 255;
  }
  return rgba;
}

/** 그레이 JPEG 인코드→디코드 (휘도 양자화·블록 잡음은 컬러 JPEG의 Y 채널과 같다) */
export function jpegRoundTripGray(gray: Uint8Array, w: number, h: number, quality: number): Uint8Array {
  const enc = jpeg.encode({ data: grayToRgba(gray, w, h), width: w, height: h }, quality);
  const dec = jpeg.decode(enc.data, { useTArray: true, formatAsRGBA: true });
  return rgbaToGray(dec.data, dec.width, dec.height).data as Uint8Array;
}

// ───────────── 빠른 JPEG 휘도 시뮬레이터 ─────────────
// 베이스라인 JPEG의 손실은 전부 "8x8 DCT → 양자화표로 나눠 반올림 → 역DCT"에서 생긴다 (엔트로피 부호화는 무손실).
// 그 과정을 그대로 재현한다 — 표준 휘도 양자화표(Annex K) + libjpeg/jpeg-js와 같은 품질 배율.
// jpeg-js 왕복보다 ~5배 빠르고 결과는 ±1~2 수준으로 같다 (imageops.test.ts에서 확인).

const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80,
  62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98,
  112, 100, 103, 99,
];

/** 8점 DCT 기저 (정규직교, JPEG 정의와 같은 배율) */
const DCT8 = (() => {
  const c = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x++) c[u * 8 + x] = 0.5 * cu * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return c;
})();

const qCache = new Map<number, Float64Array>();
export function jpegLumaTable(quality: number): Float64Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  let t = qCache.get(q);
  if (!t) {
    const sf = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);
    t = new Float64Array(64);
    for (let i = 0; i < 64; i++) t[i] = Math.min(255, Math.max(1, Math.floor((STD_LUMA_Q[i] * sf + 50) / 100)));
    qCache.set(q, t);
  }
  return t;
}

// 8점 DCT/IDCT — 짝·홀 분해로 곱셈 절반 (C[u][7-k] = ±C[u][k])
const C = DCT8;
function fdct8(a: Float64Array, o: number, st: number, out: Float64Array, oo: number, ost: number): void {
  const x0 = a[o];
  const x1 = a[o + st];
  const x2 = a[o + 2 * st];
  const x3 = a[o + 3 * st];
  const x4 = a[o + 4 * st];
  const x5 = a[o + 5 * st];
  const x6 = a[o + 6 * st];
  const x7 = a[o + 7 * st];
  const s0 = x0 + x7;
  const s1 = x1 + x6;
  const s2 = x2 + x5;
  const s3 = x3 + x4;
  const d0 = x0 - x7;
  const d1 = x1 - x6;
  const d2 = x2 - x5;
  const d3 = x3 - x4;
  for (let u = 0; u < 8; u++) {
    const c = u * 8;
    out[oo + u * ost] =
      u & 1
        ? C[c] * d0 + C[c + 1] * d1 + C[c + 2] * d2 + C[c + 3] * d3
        : C[c] * s0 + C[c + 1] * s1 + C[c + 2] * s2 + C[c + 3] * s3;
  }
}
function idct8(a: Float64Array, o: number, st: number, out: Float64Array, oo: number, ost: number): void {
  const f0 = a[o];
  const f1 = a[o + st];
  const f2 = a[o + 2 * st];
  const f3 = a[o + 3 * st];
  const f4 = a[o + 4 * st];
  const f5 = a[o + 5 * st];
  const f6 = a[o + 6 * st];
  const f7 = a[o + 7 * st];
  for (let k = 0; k < 4; k++) {
    const e = C[k] * f0 + C[16 + k] * f2 + C[32 + k] * f4 + C[48 + k] * f6;
    const d = C[8 + k] * f1 + C[24 + k] * f3 + C[40 + k] * f5 + C[56 + k] * f7;
    out[oo + k * ost] = e + d;
    out[oo + (7 - k) * ost] = e - d;
  }
}

/** JPEG 휘도 손실 재현 (그레이). 가장자리 블록은 마지막 행·열 복제로 채운다 */
export function jpegSimGray(gray: Uint8Array, w: number, h: number, quality: number): Uint8Array {
  const Q = jpegLumaTable(quality);
  const out = new Uint8Array(w * h);
  const blk = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coef = new Float64Array(64);
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(h - 1, by + y) * w;
        for (let x = 0; x < 8; x++) blk[y * 8 + x] = gray[sy + Math.min(w - 1, bx + x)] - 128;
      }
      // 순방향: 가로(행마다) → 세로(열마다). coef[v*8+u], v=세로 주파수
      for (let y = 0; y < 8; y++) fdct8(blk, y * 8, 1, tmp, y * 8, 1);
      for (let u = 0; u < 8; u++) fdct8(tmp, u, 8, coef, u, 8);
      // 양자화 (0에서 멀어지는 반올림) → 역양자화
      let colMask = 0;
      for (let i = 0; i < 64; i++) {
        const q = Q[i];
        const r = coef[i] / q;
        const k = r >= 0 ? Math.floor(r + 0.5) : -Math.floor(-r + 0.5);
        coef[i] = k * q;
        if (k !== 0) colMask |= 1 << (i & 7);
      }
      // 역방향: 세로(열마다, 0인 열은 0) → 가로(행마다)
      for (let u = 0; u < 8; u++) {
        if (colMask & (1 << u)) idct8(coef, u, 8, tmp, u, 8);
        else for (let y = 0; y < 8; y++) tmp[y * 8 + u] = 0;
      }
      for (let y = 0; y < 8; y++) {
        const oy = by + y;
        if (oy >= h) break;
        idct8(tmp, y * 8, 1, blk, 0, 1);
        for (let x = 0; x < 8; x++) {
          const ox = bx + x;
          if (ox >= w) break;
          const r = Math.round(blk[x] + 128);
          out[oy * w + ox] = r < 0 ? 0 : r > 255 ? 255 : r;
        }
      }
    }
  }
  return out;
}

/** JPEG 바이트 크기 (기준 이미지 전송량 확인용) */
export function jpegSizeGray(gray: Uint8Array, w: number, h: number, quality: number): number {
  return jpeg.encode({ data: grayToRgba(gray, w, h), width: w, height: h }, quality).data.length;
}

/** 크기 조정: 긴 변이 maxLong을 넘으면 면적 평균으로 줄인다 */
export function fitLongSide(gray: Uint8Array, w: number, h: number, maxLong: number): { data: Uint8Array; width: number; height: number } {
  const L = Math.max(w, h);
  if (L <= maxLong) return { data: gray, width: w, height: h };
  const s = maxLong / L;
  const nw = Math.round(w * s);
  const nh = Math.round(h * s);
  return { data: downscaleArea(gray, w, h, nw, nh), width: nw, height: nh };
}

/** 균일 축소 (WebRTC 대역폭 적응 해상도) */
export function scaleBy(gray: Uint8Array, w: number, h: number, s: number): { data: Uint8Array; width: number; height: number } {
  if (s >= 1) return { data: gray, width: w, height: h };
  const nw = Math.max(16, Math.round(w * s));
  const nh = Math.max(16, Math.round(h * s));
  return { data: downscaleArea(gray, w, h, nw, nh), width: nw, height: nh };
}
