// 정답용 호모그래피 최소제곱 맞춤 (정규화 DLT, h33=1 고정 8x8 정규방정식). 렌즈 왜곡이 있으면 ref→프레임이
// 정확한 호모그래피가 아니므로, ROI 격자 대응점에 가장 잘 맞는 H를 정답 H로 쓴다 (핀은 따로 정확히 계산).
// 추적기 코드(cv/homography)와 독립 — 정답이 추적기 구현에 기대지 않게.
import type { Mat3, Point } from "../../src/lib/tracking/types";

function normalizer(pts: Point[]): Mat3 {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  d /= pts.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** src[i] → dst[i]에 최소제곱으로 맞는 H (점 ≥ 4). 실패하면 null */
export function fitHomography(src: Point[], dst: Point[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const T1 = normalizer(src);
  const T2 = normalizer(dst);
  const ap = (T: Mat3, p: Point) => ({ x: T[0] * p.x + T[2], y: T[4] * p.y + T[5] });
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const p = ap(T1, src[i]);
    const q = ap(T2, dst[i]);
    const rows: [number[], number][] = [
      [[p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y], q.x],
      [[0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y], q.y],
    ];
    for (const [r, b] of rows) {
      for (let a = 0; a < 8; a++) {
        Atb[a] += r[a] * b;
        for (let c = 0; c < 8; c++) AtA[a][c] += r[a] * r[c];
      }
    }
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // H = T2⁻¹ · Hn · T1
  const s2 = T2[0];
  const T2inv: Mat3 = [1 / s2, 0, -T2[2] / s2, 0, 1 / s2, -T2[5] / s2, 0, 0, 1];
  const mul = (a: Mat3, b: Mat3): Mat3 => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return o;
  };
  const H = mul(mul(T2inv, Hn), T1);
  return H.map((v) => v / H[8]);
}
