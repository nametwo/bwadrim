import type { GrayImage, Mat3 } from "../../types";
import { invert3, mul3 } from "../../geometry";
import { Rng } from "../rng";

// 테스트용 합성 영상: 절차적 텍스처 + 알려진 호모그래피 워프 + 잡음.
// 라이브러리 코드는 이 파일을 import하지 않는다 (테스트·벤치 전용).

export interface TextureOptions {
  /** 도형 개수 */
  shapes?: number;
  /** 도형 크기 범위 (px) */
  minSize?: number;
  maxSize?: number;
  /** 저주파 배경 진폭 */
  bgAmplitude?: number;
  /** 배경 평균 밝기 */
  bgLevel?: number;
  /** 도형 대비 (0~1) */
  contrast?: number;
}

function valueNoise(w: number, h: number, cell: number, rng: Rng): Float32Array {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rng.next() * 2 - 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / cell;
    const iy = Math.floor(fy);
    let ty = fy - iy;
    ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = x / cell;
      const ix = Math.floor(fx);
      let tx = fx - ix;
      tx = tx * tx * (3 - 2 * tx);
      const a = g[iy * gw + ix];
      const b = g[iy * gw + ix + 1];
      const c = g[(iy + 1) * gw + ix];
      const d = g[(iy + 1) * gw + ix + 1];
      out[y * w + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

/** 부동소수 캔버스 → 8비트 */
export function toGray(f: Float32Array, w: number, h: number): GrayImage {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = Math.max(0, Math.min(255, Math.round(f[i])));
  return { width: w, height: h, data };
}

/**
 * "죽은 잎" 스타일 텍스처: 저주파 배경 + 임의 사각형/타원/선/점.
 * 2배 해상도로 그려 상자 필터로 줄여 계단 현상을 줄인다.
 */
export function makeTexture(w: number, h: number, seed: number, o: TextureOptions = {}): GrayImage {
  const rng = new Rng(seed);
  const S = 2;
  const W = w * S;
  const H = h * S;
  const shapes = o.shapes ?? Math.round((w * h) / 900);
  const minSize = (o.minSize ?? 4) * S;
  const maxSize = (o.maxSize ?? 40) * S;
  const bgA = o.bgAmplitude ?? 40;
  const bgL = o.bgLevel ?? 128;
  const contrast = o.contrast ?? 1;
  const f = new Float32Array(W * H);
  const n1 = valueNoise(W, H, 64 * S, rng);
  const n2 = valueNoise(W, H, 16 * S, rng);
  for (let i = 0; i < W * H; i++) f[i] = bgL + bgA * n1[i] + bgA * 0.35 * n2[i];

  for (let s = 0; s < shapes; s++) {
    const kind = rng.int(5);
    const cx = rng.range(0, W);
    const cy = rng.range(0, H);
    const sz = Math.exp(rng.range(Math.log(minSize), Math.log(maxSize)));
    const val = bgL + contrast * rng.range(-110, 110);
    const ang = rng.range(0, Math.PI);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const a = sz * rng.range(0.4, 1);
    const b = sz * rng.range(0.2, 1);
    const R = Math.ceil(Math.max(a, b) * 1.5) + 2;
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(W - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(H - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const u = dx * ca + dy * sa;
        const v = -dx * sa + dy * ca;
        let inside = false;
        if (kind === 0 || kind === 1) inside = Math.abs(u) <= a && Math.abs(v) <= b;
        else if (kind === 2) inside = (u * u) / (a * a) + (v * v) / (b * b) <= 1;
        else if (kind === 3) inside = Math.abs(v) <= Math.max(1.5 * S, b * 0.12) && Math.abs(u) <= a * 1.5;
        else inside = (u * u) / (a * a) + (v * v) / (b * b) <= 1 && (u * u) / (a * a * 0.25) + (v * v) / (b * b * 0.25) > 1;
        if (inside) f[y * W + x] = val;
      }
    }
  }
  // 상자 필터로 1/S 축소
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) s += f[(y * S + yy) * W + x * S + xx];
      out[y * w + x] = s / (S * S);
    }
  }
  return toGray(out, w, h);
}

