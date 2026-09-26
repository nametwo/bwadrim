// 렌즈 왜곡 (Brown–Conrady: 방사 k1,k2 + 접선 p1,p2). 폰 메인 카메라 영상은 보통 k1 ≈ −0.05…−0.12 (술통형).
//
// 좌표: q = 핀홀(왜곡 없는) 스트림 픽셀, s = 센서(왜곡된) 스트림 픽셀 — 둘 다 가장자리 규약.
// 정규화 x = (q − c) / f₀ (f₀ = 초점 호흡 없는 기준 초점거리). s = c + f₀·D(x).
// 렌더러는 센서 픽셀마다 q를 표에서 읽고(undistortMap), 정답(GT)은 해석적 distort()로 센서 좌표를 낸다.
import type { Point } from "../../src/lib/tracking/types";
import { intrinsics } from "./camera";

export interface LensSpec {
  k1: number;
  k2?: number;
  p1?: number;
  p2?: number;
}

export interface Lens {
  spec: Required<LensSpec>;
  /** 정규화 기준 초점거리(px)와 주점 — 스트림 크기마다 다르다 */
  f0: number;
  cx: number;
  cy: number;
}

export function makeLens(spec: LensSpec, f0: number, cx: number, cy: number): Lens {
  return { spec: { k1: spec.k1, k2: spec.k2 ?? 0, p1: spec.p1 ?? 0, p2: spec.p2 ?? 0 }, f0, cx, cy };
}

/** 핀홀 q → 센서 s */
export function distort(L: Lens, qx: number, qy: number): Point {
  const { k1, k2, p1, p2 } = L.spec;
  const x = (qx - L.cx) / L.f0;
  const y = (qy - L.cy) / L.f0;
  const r2 = x * x + y * y;
  const rad = 1 + r2 * (k1 + k2 * r2);
  const xd = x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
  const yd = y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
  return { x: L.cx + L.f0 * xd, y: L.cy + L.f0 * yd };
}

/** 왜곡의 야코비안 ds/dq (정규화 좌표에서 계산 — 픽셀 단위에서도 같다) */
function distortJacobian(L: Lens, x: number, y: number): [number, number, number, number] {
  const { k1, k2, p1, p2 } = L.spec;
  const r2 = x * x + y * y;
  const rad = 1 + r2 * (k1 + k2 * r2);
  const g = k1 + 2 * k2 * r2; // d(rad)/d(r2)
  const a = rad + 2 * x * x * g + 2 * p1 * y + 6 * p2 * x;
  const b = 2 * x * y * g + 2 * p1 * x + 2 * p2 * y;
  const d = rad + 2 * y * y * g + 6 * p1 * y + 2 * p2 * x;
  return [a, b, b, d];
}

/** 센서 s → 핀홀 q (반복: 뉴턴 몇 번이면 1e-9 px) */
export function undistort(L: Lens, sx: number, sy: number): Point {
  const { k1, k2, p1, p2 } = L.spec;
  const xd = (sx - L.cx) / L.f0;
  const yd = (sy - L.cy) / L.f0;
  let x = xd;
  let y = yd;
  for (let it = 0; it < 12; it++) {
    const r2 = x * x + y * y;
    const rad = 1 + r2 * (k1 + k2 * r2);
    const ex = x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x) - xd;
    const ey = y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y - yd;
    if (Math.abs(ex) + Math.abs(ey) < 1e-13) break;
    const [a, b, c, d] = distortJacobian(L, x, y);
    const det = a * d - b * c;
    x -= (d * ex - b * ey) / det;
    y -= (-c * ex + a * ey) / det;
  }
  return { x: L.cx + L.f0 * x, y: L.cy + L.f0 * y };
}

/**
 * 센서 픽셀 중심마다 핀홀 좌표 q와 야코비안 dq/ds (2x2) 표. 렌더러가 픽셀마다 읽는다.
 * maxShift = |q − s| 최대값 (손 bbox 여유 등)
 */
export interface LensMap {
  width: number;
  height: number;
  qx: Float64Array;
  qy: Float64Array;
  /** dq/ds 행 우선 [a b; c d] */
  ja: Float32Array;
  jb: Float32Array;
  jc: Float32Array;
  jd: Float32Array;
  maxShift: number;
}

const mapCache = new Map<string, LensMap>();

export function lensMap(L: Lens, width: number, height: number): LensMap {
  const key = `${width}x${height}|${L.f0}|${L.cx}|${L.cy}|${L.spec.k1}|${L.spec.k2}|${L.spec.p1}|${L.spec.p2}`;
  const hit = mapCache.get(key);
  if (hit) return hit;
  const n = width * height;
  const m: LensMap = {
    width,
    height,
    qx: new Float64Array(n),
    qy: new Float64Array(n),
    ja: new Float32Array(n),
    jb: new Float32Array(n),
    jc: new Float32Array(n),
    jd: new Float32Array(n),
    maxShift: 0,
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const q = undistort(L, x + 0.5, y + 0.5);
      m.qx[i] = q.x;
      m.qy[i] = q.y;
      const [a, b, c, d] = distortJacobian(L, (q.x - L.cx) / L.f0, (q.y - L.cy) / L.f0);
      const det = a * d - b * c;
      m.ja[i] = d / det;
      m.jb[i] = -b / det;
      m.jc[i] = -c / det;
      m.jd[i] = a / det;
      m.maxShift = Math.max(m.maxShift, Math.hypot(q.x - x - 0.5, q.y - y - 0.5));
    }
  }
  if (mapCache.size > 8) mapCache.clear();
  mapCache.set(key, m);
  return m;
}

/** 스트림 크기 W×H의 렌즈 (정규화 = 초점 호흡 없는 기준 초점거리, 주점 = 중심) */
export function lensFor(spec: LensSpec, width: number, height: number): Lens {
  const K = intrinsics(width, height);
  return makeLens(spec, K.f, K.cx, K.cy);
}
