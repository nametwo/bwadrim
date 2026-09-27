// HTML 렌더 텍스처를 "사진처럼": 실제 사진 텍스처(위키미디어 등)를 쓸 수 없을 때의 대체 (네트워크 차단).
// 사진 한 장이 가진 것들을 결정적으로 입힌다 — 고르지 않은 조명, 때·손때(얼룩), 지문, 먼지, 찍은 카메라의 흐림+샤프닝,
// 센서 잡음, JPEG 압축. 기하(랜드마크·부조)는 그대로다.
import jpeg from "jpeg-js";
import { Rng } from "./rng";

export interface PhotoizeOpts {
  seed: number;
  /** 조명 불균일 세기 (기본 0.14) */
  light?: number;
  /** 때·얼룩 세기 (기본 0.07) */
  grime?: number;
  /** 지문 개수 (기본 6) */
  prints?: number;
  /** 먼지 점 개수 (기본 300) */
  dust?: number;
  /** 잡음 σ (계조, 기본 2.2) */
  noise?: number;
  /** JPEG 품질 (기본 88) */
  quality?: number;
}

/** 저해상도 값 잡음(쌍선형 확대) 옥타브 합 → 약 −1..1 */
function valueNoise(rng: Rng, w: number, h: number, cell: number, octaves: number, aniso = 1): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = Math.max(2, Math.ceil(w / (cell * aniso)) + 2);
    const cy = Math.max(2, Math.ceil(h / cell) + 2);
    const g = new Float32Array(cx * cy);
    for (let i = 0; i < g.length; i++) g[i] = rng.next() * 2 - 1;
    const sx = cell * aniso;
    for (let y = 0; y < h; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < w; x++) {
        const fx = x / sx;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const s = tx * tx * (3 - 2 * tx);
        const a = g[y0 * cx + x0] + (g[y0 * cx + x0 + 1] - g[y0 * cx + x0]) * s;
        const b = g[(y0 + 1) * cx + x0] + (g[(y0 + 1) * cx + x0 + 1] - g[(y0 + 1) * cx + x0]) * s;
        out[y * w + x] += amp * (a + (b - a) * sy);
      }
    }
    norm += amp;
    amp *= 0.5;
    cell = Math.max(2, cell / 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function blur3(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(2.5 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = v;
    }
  return out;
}

/** RGBA(sRGB 8bit) → 사진 같은 RGBA (새 버퍼) */
export function photoize(rgba: Uint8Array, w: number, h: number, o: PhotoizeOpts): Uint8Array {
  const rng = new Rng(o.seed);
  const n = w * h;
  // 1) 조명: 넓은 가우시안 몇 개(램프·창) + 한쪽으로 기운 경사
  const light = new Float32Array(n);
  const L = o.light ?? 0.14;
  const blobs = Array.from({ length: 3 }, () => ({
    x: rng.range(0, w),
    y: rng.range(0, h),
    s: rng.range(0.25, 0.6) * Math.max(w, h),
    a: rng.range(-1, 1),
  }));
  const gx = rng.range(-1, 1);
  const gy = rng.range(-1, 1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 1 + 0.5 * L * (gx * (x / w - 0.5) + gy * (y / h - 0.5));
      for (const b of blobs) v += L * b.a * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.s * b.s));
      light[y * w + x] = v;
    }
  // 2) 때·손때: 등방 얼룩 + 가로로 긴 줄무늬(닦은 자국)
  const G = o.grime ?? 0.07;
  const grime = valueNoise(rng, w, h, 90, 4);
  const streak = valueNoise(rng, w, h, 40, 2, 6);
  // 3) 지문: 동심 타원 능선(저대비)
  const prints = Array.from({ length: o.prints ?? 6 }, () => ({
    x: rng.range(0.1, 0.9) * w,
    y: rng.range(0.1, 0.9) * h,
    rx: rng.range(40, 70),
    ry: rng.range(55, 95),
    a: rng.range(0, Math.PI),
    p: rng.range(5, 7),
  }));
  const tex = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = grime[i];
    tex[i] = 1 - G * Math.max(0, g) * 1.6 + 0.35 * G * streak[i];
  }
  for (const f of prints) {
    const c = Math.cos(f.a);
    const s = Math.sin(f.a);
    const x0 = Math.max(0, Math.floor(f.x - f.ry));
    const x1 = Math.min(w - 1, Math.ceil(f.x + f.ry));
    const y0 = Math.max(0, Math.floor(f.y - f.ry));
    const y1 = Math.min(h - 1, Math.ceil(f.y + f.ry));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = x - f.x;
        const dy = y - f.y;
        const u = (c * dx + s * dy) / f.rx;
        const v = (-s * dx + c * dy) / f.ry;
        const r = Math.sqrt(u * u + v * v);
        if (r >= 1) continue;
        const ridge = 0.5 + 0.5 * Math.sin((2 * Math.PI * r * f.rx) / f.p);
        tex[y * w + x] *= 1 + 0.022 * (ridge - 0.5) * (1 - r) * (0.6 + 0.4 * Math.sin(7 * u + 3 * v));
      }
  }
  // 채널별: 조명·때 곱 → 먼지 → 흐림+샤프닝 → 잡음
  const out = new Uint8Array(n * 4);
  const dust = Array.from({ length: o.dust ?? 300 }, () => ({ x: rng.int(w), y: rng.int(h), r: rng.range(0.6, 2.2), v: rng.range(0.5, 1) }));
  const nz = o.noise ?? 2.2;
  const noiseRng = new Rng(o.seed ^ 0x5bd1e995);
  const lumaNoise = new Float32Array(n);
  for (let i = 0; i < n; i++) lumaNoise[i] = noiseRng.normal() * nz;
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = rgba[i * 4 + c] * light[i] * tex[i];
    for (const d of dust) {
      const R = Math.ceil(d.r);
      for (let yy = -R; yy <= R; yy++)
        for (let xx = -R; xx <= R; xx++) {
          const x = d.x + xx;
          const y = d.y + yy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const a = Math.max(0, 1 - Math.hypot(xx, yy) / d.r) * 0.45 * d.v;
          ch[y * w + x] = ch[y * w + x] * (1 - a) + 215 * a;
        }
    }
    const soft = blur3(ch, w, h, 0.7);
    const wide = blur3(soft, w, h, 1.6);
    for (let i = 0; i < n; i++) {
      let v = soft[i] + 0.6 * (soft[i] - wide[i]) + lumaNoise[i] + 0.6 * nz * (noiseRng.next() - 0.5);
      v = Math.round(v);
      out[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  const enc = jpeg.encode({ data: out, width: w, height: h }, o.quality ?? 88);
  const dec = jpeg.decode(enc.data, { useTArray: true, formatAsRGBA: true });
  return new Uint8Array(dec.data.buffer, dec.data.byteOffset, dec.data.length);
}