/** 무늬 거의 없는 영상: 완만한 그라디언트 + 약한 잡음 */
export function makeFlat(w: number, h: number, seed: number, noise = 1.5): GrayImage {
  const rng = new Rng(seed);
  const f = new Float32Array(w * h);
  const n = valueNoise(w, h, 120, rng);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      f[y * w + x] = 120 + 30 * (x / w) + 12 * n[y * w + x] + rng.gauss() * noise;
    }
  }
  return toGray(f, w, h);
}

export interface PortRowOptions {
  /** 포트 간격 (px) */
  period: number;
  /** 포트 개수 */
  count: number;
  /** 고유한 라벨(비반복 무늬)을 행 아래 한쪽에 둘지 */
  uniqueLabel: boolean;
  seed: number;
}

/**
 * 반복 패턴: 똑같은 "LAN 포트" 여러 개가 한 줄로 늘어선 판.
 * 선택적으로 한 포트 아래에만 고유 라벨을 둔다.
 */
export function makePortRow(w: number, h: number, o: PortRowOptions): GrayImage {
  const rng = new Rng(o.seed);
  const S = 2;
  const W = w * S;
  const H = h * S;
  const f = new Float32Array(W * H).fill(170);
  // 판 위 약한 얼룩(현실감) — 반복을 깨지 않을 정도로 아주 약하게
  const n = valueNoise(W, H, 90 * S, rng);
  for (let i = 0; i < W * H; i++) f[i] += 4 * n[i];
  const P = o.period * S;
  const pw = P * 0.72;
  const ph = P * 0.62;
  const rowY = H * 0.45;
  const x0 = W / 2 - (P * (o.count - 1)) / 2;
  const fillRect = (ax: number, ay: number, bx: number, by: number, v: number) => {
    for (let y = Math.max(0, Math.floor(ay)); y < Math.min(H, Math.ceil(by)); y++) {
      for (let x = Math.max(0, Math.floor(ax)); x < Math.min(W, Math.ceil(bx)); x++) f[y * W + x] = v;
    }
  };
  for (let k = 0; k < o.count; k++) {
    const cx = x0 + k * P;
    // 포트 외곽(어두운 틀) + 내부 + 걸쇠 홈 + 핀 줄
    fillRect(cx - pw / 2, rowY - ph / 2, cx + pw / 2, rowY + ph / 2, 40);
    fillRect(cx - pw / 2 + 2 * S, rowY - ph / 2 + 2 * S, cx + pw / 2 - 2 * S, rowY + ph / 2 - 2 * S, 90);
    fillRect(cx - pw * 0.18, rowY + ph / 2 - 2 * S, cx + pw * 0.18, rowY + ph / 2 + 1 * S, 40);
    for (let p = 0; p < 4; p++) {
      const px = cx - pw * 0.3 + (p * pw * 0.6) / 3;
      fillRect(px - 0.8 * S, rowY - ph / 2 + 3 * S, px + 0.8 * S, rowY - ph / 2 + 6 * S, 220);
    }
    // 포트 위 LED 두 개
    fillRect(cx - pw * 0.35, rowY - ph / 2 - 5 * S, cx - pw * 0.2, rowY - ph / 2 - 3 * S, 230);
    fillRect(cx + pw * 0.2, rowY - ph / 2 - 5 * S, cx + pw * 0.35, rowY - ph / 2 - 3 * S, 60);
  }
  if (o.uniqueLabel) {
    // 가운데 포트 아래에 "글자" 비슷한 고유 무늬
    const cx = x0 + Math.floor(o.count / 2) * P;
    const ly = rowY + ph / 2 + 6 * S;
    for (let c = 0; c < 6; c++) {
      const gx = cx - pw * 0.8 + c * pw * 0.3;
      const hgt = (4 + rng.int(6)) * S;
      fillRect(gx, ly, gx + 1.5 * S, ly + hgt, 30);
      if (rng.next() < 0.6) fillRect(gx, ly + hgt * 0.4, gx + 4 * S, ly + hgt * 0.4 + 1.5 * S, 30);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) s += f[(y * S + yy) * W + x * S + xx];
      out[y * w + x] = s / (S * S);
    }
  }
  return toGray(out, w, h);
}

