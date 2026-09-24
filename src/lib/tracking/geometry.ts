import type { Mat3, Point, Rect } from "./types";

// 3x3 행렬·호모그래피 공용 헬퍼. cv/, 런타임, 벤치마크가 함께 쓴다.

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

/** 역행렬. 특이행렬이면 null */
export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}

/** H[8] = 1로 스케일 정규화 (가능할 때) */
export function normalizeH(m: Mat3): Mat3 {
  const w = m[8];
  if (Math.abs(w) < 1e-12) return m.slice();
  return m.map((v) => v / w);
}

/** 점 변환. 무한원점(w≈0)이거나 카메라 뒤(w<0)면 null */
export function applyH(H: Mat3, p: Point): Point | null {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  if (!(w > 1e-9)) return null;
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/** 스케일·이동 행렬 (좌표계 변환용) */
export function scaleTranslate(sx: number, sy: number, tx = 0, ty = 0): Mat3 {
  return [sx, 0, tx, 0, sy, ty, 0, 0, 1];
}

export function rectCorners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

/** 사각형을 H로 변환한 사각형(quad). 한 꼭짓점이라도 무한원점이면 null */
export function warpRect(H: Mat3, r: Rect): Point[] | null {
  const out: Point[] = [];
  for (const c of rectCorners(r)) {
    const p = applyH(H, c);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** 다각형 넓이 (부호 있음, 꼭짓점 순서 반영) */
export function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 볼록 다각형이고 꼭짓점 순서(방향)가 일정한지 */
export function isConvex(poly: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** norm(0~1) ↔ 픽셀 */
export function normToPx(p: Point, width: number, height: number): Point {
  return { x: p.x * width, y: p.y * height };
}

export function pxToNorm(p: Point, width: number, height: number): Point {
  return { x: p.x / width, y: p.y / height };
}

export function rectNormToPx(r: Rect, width: number, height: number): Rect {
  return {
    x: r.x * width,
    y: r.y * height,
    width: r.width * width,
    height: r.height * height,
  };
}

export function rectPxToNorm(r: Rect, width: number, height: number): Rect {
  return {
    x: r.x / width,
    y: r.y / height,
    width: r.width / width,
    height: r.height / height,
  };
}

export function clampRect(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(width, r.x));
  const y0 = Math.max(0, Math.min(height, r.y));
  const x1 = Math.max(0, Math.min(width, r.x + r.width));
  const y1 = Math.max(0, Math.min(height, r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * H가 점 p 근처에서 길이를 몇 배로 늘리는지 (국소 스케일, 등방 근사).
 * 핀 크기를 원근에 맞게 키우고 줄일 때 쓴다.
 */
export function localScale(H: Mat3, p: Point, eps = 1): number {
  const c = applyH(H, p);
  const dx = applyH(H, { x: p.x + eps, y: p.y });
  const dy = applyH(H, { x: p.x, y: p.y + eps });
  if (!c || !dx || !dy) return 1;
  const jx = Math.hypot(dx.x - c.x, dx.y - c.y);
  const jy = Math.hypot(dy.x - c.x, dy.y - c.y);
  return Math.sqrt(jx * jy) / eps;
}