export interface RenderOptions {
  /** 초표본 격자 한 변 (1 = 안 함) */
  supersample?: number;
  /** 가우시안 잡음 σ */
  noise?: number;
  /** 밝기 이득·편향 */
  gain?: number;
  bias?: number;
  /** 월드 밖 채움 값 */
  fill?: number;
  rng?: Rng;
}

/**
 * world(0단계 픽셀) → frame 호모그래피 V로 프레임을 렌더링 (역매핑 + 쌍선형 + 초표본).
 */
export function renderView(world: GrayImage, V: Mat3, w: number, h: number, o: RenderOptions = {}): GrayImage {
  const inv = invert3(V);
  if (!inv) throw new Error("singular view");
  const ss = o.supersample ?? 2;
  const noise = o.noise ?? 0;
  const gain = o.gain ?? 1;
  const bias = o.bias ?? 0;
  const fill = o.fill ?? 128;
  const rng = o.rng ?? new Rng(12345);
  const W = world.width;
  const H = world.height;
  const d = world.data;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss - 0.5;
          const py = y + (sy + 0.5) / ss - 0.5;
          const Z = inv[6] * px + inv[7] * py + inv[8];
          const X = (inv[0] * px + inv[1] * py + inv[2]) / Z;
          const Y = (inv[3] * px + inv[4] * py + inv[5]) / Z;
          if (Z > 0 && X >= 0 && Y >= 0 && X < W - 1 && Y < H - 1) {
            const ix = Math.floor(X);
            const iy = Math.floor(Y);
            const fx = X - ix;
            const fy = Y - iy;
            const i = iy * W + ix;
            acc += d[i] * (1 - fx) * (1 - fy) + d[i + 1] * fx * (1 - fy) + d[i + W] * (1 - fx) * fy + d[i + W + 1] * fx * fy;
          } else {
            acc += fill;
          }
        }
      }
      let v = (acc / (ss * ss)) * gain + bias;
      if (noise > 0) v += rng.gauss() * noise;
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { width: w, height: h, data: out };
}

export interface CamParams {
  /** 이동 (px) */
  tx?: number;
  ty?: number;
  /** 회전 (라디안) */
  rot?: number;
  /** 배율 */
  scale?: number;
  /** 원근 기울임 (1/px 단위의 작은 값, 예: 0.0008) */
  px?: number;
  py?: number;
  /** 변환 중심 */
  cx: number;
  cy: number;
}

/**
 * 중심 (cx, cy) 기준: 원근 → 배율·회전 → 이동. 반환값은 입력 좌표 → 출력 좌표.
 */
export function camHomography(p: CamParams): Mat3 {
  const s = p.scale ?? 1;
  const r = p.rot ?? 0;
  const c = Math.cos(r) * s;
  const sn = Math.sin(r) * s;
  const Tm: Mat3 = [1, 0, -p.cx, 0, 1, -p.cy, 0, 0, 1];
  const P: Mat3 = [1, 0, 0, 0, 1, 0, p.px ?? 0, p.py ?? 0, 1];
  const RS: Mat3 = [c, -sn, 0, sn, c, 0, 0, 0, 1];
  const Tp: Mat3 = [1, 0, p.cx + (p.tx ?? 0), 0, 1, p.cy + (p.ty ?? 0), 0, 0, 1];
  return mul3(Tp, mul3(RS, mul3(P, Tm)));
}

/** 가우시안 잡음 추가 (제자리) */
export function addNoise(img: GrayImage, sigma: number, rng: Rng): void {
  for (let i = 0; i < img.data.length; i++) {
    img.data[i] = Math.max(0, Math.min(255, Math.round(img.data[i] + rng.gauss() * sigma)));
  }
}

// ───────────────────────── 3D 카메라 장면 (강건성 테스트) ─────────────────────────
//
// 월드: 텍스처 평면 z = 0 (단위 = 텍스처 px, x 오른쪽·y 아래·z 평면 안쪽 = 오른손 좌표계).
// 돌출부(버튼·키)는 z = −height 평면 (카메라 쪽으로 튀어나옴). 카메라 좌표도 x 오른쪽·y 아래·z 앞.
// 렌더는 광선 추적(돌출 윗면 → 옆면 → 바닥 순)이라 시차·가림이 정확하다.
// 렌즈 왜곡(방사 k1), 노출 중 모션 블러(서브 자세 평균), 초점 흐림·ISP 샤프닝, 이득·잡음·포화를 지원한다.

/** 카메라 자세: 월드 → 카메라 회전 R(row-major 3×3)과 카메라 중심 C (월드) */
export interface Pose3 {
  R: number[];
  C: [number, number, number];
}

/** 핀홀 내부 매개변수 (픽셀 중심 규약: 주점 = ((w−1)/2, (h−1)/2)) */
export interface Intrinsics {
  f: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 가로 화각(도)으로 내부 매개변수 */
export function intrinsics(w: number, h: number, hfovDeg = 65): Intrinsics {
  return { f: (w / 2) / Math.tan((hfovDeg * Math.PI) / 360), cx: (w - 1) / 2, cy: (h - 1) / 2, w, h };
}

function rotX(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
function rotY(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
function rotZ(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/**
 * 월드 평면 위 target(z=0)을 dist 거리에서 바라보는 자세 (target이 화면 중앙).
 * yaw = 좌우로 돌아가 보기, pitch = 위아래에서 보기, roll = 화면 회전 (라디안).
 */
export function orbitPose(target: { x: number; y: number }, dist: number, yaw = 0, pitch = 0, roll = 0): Pose3 {
  const R = mul3(rotZ(roll), mul3(rotX(pitch), rotY(yaw)));
  // R (T − C) = (0, 0, dist)  →  C = T − Rᵀ (0, 0, dist)
  const C: [number, number, number] = [
    target.x - R[6] * dist,
    target.y - R[7] * dist,
    0 - R[8] * dist,
  ];
  return { R, C };
}

/** 높이 z 평면(월드 (X, Y, z)) → 이미지 픽셀 호모그래피 (왜곡 전) */
export function planeToImage(K: Intrinsics, P: Pose3, z = 0): Mat3 {
  const R = P.R;
  const tx = R[0] * (-P.C[0]) + R[1] * (-P.C[1]) + R[2] * (z - P.C[2]);
  const ty = R[3] * (-P.C[0]) + R[4] * (-P.C[1]) + R[5] * (z - P.C[2]);
  const tz = R[6] * (-P.C[0]) + R[7] * (-P.C[1]) + R[8] * (z - P.C[2]);
  const M: Mat3 = [R[0], R[1], tx, R[3], R[4], ty, R[6], R[7], tz];
  return mul3([K.f, 0, K.cx, 0, K.f, K.cy, 0, 0, 1], M);
}

/** 방사 왜곡 p_d = c + (p_u − c)(1 + k1 r²), r = |p_u − c| / (대각선/2). k1 < 0 = 통형(광각 폰 카메라) */
export function distortPoint(K: Intrinsics, k1: number, p: { x: number; y: number }): { x: number; y: number } {
  if (!k1) return { x: p.x, y: p.y };
  const rn = Math.hypot(K.w, K.h) / 2;
  const dx = p.x - K.cx;
  const dy = p.y - K.cy;
  const r2 = (dx * dx + dy * dy) / (rn * rn);
  const s = 1 + k1 * r2;
  return { x: K.cx + dx * s, y: K.cy + dy * s };
}

/** distortPoint의 역 (뉴턴) */
export function undistortPoint(K: Intrinsics, k1: number, p: { x: number; y: number }): { x: number; y: number } {
  if (!k1) return { x: p.x, y: p.y };
  const rn = Math.hypot(K.w, K.h) / 2;
  const dx = p.x - K.cx;
  const dy = p.y - K.cy;
  const rd = Math.hypot(dx, dy) / rn;
  if (rd < 1e-12) return { x: p.x, y: p.y };
  let r = rd;
  for (let i = 0; i < 8; i++) {
    const f = r * (1 + k1 * r * r) - rd;
    const df = 1 + 3 * k1 * r * r;
    r -= f / df;
  }
  const s = r / rd;
  return { x: K.cx + dx * s, y: K.cy + dy * s };
}

/** 돌출 장면: 바닥 텍스처 + 돌출 윗면(키캡) 텍스처 + 돌출 영역들 */
export interface ReliefScene {
  /** z = 0 바닥 */
  base: GrayImage;
  /** 돌출 윗면 텍스처 (월드 XY로 샘플). 없으면 base */
  top?: GrayImage;
  /** 돌출 영역 (월드 XY 사각형) */
  keys: { x: number; y: number; width: number; height: number }[];
  /** 돌출 높이 (월드 단위, 카메라 쪽) */
  height: number;
  /** 옆면 밝기 (그레이) */
  wall?: number;
  /** 바닥 밖 채움 */
  fill?: number;
}

function sampleTex(img: GrayImage, X: number, Y: number, fill: number): number {
  if (!(X >= 0 && Y >= 0 && X < img.width - 1 && Y < img.height - 1)) return fill;
  const ix = Math.floor(X);
  const iy = Math.floor(Y);
  const fx = X - ix;
  const fy = Y - iy;
  const i = iy * img.width + ix;
  const d = img.data;
  return d[i] * (1 - fx) * (1 - fy) + d[i + 1] * fx * (1 - fy) + d[i + img.width] * (1 - fx) * fy + d[i + img.width + 1] * fx * fy;
}

function inKey(keys: ReliefScene["keys"], X: number, Y: number): number {
  for (let k = 0; k < keys.length; k++) {
    const r = keys[k];
    if (X >= r.x && Y >= r.y && X < r.x + r.width && Y < r.y + r.height) return k;
  }
  return -1;
}

/** 이미지 좌표(왜곡 전) (x, y)에서 보이는 밝기 — 광선 추적 */
function traceRelief(S: ReliefScene, K: Intrinsics, P: Pose3, x: number, y: number): number {
  const fill = S.fill ?? 128;
  const R = P.R;
  // 카메라 광선 d_c = ((x−cx)/f, (y−cy)/f, 1) → 월드 방향 Rᵀ d_c
  const a = (x - K.cx) / K.f;
  const b = (y - K.cy) / K.f;
  const dx = R[0] * a + R[3] * b + R[6];
  const dy = R[1] * a + R[4] * b + R[7];
  const dz = R[2] * a + R[5] * b + R[8];
  if (!(dz > 1e-9)) return fill;
  const [cx, cy, cz] = P.C;
  if (S.keys.length > 0 && S.height > 0) {
    const t1 = (-S.height - cz) / dz;
    if (t1 > 0) {
      const X = cx + t1 * dx;
      const Y = cy + t1 * dy;
      if (inKey(S.keys, X, Y) >= 0) return sampleTex(S.top ?? S.base, X, Y, fill);
    }
  }
  const t0 = -cz / dz;
  const X = cx + t0 * dx;
  const Y = cy + t0 * dy;
  if (S.keys.length > 0 && S.height > 0 && inKey(S.keys, X, Y) >= 0) {
    // 광선이 돌출부 옆면을 지남 (윗면은 못 맞힘) → 옆면. 옆면 아래쪽일수록 조금 어둡게
    return S.wall ?? 60;
  }
  return sampleTex(S.base, X, Y, fill);
}

export interface CameraRenderOptions {
  /** 초표본 격자 한 변 */
  supersample?: number;
  /** 방사 왜곡 */
  k1?: number;
  /** 가우시안 잡음 σ (이득 적용 후) */
  noise?: number;
  gain?: number;
  bias?: number;
  rng?: Rng;
}

/**
 * 3D 장면 렌더. poses가 여러 개면 노출 중 모션 블러로 평균한다 (정답 자세는 가운데 것).
 */
export function renderCamera(S: ReliefScene, K: Intrinsics, poses: Pose3[], o: CameraRenderOptions = {}): GrayImage {
  const ss = o.supersample ?? 1;
  const k1 = o.k1 ?? 0;
  const gain = o.gain ?? 1;
  const bias = o.bias ?? 0;
  const noise = o.noise ?? 0;
  const rng = o.rng ?? new Rng(777);
  const w = K.w;
  const h = K.h;
  const out = new Uint8Array(w * h);
  const np = poses.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss - 0.5;
          const py = y + (sy + 0.5) / ss - 0.5;
          const u = k1 ? undistortPoint(K, k1, { x: px, y: py }) : { x: px, y: py };
          for (let k = 0; k < np; k++) acc += traceRelief(S, K, poses[k], u.x, u.y);
        }
      }
      let v = (acc / (ss * ss * np)) * gain + bias;
      if (noise > 0) v += rng.gauss() * noise;
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { width: w, height: h, data: out };
}

/** 월드 점 (X, Y, z)의 이미지 위치 (왜곡 포함). 카메라 뒤면 null */
export function projectWorld(K: Intrinsics, P: Pose3, p: { x: number; y: number; z?: number }, k1 = 0): { x: number; y: number } | null {
  const Hz = planeToImage(K, P, p.z ?? 0);
  const w = Hz[6] * p.x + Hz[7] * p.y + Hz[8];
  if (!(w > 1e-9)) return null;
  const u = { x: (Hz[0] * p.x + Hz[1] * p.y + Hz[2]) / w, y: (Hz[3] * p.x + Hz[4] * p.y + Hz[5]) / w };
  return distortPoint(K, k1, u);
}

/** 이미지 좌표 → 높이 z 평면 위 월드 점 (왜곡 포함 좌표를 받음) */
export function backProject(K: Intrinsics, P: Pose3, p: { x: number; y: number }, z = 0, k1 = 0): { x: number; y: number } | null {
  const u = undistortPoint(K, k1, p);
  const inv = invert3(planeToImage(K, P, z));
  if (!inv) return null;
  const w = inv[6] * u.x + inv[7] * u.y + inv[8];
  if (Math.abs(w) < 1e-12) return null;
  return { x: (inv[0] * u.x + inv[1] * u.y + inv[2]) / w, y: (inv[3] * u.x + inv[4] * u.y + inv[5]) / w };
}

// ───────────────────────── ISP·광학 효과 (후처리) ─────────────────────────

/** 가우시안 블러 (분리형, σ 픽셀). 초점 흐림 근사 */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  const w = img.width;
  const h = img.height;
  if (!(sigma > 0)) return { width: w, height: h, data: Uint8Array.from(img.data) };
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const t = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * img.data[y * w + Math.min(w - 1, Math.max(0, x + i))];
      t[y * w + x] = s;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * t[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(s)));
    }
  }
  return { width: w, height: h, data: out };
}

/** ISP 샤프닝(언샤프 마스크): img + amount·(img − blur_σ(img)) → 가장자리 후광(halo) */
export function unsharpMask(img: GrayImage, amount: number, sigma: number): GrayImage {
  const b = gaussianBlur(img, sigma);
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = img.data[i] + amount * (img.data[i] - b.data[i]);
    out[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return { width: img.width, height: img.height, data: out };
}

/** 이득·편향·잡음·포화 (노출 변화·저조도). 제자리 아님 */
export function exposure(img: GrayImage, gain: number, bias: number, noise: number, rng: Rng): GrayImage {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = img.data[i] * gain + bias + (noise > 0 ? rng.gauss() * noise : 0);
    out[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return { width: img.width, height: img.height, data: out };
}
