// 카메라 렌더러: 평면 텍스처(대상+배경) + 가리는 손 → 폰 카메라 스트림 프레임.
//
// 물리 흐름(선형광): 텍스처 샘플(비등방 삼선형 밉맵, 안티에일리어싱) × 조명(정반사·그림자·비네팅)
//   → 노출 시간 동안 서브프레임 평균(모션 블러; 롤링 셔터는 행마다 시각을 달리해서)
//   → 렌즈 번짐 → 센서 이득·잡음(샷+읽기) → 톤 곡선(sRGB 감마·대비) → 8bit
// 결정적: 같은 장면·시각 → 같은 바이트 (잡음 시드 = 장면 시드 + 시각).
//
// 속도: 행 단위로 (1) 기하 패스: 픽셀마다 텍스처 좌표·LOD를 샘플 목록에 쌓고
// (2) 샘플 패스: 목록을 삼선형으로 한 번에 읽는다. 픽셀마다 함수 호출·double 박싱이 없게.
import type { Mat3 } from "../../src/lib/tracking/types";
import { mul3 } from "../../src/lib/tracking/geometry";
import {
  HAND_BOUNDS,
  type HandPose,
  type Intrinsics,
  type Pose,
  type Vec3,
  handAffine,
  handSdf,
  nailSdf,
  normalizeFrob,
  planeToImage,
  project,
  specularPoint,
  TARGET_AFFINE,
  invertOrThrow,
} from "./camera";
import { type IspSpec, ispTone } from "./isp";
import { type LensMap, type LensSpec, distort, lensFor, lensMap } from "./lens";
import { type ReliefHit, type ReliefMap, reliefShadow, traceRelief } from "./relief";
import { Rng, gaussianTable, hashString } from "./rng";
import type { MipTexture, Texture } from "./textures";

// ───────────────────────── 장면 ─────────────────────────

export interface PhotoParams {
  /** 장면 조도 배율 (조명 꺼짐 등) */
  scene: number;
  /** 센서 이득(자동 노출) — 잡음도 함께 커진다 */
  gain: number;
  /** 톤 곡선 대비 (1 = 기본) */
  contrast: number;
  /** 톤 곡선 밝기 오프셋 (-1~1) */
  brightness: number;
}

export interface HandSetup {
  /** 대상 평면 위 손 높이 (평면 단위, 카메라 쪽) */
  heightUnits: number;
  unitsPerMm: number;
  at(t: number): HandPose | null;
  /** 선형 RGB (휘도 렌더면 세 값이 같음) */
  color: [number, number, number];
  /** 그림자 진하기 (0~1) */
  shadow: number;
}

export interface GlossSetup {
  /** 선형광 가산 세기 */
  strength: number;
  /** 하이라이트 퍼짐(평면 단위) */
  sigma: number;
  /** 광원 위치(월드) */
  light: Vec3;
}

/** 평면 위 타원형 부드러운 그림자 (몸·머리 그림자) */
export interface ShadowBlob {
  x: number;
  y: number;
  rx: number;
  ry: number;
  depth: number;
  soft: number;
}

export interface SceneSetup {
  target: Texture;
  bg: Texture;
  /** 배경 평면: z(+는 대상 뒤) + 배경 텍셀 → 월드 XY 아핀 */
  bgPlane: { z: number; affine: number[] };
  poseAt(t: number): Pose;
  /** 스트림 해상도·내부 파라미터 (방향 전환이면 시간에 따라 바뀜) */
  streamAt(t: number): Intrinsics;
  exposureMs: number;
  readoutMs: number;
  photoAt(t: number): PhotoParams;
  noise: { shot: number; read: number };
  vignette: number;
  opticalBlur: boolean;
  hand?: HandSetup;
  gloss?: GlossSetup;
  shadow?: (t: number) => ShadowBlob | null;
  /** 광원 방향 (평면 쪽으로 향하는 단위 벡터) — 손 그림자, 대상이 배경에 드리우는 그림자 */
  lightDir: Vec3;
  seed: number;
  /** 자동노출 이득 (시간에 따라 장면 측광을 늦게 따라감, 기본 1). photoAt().gain에 곱해진다 */
  ae?: (t: number) => number;
  /** 초점 흐림 σ(스트림 px) — 자동초점이 거리 변화를 늦게 따라감. 렌즈 번짐(σ≈0.7)에 더해진다 */
  focusSigma?: (t: number) => number;
  /** 조명 깜빡임 (교류 60Hz → 120Hz 밝기 변화, 롤링 셔터로 가로 띠가 흐른다) */
  flicker?: { hz: number; depth: number };
  // ── 실감(realism) — 하나라도 있으면 realRows 경로로 그린다 (기존 시나리오 경로는 그대로) ──
  /** 렌즈 왜곡 (센서 픽셀 ← 핀홀). 정규화는 초점 호흡 없는 기준 초점거리 */
  lens?: LensSpec;
  /** 입체 부조 (대상 텍스처 위 높이 지도) */
  relief?: ReliefMap;
  /** 면광원 정반사 (형광등·창이 광택 표면에 비침) */
  area?: AreaLight;
  /** ISP 톤 곡선 (톤 LUT에 합쳐짐) */
  ispTone?: IspSpec["tone"];
}

/** 대상 평면과 평행한 사각형 광원 (z = −dist). 광택 표면의 거울 반사로 보인다 */
export interface AreaLight {
  /** 광원 중심 (월드 X,Y, 평면 단위) */
  x: number;
  y: number;
  /** 대상 평면 앞 거리 (평면 단위) */
  dist: number;
  /** 크기 (평면 단위), 회전(도) */
  w: number;
  h: number;
  angle: number;
  /** 수직 입사 때 가산 세기 (선형광). 비스듬하면 프레넬로 커진다 */
  strength: number;
  /** 가장자리 흐림 (평면 단위, 광원 평면에서) — 표면 거칠기 */
  blur: number;
}

export interface CameraFrame {
  width: number;
  height: number;
  /** 1개(휘도) 또는 3개(R,G,B) 평면, 각 width*height */
  planes: Uint8Array[];
}

/** 시각 τ에서의 평면별 역호모그래피(이미지 → 평면 좌표) */
interface PoseSample {
  tInvTarget: Mat3;
  tInvBg: Mat3;
  tInvHand: Mat3 | null;
  /** 실감(부조) 경로만: 카메라 중심, 핀홀 픽셀 → 월드 광선 방향 (Rᵀ·K⁻¹) */
  C?: Vec3;
  ray?: Mat3;
}

/** realRows에 넘기는 프레임·서브프레임 상태 */
interface RealCtx {
  W: number;
  H: number;
  N: number;
  nch: number;
  ts: number;
  ro: number;
  m: number;
  dt: number;
  tMin: number;
  table: PoseSample[];
  accum: Float32Array;
  vig: Float32Array;
  surf: Uint8Array;
  lodBias: number;
  lm: LensMap | null;
  /** 노출 중심 시각의 카메라 중심 (부조 없을 때 정반사용) */
  cam: Vec3;
  dropK: number;
  dropX: number;
  dropY: number;
  dropSoft: number;
  glossOn: boolean;
  spx: number;
  spy: number;
  g2: number;
  gStr: number;
  blob: ShadowBlob | null;
  hand: {
    hp: HandPose;
    hx0: number;
    hx1: number;
    hy0: number;
    hy1: number;
    pxMm: number;
    hc: number;
    hs: number;
    shOffX: number;
    shOffY: number;
    shOffBgX: number;
    shOffBgY: number;
    shSoft: number;
    upm: number;
    hShadow: number;
    hpx: number;
    hpy: number;
    hcol: readonly number[];
  } | null;
}

const TONE_N = 16384;
const INV_POW2 = new Float64Array(20).map((_, k) => 1 / 2 ** k);
/** 모션 블러 선 적분 최대 샘플 */
const MAX_BLUR_TAPS = 40;
/** 비등방 최대 샘플 수 */
const MAX_ANISO = 4;

/** 샘플 목록 (행 단위) */
class SampleList {
  n = 0;
  u: Float64Array;
  v: Float64Array;
  lod: Float64Array;
  w: Float64Array;
  dst: Int32Array;
  constructor(cap: number) {
    this.u = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.lod = new Float64Array(cap);
    this.w = new Float64Array(cap);
    this.dst = new Int32Array(cap);
  }
}

/**
 * 샘플 목록을 삼선형(가장자리 고정)으로 읽어 out[dst*nch + c]에 가중 누적.
 * (u,v)는 레벨 0 텍셀 좌표(가장자리 규약). 거울 반복은 목록에 넣을 때 이미 접었다.
 */
function sampleList(t: MipTexture, L: SampleList, out: Float64Array, nch: number, c: number): void {
  const flat = t.flat;
  const offs = t.off;
  const lws = t.lw;
  const lhs = t.lh;
  const maxL = offs.length - 1;
  const n = L.n;
  const us = L.u;
  const vs = L.v;
  const ls = L.lod;
  const ws = L.w;
  const ds = L.dst;
  for (let i = 0; i < n; i++) {
    let lod = ls[i];
    if (lod < 0) lod = 0;
    else if (lod > maxL) lod = maxL;
    const l = lod | 0;
    const f = lod - l;
    // 레벨 l
    let s = INV_POW2[l];
    let w = lws[l];
    let h = lhs[l];
    let o = offs[l];
    let x = us[i] * s - 0.5;
    let y = vs[i] * s - 0.5;
    let x0 = Math.floor(x);
    let y0 = Math.floor(y);
    let fx = x - x0;
    let fy = y - y0;
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    if (x0 < 0) x0 = 0;
    else if (x0 >= w) x0 = w - 1;
    if (x1 < 0) x1 = 0;
    else if (x1 >= w) x1 = w - 1;
    if (y0 < 0) y0 = 0;
    else if (y0 >= h) y0 = h - 1;
    if (y1 < 0) y1 = 0;
    else if (y1 >= h) y1 = h - 1;
    let r0 = o + y0 * w;
    let r1 = o + y1 * w;
    let a0 = flat[r0 + x0];
    let b0 = flat[r1 + x0];
    let top = a0 + (flat[r0 + x1] - a0) * fx;
    let bot = b0 + (flat[r1 + x1] - b0) * fx;
    let val = top + (bot - top) * fy;
    if (f > 0.02 && l < maxL) {
      s *= 0.5;
      w = lws[l + 1];
      h = lhs[l + 1];
      o = offs[l + 1];
      x = us[i] * s - 0.5;
      y = vs[i] * s - 0.5;
      x0 = Math.floor(x);
      y0 = Math.floor(y);
      fx = x - x0;
      fy = y - y0;
      x1 = x0 + 1;
      y1 = y0 + 1;
      if (x0 < 0) x0 = 0;
      else if (x0 >= w) x0 = w - 1;
      if (x1 < 0) x1 = 0;
      else if (x1 >= w) x1 = w - 1;
      if (y0 < 0) y0 = 0;
      else if (y0 >= h) y0 = h - 1;
      if (y1 < 0) y1 = 0;
      else if (y1 >= h) y1 = h - 1;
      r0 = o + y0 * w;
      r1 = o + y1 * w;
      a0 = flat[r0 + x0];
      b0 = flat[r1 + x0];
      top = a0 + (flat[r0 + x1] - a0) * fx;
      bot = b0 + (flat[r1 + x1] - b0) * fx;
      val += (top + (bot - top) * fy - val) * f;
    }
    out[ds[i] * nch + c] += ws[i] * val;
  }
}

/**
 * 픽셀 발자국(야코비안)으로 비등방 샘플을 목록에 넣는다 (GPU 방식: 짧은 축 레벨 + 긴 축 방향 최대 4점).
 * mirrorW/H > 0이면 거울 반복으로 접는다 (배경).
 */
function pushAniso(
  L: SampleList,
  x: number,
  u: number,
  v: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bias: number,
  mirrorW: number,
  mirrorH: number,
): void {
  const la = ax * ax + ay * ay;
  const lb = bx * bx + by * by;
  let major = la;
  let minor = lb;
  let dx = ax;
  let dy = ay;
  if (lb > la) {
    major = lb;
    minor = la;
    dx = bx;
    dy = by;
  }
  if (minor < 1e-12) minor = 1e-12;
  const ratio2 = major / minor;
  let n = 1;
  if (ratio2 > 2.25) n = ratio2 > 9 ? MAX_ANISO : ratio2 > 6.25 ? 3 : 2;
  const eff = major / (n * n);
  const lod = 0.5 * Math.log2(eff > minor ? eff : minor) + bias;
  const wgt = 1 / n;
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0 : (i + 0.5) / n - 0.5;
    let su = u + k * dx;
    let sv = v + k * dy;
    if (mirrorW > 0) {
      const pw = 2 * mirrorW;
      su -= pw * Math.floor(su / pw);
      if (su > mirrorW) su = pw - su;
      const ph = 2 * mirrorH;
      sv -= ph * Math.floor(sv / ph);
      if (sv > mirrorH) sv = ph - sv;
    }
    const j = L.n++;
    L.u[j] = su;
    L.v[j] = sv;
    L.lod[j] = lod;
    L.w[j] = wgt;
    L.dst[j] = x;
  }
}

export class CameraRenderer {
  private readonly nch: number;
  private readonly noiseTab = gaussianTable(20, 0x5eed);
  private accum = new Float32Array(0);
  private tmp = new Float32Array(0);
  private vig = new Float32Array(0);
  private vigKey = "";
  private toneKey = "";
  private tone = new Uint8Array(TONE_N + 1);
  // 행 버퍼
  private rowW = 0;
  private tList = new SampleList(0);
  private bList = new SampleList(0);
  private rowVal = new Float64Array(0);
  private rowLight = new Float64Array(0);
  private rowGlare = new Float64Array(0);
  private rowAlpha = new Float64Array(0);
  private rowShade = new Float64Array(0);
  /** 픽셀별 표면: 0 대상, 1 배경, 2 손 */
  private surf = new Uint8Array(0);
  private blurSrc = new Float32Array(0);

  constructor(
    private readonly scene: SceneSetup,
    readonly color: boolean,
    /** 모션 블러 방식: fast = 표면별 운동 벡터 선 적분 (기본), subframes = 서브프레임 자세 평균 (정확, 느림) */
    readonly blurMode: "fast" | "subframes" = "fast",
  ) {
    this.nch = color ? 3 : 1;
    if (scene.target.channels.length !== this.nch || scene.bg.channels.length !== this.nch) {
      throw new Error("texture channel count mismatch");
    }
  }

  private ensureRow(W: number): void {
    if (this.rowW === W) return;
    this.rowW = W;
    this.tList = new SampleList(W * MAX_ANISO);
    this.bList = new SampleList(W * MAX_ANISO);
    this.rowVal = new Float64Array(W * 3);
    this.rowLight = new Float64Array(W);
    this.rowGlare = new Float64Array(W);
    this.rowAlpha = new Float64Array(W);
    this.rowShade = new Float64Array(W);
  }

  /** 대상 평면 → 스트림 이미지 (가장자리 규약) */
  targetH(t: number): Mat3 {
    return planeToImage(this.scene.streamAt(t), this.scene.poseAt(t), 0, TARGET_AFFINE);
  }

  private sample(t: number, K: Intrinsics, prev: PoseSample | null): PoseSample {
    const s = this.scene;
    const pose = s.poseAt(t);
    const inv = (H: Mat3, ref: Mat3 | undefined) => normalizeFrob(invertOrThrow(H), ref);
    const tInvTarget = inv(planeToImage(K, pose, 0, TARGET_AFFINE), prev?.tInvTarget);
    const tInvBg = inv(planeToImage(K, pose, s.bgPlane.z, s.bgPlane.affine), prev?.tInvBg);
    let tInvHand: Mat3 | null = null;
    const hp = s.hand?.at(t);
    if (s.hand && hp) {
      tInvHand = inv(
        planeToImage(K, pose, -s.hand.heightUnits, handAffine(hp, s.hand.unitsPerMm)),
        prev?.tInvHand ?? undefined,
      );
    }
    if (!s.relief) return { tInvTarget, tInvBg, tInvHand };
    const R = pose.R;
    const Kinv: Mat3 = [1 / K.f, 0, -K.cx / K.f, 0, 1 / K.f, -K.cy / K.f, 0, 0, 1];
    const ray = mul3([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]], Kinv);
    return { tInvTarget, tInvBg, tInvHand, C: [pose.C[0], pose.C[1], pose.C[2]], ray };
  }

  private vignette(w: number, h: number): Float32Array {
    const key = `${w}x${h}`;
    if (key === this.vigKey) return this.vig;
    const v = new Float32Array(w * h);
    const k = this.scene.vignette;
    const cx = w / 2;
    const cy = h / 2;
    const r2max = cx * cx + cy * cy;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const r2 = (dx * dx + dy * dy) / r2max;
        v[y * w + x] = 1 - k * r2 * (0.6 + 0.4 * r2);
      }
    }
    this.vig = v;
    this.vigKey = key;
    return v;
  }

  private toneLut(p: PhotoParams): Uint8Array {
    const it = this.scene.ispTone;
    const key = `${p.contrast.toFixed(4)}|${p.brightness.toFixed(4)}${it ? `|${JSON.stringify(it)}` : ""}`;
    if (key === this.toneKey) return this.tone;
    for (let i = 0; i <= TONE_N; i++) {
      const s = i / TONE_N;
      let e = s <= 0.0031308 ? 12.92 * s : 1.055 * Math.pow(s, 1 / 2.4) - 0.055;
      if (it) e = ispTone(e, it);
      let o = 0.5 + p.contrast * (e - 0.5) + p.brightness;
      o = o < 0 ? 0 : o > 1 ? 1 : o;
      this.tone[i] = Math.round(o * 255);
    }
    this.toneKey = key;
    return this.tone;
  }

  /** 노출 동안 최대 이동량(px) — 서브프레임 수 결정용 */
  motionPx(t: number): number {
    const K = this.scene.streamAt(t);
    const e = this.scene.exposureMs / 1000;
    if (e <= 0) return 0;
    const Hinv = invertOrThrow(this.targetH(t));
    const H0 = planeToImage(K, this.scene.poseAt(t - e / 2), 0, TARGET_AFFINE);
    const H1 = planeToImage(K, this.scene.poseAt(t + e / 2), 0, TARGET_AFFINE);
    let m = 0;
    const pts = [
      [K.width / 2, K.height / 2],
      [0, 0],
      [K.width, 0],
      [0, K.height],
      [K.width, K.height],
    ];
    for (const [x, y] of pts) {
      const q = project(Hinv, x, y);
      if (!q) continue;
      const a = project(H0, q.x, q.y);
      const b = project(H1, q.x, q.y);
      if (!a || !b) continue;
      m = Math.max(m, Math.hypot(a.x - b.x, a.y - b.y));
    }
    // 손은 따로 움직인다
    const hand = this.scene.hand;
    if (hand) {
      const p0 = hand.at(t - e / 2);
      const p1 = hand.at(t + e / 2);
      if (p0 && p1) {
        const pose = this.scene.poseAt(t);
        const A = planeToImage(K, pose, -hand.heightUnits, handAffine(p0, hand.unitsPerMm));
        const B = planeToImage(K, pose, -hand.heightUnits, handAffine(p1, hand.unitsPerMm));
        const a = project(A, 0, 60);
        const b = project(B, 0, 60);
        if (a && b) m = Math.max(m, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    return m;
  }

  /**
   * 측광: 시각 t 장면(대상+배경 반사율, 조명·손 제외)의 평균 선형 휘도를 성긴 격자로 잰다.
   * 자동노출(ae)을 정할 때 쓴다.
   */
  meterMean(t: number, gx = 48, gy = 64): number {
    const s = this.scene;
    const K = s.streamAt(t);
    const pose = s.poseAt(t);
    const tInv = invertOrThrow(planeToImage(K, pose, 0, TARGET_AFFINE));
    const bInv = invertOrThrow(planeToImage(K, pose, s.bgPlane.z, s.bgPlane.affine));
    const n = gx * gy;
    const tl = new SampleList(n * MAX_ANISO);
    const bl = new SampleList(n * MAX_ANISO);
    const sx = K.width / gx;
    const sy = K.height / gy;
    let i = 0;
    for (let yy = 0; yy < gy; yy++) {
      for (let xx = 0; xx < gx; xx++, i++) {
        const px = (xx + 0.5) * sx;
        const py = (yy + 0.5) * sy;
        const tw = tInv[6] * px + tInv[7] * py + tInv[8];
        const q = project(tInv, px, py);
        if (tw > 1e-12 && q && q.x >= 0 && q.y >= 0 && q.x < s.target.width && q.y < s.target.height) {
          const iw = 1 / tw;
          pushAniso(tl, i, q.x, q.y, (tInv[0] - q.x * tInv[6]) * iw * sx, (tInv[3] - q.y * tInv[6]) * iw * sx, (tInv[1] - q.x * tInv[7]) * iw * sy, (tInv[4] - q.y * tInv[7]) * iw * sy, 0, 0, 0);
          continue;
        }
        const bw = bInv[6] * px + bInv[7] * py + bInv[8];
        const r = project(bInv, px, py);
        if (!r || !(bw > 1e-12)) continue;
        const iw = 1 / bw;
        pushAniso(bl, i, r.x, r.y, (bInv[0] - r.x * bInv[6]) * iw * sx, (bInv[3] - r.y * bInv[6]) * iw * sx, (bInv[1] - r.x * bInv[7]) * iw * sy, (bInv[4] - r.y * bInv[7]) * iw * sy, 0, s.bg.width, s.bg.height);
      }
    }
    const out = new Float64Array(n);
    sampleList(s.target.channels[0], tl, out, 1, 0);
    sampleList(s.bg.channels[0], bl, out, 1, 0);
    let sum = 0;
    for (let k = 0; k < n; k++) sum += out[k];
    return sum / n;
  }

  /** 시각 t(초, 노출 중심)의 프레임 한 장 */
  render(t: number): CameraFrame {
    const s = this.scene;
    const K = s.streamAt(t);
    const W = K.width;
    const H = K.height;
    const N = W * H;
    const nch = this.nch;
    if (this.accum.length !== N * nch) {
      this.accum = new Float32Array(N * nch);
      this.tmp = new Float32Array(Math.max(W, H));
    } else {
      this.accum.fill(0);
    }
    this.ensureRow(W);
    const accum = this.accum;
    const vig = this.vignette(W, H);
    const e = s.exposureMs / 1000;
    const ro = s.readoutMs / 1000;

    // 노출 중 이동량. 기본(fast): 선명한 한 장을 그린 뒤 표면별 운동 벡터로 선 적분(motionBlur).
    // exact: 노출 구간의 서브프레임 자세들로 여러 번 그려 평균 (느림 — 검증용, --exact-blur)
    const motion = this.motionPx(t);
    const exact = this.blurMode === "subframes" && e > 0;
    const nSub = exact ? Math.max(1, Math.min(24, Math.ceil(motion / 0.5))) : 1;
    const lodBias = 0;
    if (this.surf.length !== N) this.surf = new Uint8Array(N);
    const surf = this.surf;

    // 자세 표: (노출+)판독(롤링 셔터) 구간을 ~1ms 간격으로 정확히 계산, 사이는 선형 보간
    const tMin = t - ro / 2 - (exact ? e / 2 : 0);
    const tMax = t + ro / 2 + (exact ? e / 2 : 0);
    const span = tMax - tMin;
    const m = span > 1e-6 ? Math.max(2, Math.ceil(span / 0.001) + 1) : 1;
    const dt = m > 1 ? span / (m - 1) : 0;
    const table: PoseSample[] = [];
    for (let i = 0; i < m; i++) table.push(this.sample(tMin + i * dt, K, i > 0 ? table[i - 1] : null));
    const hasHand = table.every((p) => p.tInvHand !== null);
    const real = !!(s.lens || s.relief || s.area);
    const lm = s.lens ? lensMap(lensFor(s.lens, W, H), W, H) : null;

    const tgt = s.target;
    const bg = s.bg;
    const Tw = tgt.width;
    const Th = tgt.height;
    const Bw = bg.width;
    const Bh = bg.height;
    const bgA = s.bgPlane.affine;
    const bgZ = s.bgPlane.z;
    const gloss = s.gloss;
    const hand = s.hand;
    const lightDir = s.lightDir;
    const tInv = new Float64Array(9);
    const bInv = new Float64Array(9);
    const hInv = new Float64Array(9);
    const tList = this.tList;
    const bList = this.bList;
    const rowVal = this.rowVal;
    const rowLight = this.rowLight;
    const rowGlare = this.rowGlare;
    const rowAlpha = this.rowAlpha;
    const rowShade = this.rowShade;
    const hcol = hand ? hand.color : [0, 0, 0];
    // 대상이 배경에 드리우는 그림자 (배경이 뒤에 떨어져 있을 때): 배경 점에서 광원 쪽으로 bgZ만큼 → 대상 사각형과의 거리
    const dropK = bgZ > 0 ? bgZ / lightDir[2] : 0;
    const dropX = -dropK * lightDir[0];
    const dropY = -dropK * lightDir[1];
    const dropSoft = Math.max(1, 0.35 * bgZ + 0.01 * Tw);

    for (let sub = 0; sub < nSub; sub++) {
      const ts = nSub > 1 ? t - e / 2 + ((sub + 0.5) * e) / nSub : t;
      const pose = s.poseAt(ts);
      // 정반사 지점
      let spx = 0;
      let spy = 0;
      let glossOn = false;
      let g2 = 1;
      let gStr = 0;
      if (gloss && gloss.strength > 0) {
        const sp = specularPoint(gloss.light, pose.C);
        if (sp) {
          spx = sp.x;
          spy = sp.y;
          glossOn = true;
          g2 = 1 / (2 * gloss.sigma * gloss.sigma);
          gStr = gloss.strength;
        }
      }
      // 손: 화면 bbox, 픽셀당 mm, 그림자용 월드→손 로컬
      let hx0 = 1;
      let hx1 = 0;
      let hy0 = 1;
      let hy1 = 0;
      let pxMm = 1;
      let hp: HandPose | null = null;
      let hc = 1;
      let hs = 0;
      let shOffX = 0;
      let shOffY = 0;
      let shOffBgX = 0;
      let shOffBgY = 0;
      let shSoft = 1;
      let upm = 1;
      let hShadow = 0;
      if (hand && hasHand) {
        hp = hand.at(ts);
        if (hp) {
          upm = hand.unitsPerMm;
          hShadow = hand.shadow;
          const Hh = planeToImage(K, pose, -hand.heightUnits, handAffine(hp, hand.unitsPerMm));
          let ok = true;
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const [lx, ly] of [
            [HAND_BOUNDS.x0, HAND_BOUNDS.y0],
            [HAND_BOUNDS.x1, HAND_BOUNDS.y0],
            [HAND_BOUNDS.x1, HAND_BOUNDS.y1],
            [HAND_BOUNDS.x0, HAND_BOUNDS.y1],
          ]) {
            const q = project(Hh, lx, ly);
            if (!q) {
              ok = false;
              break;
            }
            minX = Math.min(minX, q.x);
            maxX = Math.max(maxX, q.x);
            minY = Math.min(minY, q.y);
            maxY = Math.max(maxY, q.y);
          }
          const margin = 8 + (ro > 0 ? motion * (ro / Math.max(e, 1e-3)) : 0);
          if (!ok) {
            hx0 = 0;
            hx1 = W - 1;
            hy0 = 0;
            hy1 = H - 1;
          } else {
            hx0 = Math.max(0, Math.floor(minX - margin));
            hx1 = Math.min(W - 1, Math.ceil(maxX + margin));
            hy0 = Math.max(0, Math.floor(minY - margin));
            hy1 = Math.min(H - 1, Math.ceil(maxY + margin));
          }
          const c0 = project(Hh, 0, 40);
          const c1 = project(Hh, 1, 40);
          const c2 = project(Hh, 0, 41);
          if (c0 && c1 && c2) {
            const sx = Math.hypot(c1.x - c0.x, c1.y - c0.y);
            const sy = Math.hypot(c2.x - c0.x, c2.y - c0.y);
            pxMm = 1 / Math.max(1e-6, Math.sqrt(sx * sy));
          }
          const ang = (hp.angle * Math.PI) / 180;
          hc = Math.cos(ang);
          hs = Math.sin(ang);
          const kz = hand.heightUnits / lightDir[2];
          shOffX = -kz * lightDir[0];
          shOffY = -kz * lightDir[1];
          const kb = (hand.heightUnits + bgZ) / lightDir[2];
          shOffBgX = -kb * lightDir[0];
          shOffBgY = -kb * lightDir[1];
          shSoft = Math.max(3, (0.18 * hand.heightUnits) / hand.unitsPerMm);
        }
      }
      const hpx = hp ? hp.x : 0;
      const hpy = hp ? hp.y : 0;
      const blob = s.shadow ? s.shadow(ts) : null;

      if (real) {
        const pad = lm ? Math.ceil(lm.maxShift) + 2 : 0;
        this.realRows({
          W, H, N, nch, ts, ro, m, dt, tMin, table, accum, vig, surf, lodBias, lm, cam: pose.C,
          dropK, dropX, dropY, dropSoft, glossOn, spx, spy, g2, gStr, blob,
          hand: hp ? { hp, hx0: Math.max(0, hx0 - pad), hx1: Math.min(W - 1, hx1 + pad), hy0: Math.max(0, hy0 - pad), hy1: Math.min(H - 1, hy1 + pad), pxMm, hc, hs, shOffX, shOffY, shOffBgX, shOffBgY, shSoft, upm, hShadow, hpx, hpy, hcol } : null,
        });
        continue;
      }

      for (let y = 0; y < H; y++) {
        // 이 행의 시각 (롤링 셔터) → 자세 표 보간
        const tr = ts + ((y + 0.5) / H - 0.5) * ro;
        let fi = m > 1 ? (tr - tMin) / dt : 0;
        if (fi < 0) fi = 0;
        if (fi > m - 1) fi = m - 1;
        const i0 = m > 1 ? Math.min(m - 2, fi | 0) : 0;
        const f = m > 1 ? fi - i0 : 0;
        const A = table[i0];
        const B = table[m > 1 ? i0 + 1 : 0];
        for (let k = 0; k < 9; k++) {
          tInv[k] = A.tInvTarget[k] + (B.tInvTarget[k] - A.tInvTarget[k]) * f;
          bInv[k] = A.tInvBg[k] + (B.tInvBg[k] - A.tInvBg[k]) * f;
        }
        const handRow = hp !== null && y >= hy0 && y <= hy1;
        if (handRow) {
          const ha = A.tInvHand!;
          const hb = B.tInvHand!;
          for (let k = 0; k < 9; k++) hInv[k] = ha[k] + (hb[k] - ha[k]) * f;
        }
        const py = y + 0.5;
        const tA = tInv[1] * py + tInv[2];
        const tB = tInv[4] * py + tInv[5];
        const tW = tInv[7] * py + tInv[8];
        const bA = bInv[1] * py + bInv[2];
        const bB = bInv[4] * py + bInv[5];
        const bW = bInv[7] * py + bInv[8];
        const row = y * W;
        tList.n = 0;
        bList.n = 0;

        // (1) 기하 패스
        for (let x = 0; x < W; x++) {
          const px = x + 0.5;
          let wx = 0;
          let wy = 0;
          let onTarget = false;
          let glare = 0;
          const hw = tInv[6] * px + tW;
          if (hw > 1e-12) {
            const iw = 1 / hw;
            const u = (tInv[0] * px + tA) * iw;
            const v = (tInv[3] * px + tB) * iw;
            if (u >= 0 && u < Tw && v >= 0 && v < Th) {
              onTarget = true;
              wx = u;
              wy = v;
              pushAniso(
                tList,
                x,
                u,
                v,
                (tInv[0] - u * tInv[6]) * iw,
                (tInv[3] - v * tInv[6]) * iw,
                (tInv[1] - u * tInv[7]) * iw,
                (tInv[4] - v * tInv[7]) * iw,
                lodBias,
                0,
                0,
              );
              if (glossOn) {
                const dx = u - spx;
                const dy = v - spy;
                const d2 = (dx * dx + dy * dy) * g2;
                if (d2 < 12) glare = gStr * Math.exp(-d2);
              }
            }
          }
          let light = 1;
          if (!onTarget) {
            const bw = bInv[6] * px + bW;
            const iw = bw > 1e-12 ? 1 / bw : 1e12;
            const u = (bInv[0] * px + bA) * iw;
            const v = (bInv[3] * px + bB) * iw;
            pushAniso(
              bList,
              x,
              u,
              v,
              (bInv[0] - u * bInv[6]) * iw,
              (bInv[3] - v * bInv[6]) * iw,
              (bInv[1] - u * bInv[7]) * iw,
              (bInv[4] - v * bInv[7]) * iw,
              lodBias,
              Bw,
              Bh,
            );
            wx = bgA[0] * u + bgA[1] * v + bgA[2];
            wy = bgA[3] * u + bgA[4] * v + bgA[5];
            if (dropK > 0) {
              // 대상 사각형까지 거리 → 부드러운 접지 그림자
              const qx = wx - dropX;
              const qy = wy - dropY;
              const ddx = qx < 0 ? -qx : qx > Tw ? qx - Tw : 0;
              const ddy = qy < 0 ? -qy : qy > Th ? qy - Th : 0;
              const dd = Math.sqrt(ddx * ddx + ddy * ddy) / dropSoft;
              if (dd < 3) light *= 1 - 0.5 * Math.exp(-dd * dd);
            }
          }
          // 조명: 몸 그림자(타원), 손 그림자
          if (blob) {
            const ex = (wx - blob.x) / blob.rx;
            const ey = (wy - blob.y) / blob.ry;
            const d = (Math.sqrt(ex * ex + ey * ey) - 1) * Math.min(blob.rx, blob.ry);
            const tt = (d + blob.soft) / (2 * blob.soft);
            const sm = tt <= 0 ? 0 : tt >= 1 ? 1 : tt * tt * (3 - 2 * tt);
            light *= 1 - blob.depth * (1 - sm);
          }
          if (hp) {
            const qx = (wx + (onTarget ? shOffX : shOffBgX) - hpx) / upm;
            const qy = (wy + (onTarget ? shOffY : shOffBgY) - hpy) / upm;
            const lx = hc * qx + hs * qy;
            const ly = -hs * qx + hc * qy;
            if (
              lx > HAND_BOUNDS.x0 - shSoft &&
              lx < HAND_BOUNDS.x1 + shSoft &&
              ly > HAND_BOUNDS.y0 - shSoft &&
              ly < HAND_BOUNDS.y1 + shSoft
            ) {
              const d = handSdf(lx, ly);
              const tt = (d + shSoft) / (2 * shSoft);
              const sm = tt <= 0 ? 0 : tt >= 1 ? 1 : tt * tt * (3 - 2 * tt);
              light *= 1 - hShadow * (1 - sm);
            }
          }
          // 가리는 손
          let alpha = 0;
          let shade = 0;
          if (handRow && x >= hx0 && x <= hx1) {
            const w3 = hInv[6] * px + hInv[7] * py + hInv[8];
            if (w3 > 1e-12) {
              const lx = (hInv[0] * px + hInv[1] * py + hInv[2]) / w3;
              const ly = (hInv[3] * px + hInv[4] * py + hInv[5]) / w3;
              const d = handSdf(lx, ly);
              alpha = 0.5 - d / pxMm;
              if (alpha > 0) {
                if (alpha > 1) alpha = 1;
                const rim = -d / 16;
                shade = 0.6 + 0.4 * (rim >= 1 ? 1 : rim <= 0 ? 0 : rim * (2 - rim));
                shade *= 1 + 0.05 * Math.sin(lx * 0.45) * Math.sin(ly * 0.33 + 1.3);
                if (nailSdf(lx, ly) < 0) shade *= 1.12;
              } else alpha = 0;
            }
          }
          rowLight[x] = light;
          rowGlare[x] = glare;
          rowAlpha[x] = alpha;
          rowShade[x] = shade;
          surf[row + x] = alpha > 0.5 ? 2 : onTarget ? 0 : 1;
        }

        // (2) 샘플 패스
        rowVal.fill(0, 0, W * nch);
        for (let c = 0; c < nch; c++) {
          if (tList.n) sampleList(tgt.channels[c], tList, rowVal, nch, c);
          if (bList.n) sampleList(bg.channels[c], bList, rowVal, nch, c);
        }

        // (3) 합성
        for (let x = 0; x < W; x++) {
          const vg = vig[row + x];
          const light = rowLight[x];
          const glare = rowGlare[x];
          const alpha = rowAlpha[x];
          for (let c = 0; c < nch; c++) {
            let v = (rowVal[x * nch + c] + glare) * light;
            if (alpha > 0) v = v * (1 - alpha) + hcol[c] * rowShade[x] * alpha;
            accum[c * N + row + x] += v * vg;
          }
        }
      }
    }

    if (nSub > 1) {
      const inv = 1 / nSub;
      for (let i = 0; i < accum.length; i++) accum[i] *= inv;
    } else if (!exact && e > 0 && motion > 0.75) {
      if (lm) this.motionBlurLens(t, K, e, lm);
      else this.motionBlur(t, K, e);
    }

    // 렌즈 번짐 [1 2 1]/4 (선형광, σ≈0.71) + 초점 흐림
    const fs = s.focusSigma ? s.focusSigma(t) : 0;
    if (fs > 0.05) {
      const sigma = Math.sqrt((s.opticalBlur ? 0.5 : 0) + fs * fs);
      for (let c = 0; c < nch; c++) this.gaussBlur(accum, c * N, W, H, sigma);
    } else if (s.opticalBlur) {
      for (let c = 0; c < nch; c++) this.blur121(accum, c * N, W, H);
    }
    // 조명 깜빡임: 행마다 다른 시각 → 노출 시간 동안 평균한 밝기 변조 (롤링 셔터 띠)
    if (s.flicker && s.flicker.depth > 0) {
      const w = 2 * Math.PI * s.flicker.hz;
      const half = (w * e) / 2;
      const att = half > 1e-6 ? Math.sin(half) / half : 1;
      for (let y = 0; y < H; y++) {
        const tr = t + ((y + 0.5) / H - 0.5) * ro;
        const f = 1 + s.flicker.depth * att * Math.sin(w * tr);
        for (let c = 0; c < nch; c++) {
          const o = c * N + y * W;
          for (let x = 0; x < W; x++) accum[o + x] *= f;
        }
      }
    }

    // 센서: 이득·잡음·톤
    const photo = s.photoAt(t);
    const lut = this.toneLut(photo);
    const gain = photo.gain * (s.ae ? s.ae(t) : 1);
    const scale = photo.scene * gain;
    const shot = s.noise.shot * gain;
    const read2 = (s.noise.read * gain) ** 2;
    const rng = new Rng(hashString(`${s.seed}|${Math.round(t * 1e6)}`));
    const tab = this.noiseTab;
    const mask = tab.length - 1;
    const planes: Uint8Array[] = [];
    for (let c = 0; c < nch; c++) {
      const out = new Uint8Array(N);
      const base = c * N;
      for (let y = 0; y < H; y++) {
        let ni = rng.int(tab.length);
        const row = y * W;
        for (let x = 0; x < W; x++) {
          let v = accum[base + row + x] * scale;
          if (v < 0) v = 0;
          v += Math.sqrt(shot * v + read2) * tab[ni & mask];
          ni++;
          let q = (v * TONE_N + 0.5) | 0;
          if (q < 0) q = 0;
          else if (q > TONE_N) q = TONE_N;
          out[row + x] = lut[q];
        }
      }
      planes.push(out);
    }
    return { width: W, height: H, planes };
  }

  /**
   * 노출 적분 모션 블러: 픽셀 p가 시각 τ에 본 점은 중심 시각 영상의 M_τ(p) = H(t)·H(τ)⁻¹·p.
   * τ = t±e/2 두 끝점 사이를 직선으로 표본화해 평균 (표면마다 자기 호모그래피 — 대상·배경 시차, 손 움직임 반영).
   */
  private motionBlur(t: number, K: Intrinsics, e: number): void {
    const s = this.scene;
    const W = K.width;
    const H = K.height;
    const N = W * H;
    const nch = this.nch;
    const pc = s.poseAt(t);
    const p0 = s.poseAt(t - e / 2);
    const p1 = s.poseAt(t + e / 2);
    const M = new Float64Array(3 * 18);
    const put = (k: number, z: number, Ac: readonly number[], A0: readonly number[], A1: readonly number[]) => {
      const Hc = planeToImage(K, pc, z, Ac);
      const m0 = mul3(Hc, invertOrThrow(planeToImage(K, p0, z, A0)));
      const m1 = mul3(Hc, invertOrThrow(planeToImage(K, p1, z, A1)));
      for (let i = 0; i < 9; i++) {
        M[k * 18 + i] = m0[i];
        M[k * 18 + 9 + i] = m1[i];
      }
    };
    put(0, 0, TARGET_AFFINE, TARGET_AFFINE, TARGET_AFFINE);
    put(1, s.bgPlane.z, s.bgPlane.affine, s.bgPlane.affine, s.bgPlane.affine);
    const hand = s.hand;
    const hc = hand?.at(t);
    const h0 = hand?.at(t - e / 2);
    const h1 = hand?.at(t + e / 2);
    if (hand && hc && h0 && h1) {
      const z = -hand.heightUnits;
      put(2, z, handAffine(hc, hand.unitsPerMm), handAffine(h0, hand.unitsPerMm), handAffine(h1, hand.unitsPerMm));
    } else {
      for (let i = 0; i < 18; i++) M[36 + i] = i % 4 === 0 ? 1 : 0;
    }
    if (this.blurSrc.length !== this.accum.length) this.blurSrc = new Float32Array(this.accum.length);
    const src = this.blurSrc;
    src.set(this.accum);
    const dst = this.accum;
    const surf = this.surf;
    for (let y = 0; y < H; y++) {
      const py = y + 0.5;
      for (let x = 0; x < W; x++) {
        const px = x + 0.5;
        const o = surf[y * W + x] * 18;
        let w = M[o + 6] * px + M[o + 7] * py + M[o + 8];
        if (!(w > 1e-9)) continue;
        const ax = (M[o] * px + M[o + 1] * py + M[o + 2]) / w - 0.5;
        const ay = (M[o + 3] * px + M[o + 4] * py + M[o + 5]) / w - 0.5;
        w = M[o + 15] * px + M[o + 16] * py + M[o + 17];
        if (!(w > 1e-9)) continue;
        const bx = (M[o + 9] * px + M[o + 10] * py + M[o + 11]) / w - 0.5;
        const by = (M[o + 12] * px + M[o + 13] * py + M[o + 14]) / w - 0.5;
        const dx = bx - ax;
        const dy = by - ay;
        let n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / 0.7);
        if (n <= 1) continue;
        if (n > MAX_BLUR_TAPS) n = MAX_BLUR_TAPS;
        for (let c = 0; c < nch; c++) {
          const base = c * N;
          let sum = 0;
          for (let i = 0; i < n; i++) {
            const k = (i + 0.5) / n;
            const qx = ax + dx * k;
            const qy = ay + dy * k;
            let x0 = Math.floor(qx);
            let y0 = Math.floor(qy);
            const fx = qx - x0;
            const fy = qy - y0;
            let x1 = x0 + 1;
            let y1 = y0 + 1;
            if (x0 < 0) x0 = 0;
            else if (x0 >= W) x0 = W - 1;
            if (x1 < 0) x1 = 0;
            else if (x1 >= W) x1 = W - 1;
            if (y0 < 0) y0 = 0;
            else if (y0 >= H) y0 = H - 1;
            if (y1 < 0) y1 = 0;
            else if (y1 >= H) y1 = H - 1;
            const r0 = base + y0 * W;
            const r1 = base + y1 * W;
            const a0 = src[r0 + x0];
            const b0 = src[r1 + x0];
            const top = a0 + (src[r0 + x1] - a0) * fx;
            const bot = b0 + (src[r1 + x1] - b0) * fx;
            sum += top + (bot - top) * fy;
          }
          dst[base + y * W + x] = sum / n;
        }
      }
    }
  }

  /**
   * 실감 경로의 행 패스 (기하 → 샘플 → 합성). 기존 경로와 같은 일을 하되
   * (1) 센서 픽셀 → 핀홀 좌표를 렌즈 표로 (2) 대상은 부조가 있으면 광선 추적(윗면·옆벽·그늘)
   * (3) 면광원 정반사를 더한다. 야코비안(텍스처 발자국)에는 렌즈 야코비안을 곱한다.
   */
  private realRows(c: RealCtx): void {
    const s = this.scene;
    const { W, H, N, nch, ts, ro, m, dt, tMin, table, accum, vig, surf, lodBias, lm } = c;
    const tgt = s.target;
    const bg = s.bg;
    const Tw = tgt.width;
    const Th = tgt.height;
    const Bw = bg.width;
    const Bh = bg.height;
    const bgA = s.bgPlane.affine;
    const R = s.relief ?? null;
    const area = s.area ?? null;
    const lightDir = s.lightDir;
    const tList = this.tList;
    const bList = this.bList;
    const rowVal = this.rowVal;
    const rowLight = this.rowLight;
    const rowGlare = this.rowGlare;
    const rowAlpha = this.rowAlpha;
    const rowShade = this.rowShade;
    const tInv = new Float64Array(9);
    const bInv = new Float64Array(9);
    const hInv = new Float64Array(9);
    const ray = new Float64Array(9);
    const C = new Float64Array(3);
    const hit: ReliefHit = { u: 0, v: 0, z: 0, wall: false };
    const hd = c.hand;
    const hcol = hd ? hd.hcol : [0, 0, 0];
    const ca = area ? Math.cos((area.angle * Math.PI) / 180) : 1;
    const sa = area ? Math.sin((area.angle * Math.PI) / 180) : 0;
    const lxy = Math.hypot(lightDir[0], lightDir[1]);
    for (let y = 0; y < H; y++) {
      const tr = ts + ((y + 0.5) / H - 0.5) * ro;
      let fi = m > 1 ? (tr - tMin) / dt : 0;
      if (fi < 0) fi = 0;
      if (fi > m - 1) fi = m - 1;
      const i0 = m > 1 ? Math.min(m - 2, fi | 0) : 0;
      const f = m > 1 ? fi - i0 : 0;
      const A = table[i0];
      const B = table[m > 1 ? i0 + 1 : 0];
      for (let k = 0; k < 9; k++) {
        tInv[k] = A.tInvTarget[k] + (B.tInvTarget[k] - A.tInvTarget[k]) * f;
        bInv[k] = A.tInvBg[k] + (B.tInvBg[k] - A.tInvBg[k]) * f;
      }
      if (R) {
        for (let k = 0; k < 9; k++) ray[k] = A.ray![k] + (B.ray![k] - A.ray![k]) * f;
        for (let k = 0; k < 3; k++) C[k] = A.C![k] + (B.C![k] - A.C![k]) * f;
      } else {
        C[0] = c.cam[0];
        C[1] = c.cam[1];
        C[2] = c.cam[2];
      }
      const handRow = hd !== null && y >= hd.hy0 && y <= hd.hy1;
      if (handRow) {
        const ha = A.tInvHand!;
        const hb = B.tInvHand!;
        for (let k = 0; k < 9; k++) hInv[k] = ha[k] + (hb[k] - ha[k]) * f;
      }
      const row = y * W;
      tList.n = 0;
      bList.n = 0;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        // 센서 → 핀홀
        let qx = x + 0.5;
        let qy = y + 0.5;
        let ja = 1;
        let jb = 0;
        let jc = 0;
        let jd = 1;
        if (lm) {
          qx = lm.qx[i];
          qy = lm.qy[i];
          ja = lm.ja[i];
          jb = lm.jb[i];
          jc = lm.jc[i];
          jd = lm.jd[i];
        }
        let wx = 0;
        let wy = 0;
        let onTarget = false;
        let glare = 0;
        let light = 1;
        let zs = 0;
        // 대상: 핀홀 q에서 평면 z의 텍스처 좌표·야코비안 (du/dq) → 센서 야코비안 = du/dq · dq/ds
        let u = 0;
        let v = 0;
        let dux = 0;
        let dvx = 0;
        let duy = 0;
        let dvy = 0;
        if (R) {
          const rx = ray[0] * qx + ray[1] * qy + ray[2];
          const ry = ray[3] * qx + ray[4] * qy + ray[5];
          const rz = ray[6] * qx + ray[7] * qy + ray[8];
          if (traceRelief(R, C[0], C[1], C[2], rx, ry, rz, hit)) {
            onTarget = true;
            u = hit.u;
            v = hit.v;
            zs = hit.z;
            // uv = C + (z − Cz)/rz · (rx, ry) 의 q 미분
            const kz = (zs - C[2]) / rz;
            const ax = rx / rz;
            const ay = ry / rz;
            const du0 = kz * (ray[0] - ax * ray[6]);
            const du1 = kz * (ray[1] - ax * ray[7]);
            const dv0 = kz * (ray[3] - ay * ray[6]);
            const dv1 = kz * (ray[4] - ay * ray[7]);
            dux = du0 * ja + du1 * jc;
            duy = du0 * jb + du1 * jd;
            dvx = dv0 * ja + dv1 * jc;
            dvy = dv0 * jb + dv1 * jd;
            if (hit.wall) {
              const kl = Math.hypot(ax, ay) || 1;
              const lam = (ax * lightDir[0] + ay * lightDir[1]) / kl;
              light *= Math.min(1, 0.4 + (0.6 * Math.max(0, lam)) / Math.max(0.3, lightDir[2]));
            } else if (lxy > 1e-6) {
              const sh = reliefShadow(R, u, v, -zs, lightDir[0], lightDir[1], lightDir[2]);
              if (sh > 0) light *= 1 - 0.45 * sh;
            }
          }
        } else {
          const hw = tInv[6] * qx + tInv[7] * qy + tInv[8];
          if (hw > 1e-12) {
            const iw = 1 / hw;
            u = (tInv[0] * qx + tInv[1] * qy + tInv[2]) * iw;
            v = (tInv[3] * qx + tInv[4] * qy + tInv[5]) * iw;
            if (u >= 0 && u < Tw && v >= 0 && v < Th) {
              onTarget = true;
              const du0 = (tInv[0] - u * tInv[6]) * iw;
              const dv0 = (tInv[3] - v * tInv[6]) * iw;
              const du1 = (tInv[1] - u * tInv[7]) * iw;
              const dv1 = (tInv[4] - v * tInv[7]) * iw;
              dux = du0 * ja + du1 * jc;
              duy = du0 * jb + du1 * jd;
              dvx = dv0 * ja + dv1 * jc;
              dvy = dv0 * jb + dv1 * jd;
            }
          }
        }
        if (onTarget) {
          wx = u;
          wy = v;
          pushAniso(tList, x, u, v, dux, dvx, duy, dvy, lodBias, 0, 0);
          if (c.glossOn) {
            const gx = u - c.spx;
            const gy = v - c.spy;
            const d2 = (gx * gx + gy * gy) * c.g2;
            if (d2 < 12) glare = c.gStr * Math.exp(-d2);
          }
          if (area) {
            // 거울 반사: 표면점 P에서 반사 광선이 광원 평면(z=−dist)에 닿는 점 Q
            const zL = -area.dist;
            const den = C[2] - zs;
            if (den < -1e-9) {
              const k = (zL - zs) / den;
              const qxL = u + k * (u - C[0]) - area.x;
              const qyL = v + k * (v - C[1]) - area.y;
              const lx = ca * qxL + sa * qyL;
              const ly = -sa * qxL + ca * qyL;
              const b = area.blur;
              const ex = (Math.abs(lx) - area.w / 2) / b;
              const ey = (Math.abs(ly) - area.h / 2) / b;
              if (ex < 1 && ey < 1) {
                const fx = ex <= -1 ? 1 : 0.5 - 0.75 * ex + 0.25 * ex * ex * ex;
                const fy = ey <= -1 ? 1 : 0.5 - 0.75 * ey + 0.25 * ey * ey * ey;
                // 프레넬 (슐릭, F0 = 0.04) — 비스듬할수록 강해진다
                const dxc = u - C[0];
                const dyc = v - C[1];
                const cosT = -den / Math.sqrt(dxc * dxc + dyc * dyc + den * den);
                const om = 1 - cosT;
                const fr = (0.04 + 0.96 * om * om * om * om * om) / 0.04;
                glare += area.strength * fx * fy * fr;
              }
            }
          }
        } else {
          const bw = bInv[6] * qx + bInv[7] * qy + bInv[8];
          const iw = bw > 1e-12 ? 1 / bw : 1e12;
          const bu = (bInv[0] * qx + bInv[1] * qy + bInv[2]) * iw;
          const bv = (bInv[3] * qx + bInv[4] * qy + bInv[5]) * iw;
          const du0 = (bInv[0] - bu * bInv[6]) * iw;
          const dv0 = (bInv[3] - bv * bInv[6]) * iw;
          const du1 = (bInv[1] - bu * bInv[7]) * iw;
          const dv1 = (bInv[4] - bv * bInv[7]) * iw;
          pushAniso(bList, x, bu, bv, du0 * ja + du1 * jc, dv0 * ja + dv1 * jc, du0 * jb + du1 * jd, dv0 * jb + dv1 * jd, lodBias, Bw, Bh);
          wx = bgA[0] * bu + bgA[1] * bv + bgA[2];
          wy = bgA[3] * bu + bgA[4] * bv + bgA[5];
          if (c.dropK > 0) {
            const px2 = wx - c.dropX;
            const py2 = wy - c.dropY;
            const ddx = px2 < 0 ? -px2 : px2 > Tw ? px2 - Tw : 0;
            const ddy = py2 < 0 ? -py2 : py2 > Th ? py2 - Th : 0;
            const dd = Math.sqrt(ddx * ddx + ddy * ddy) / c.dropSoft;
            if (dd < 3) light *= 1 - 0.5 * Math.exp(-dd * dd);
          }
        }
        const blob = c.blob;
        if (blob) {
          const ex = (wx - blob.x) / blob.rx;
          const ey = (wy - blob.y) / blob.ry;
          const d = (Math.sqrt(ex * ex + ey * ey) - 1) * Math.min(blob.rx, blob.ry);
          const tt = (d + blob.soft) / (2 * blob.soft);
          const sm = tt <= 0 ? 0 : tt >= 1 ? 1 : tt * tt * (3 - 2 * tt);
          light *= 1 - blob.depth * (1 - sm);
        }
        let alpha = 0;
        let shade = 0;
        if (hd) {
          const qx2 = (wx + (onTarget ? hd.shOffX : hd.shOffBgX) - hd.hpx) / hd.upm;
          const qy2 = (wy + (onTarget ? hd.shOffY : hd.shOffBgY) - hd.hpy) / hd.upm;
          const lx = hd.hc * qx2 + hd.hs * qy2;
          const ly = -hd.hs * qx2 + hd.hc * qy2;
          const ss = hd.shSoft;
          if (lx > HAND_BOUNDS.x0 - ss && lx < HAND_BOUNDS.x1 + ss && ly > HAND_BOUNDS.y0 - ss && ly < HAND_BOUNDS.y1 + ss) {
            const d = handSdf(lx, ly);
            const tt = (d + ss) / (2 * ss);
            const sm = tt <= 0 ? 0 : tt >= 1 ? 1 : tt * tt * (3 - 2 * tt);
            light *= 1 - hd.hShadow * (1 - sm);
          }
          if (handRow && x >= hd.hx0 && x <= hd.hx1) {
            const w3 = hInv[6] * qx + hInv[7] * qy + hInv[8];
            if (w3 > 1e-12) {
              const lx3 = (hInv[0] * qx + hInv[1] * qy + hInv[2]) / w3;
              const ly3 = (hInv[3] * qx + hInv[4] * qy + hInv[5]) / w3;
              const d = handSdf(lx3, ly3);
              alpha = 0.5 - d / hd.pxMm;
              if (alpha > 0) {
                if (alpha > 1) alpha = 1;
                const rim = -d / 16;
                shade = 0.6 + 0.4 * (rim >= 1 ? 1 : rim <= 0 ? 0 : rim * (2 - rim));
                shade *= 1 + 0.05 * Math.sin(lx3 * 0.45) * Math.sin(ly3 * 0.33 + 1.3);
                if (nailSdf(lx3, ly3) < 0) shade *= 1.12;
              } else alpha = 0;
            }
          }
        }
        rowLight[x] = light;
        rowGlare[x] = glare;
        rowAlpha[x] = alpha;
        rowShade[x] = shade;
        surf[i] = alpha > 0.5 ? 2 : onTarget ? 0 : 1;
      }
      rowVal.fill(0, 0, W * nch);
      for (let ch = 0; ch < nch; ch++) {
        if (tList.n) sampleList(tgt.channels[ch], tList, rowVal, nch, ch);
        if (bList.n) sampleList(bg.channels[ch], bList, rowVal, nch, ch);
      }
      for (let x = 0; x < W; x++) {
        const vg = vig[row + x];
        const light = rowLight[x];
        const glare = rowGlare[x];
        const alpha = rowAlpha[x];
        for (let ch = 0; ch < nch; ch++) {
          let val = (rowVal[x * nch + ch] + glare) * light;
          if (alpha > 0) val = val * (1 - alpha) + hcol[ch] * rowShade[x] * alpha;
          accum[ch * N + row + x] += val * vg;
        }
      }
    }
  }

  /** motionBlur의 렌즈 판: 픽셀 → 핀홀(표) → 표면 호모그래피 → 왜곡 → 센서에서 선 적분 */
  private motionBlurLens(t: number, K: Intrinsics, e: number, lm: LensMap): void {
    const s = this.scene;
    const W = K.width;
    const H = K.height;
    const N = W * H;
    const nch = this.nch;
    const L = lensFor(s.lens!, W, H);
    const pc = s.poseAt(t);
    const p0 = s.poseAt(t - e / 2);
    const p1 = s.poseAt(t + e / 2);
    const M = new Float64Array(3 * 18);
    const put = (k: number, z: number, Ac: readonly number[], A0: readonly number[], A1: readonly number[]) => {
      const Hc = planeToImage(K, pc, z, Ac);
      const m0 = mul3(Hc, invertOrThrow(planeToImage(K, p0, z, A0)));
      const m1 = mul3(Hc, invertOrThrow(planeToImage(K, p1, z, A1)));
      for (let i = 0; i < 9; i++) {
        M[k * 18 + i] = m0[i];
        M[k * 18 + 9 + i] = m1[i];
      }
    };
    put(0, 0, TARGET_AFFINE, TARGET_AFFINE, TARGET_AFFINE);
    put(1, s.bgPlane.z, s.bgPlane.affine, s.bgPlane.affine, s.bgPlane.affine);
    const hand = s.hand;
    const hc = hand?.at(t);
    const h0 = hand?.at(t - e / 2);
    const h1 = hand?.at(t + e / 2);
    if (hand && hc && h0 && h1) {
      const z = -hand.heightUnits;
      put(2, z, handAffine(hc, hand.unitsPerMm), handAffine(h0, hand.unitsPerMm), handAffine(h1, hand.unitsPerMm));
    } else {
      for (let i = 0; i < 18; i++) M[36 + i] = i % 4 === 0 ? 1 : 0;
    }
    if (this.blurSrc.length !== this.accum.length) this.blurSrc = new Float32Array(this.accum.length);
    const src = this.blurSrc;
    src.set(this.accum);
    const dst = this.accum;
    const surf = this.surf;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const qx = lm.qx[i];
        const qy = lm.qy[i];
        const o = surf[i] * 18;
        let w = M[o + 6] * qx + M[o + 7] * qy + M[o + 8];
        if (!(w > 1e-9)) continue;
        const a = distort(L, (M[o] * qx + M[o + 1] * qy + M[o + 2]) / w, (M[o + 3] * qx + M[o + 4] * qy + M[o + 5]) / w);
        w = M[o + 15] * qx + M[o + 16] * qy + M[o + 17];
        if (!(w > 1e-9)) continue;
        const b = distort(L, (M[o + 9] * qx + M[o + 10] * qy + M[o + 11]) / w, (M[o + 12] * qx + M[o + 13] * qy + M[o + 14]) / w);
        const ax = a.x - 0.5;
        const ay = a.y - 0.5;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        let n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / 0.7);
        if (n <= 1) continue;
        if (n > MAX_BLUR_TAPS) n = MAX_BLUR_TAPS;
        for (let ch = 0; ch < nch; ch++) {
          const base = ch * N;
          let sum = 0;
          for (let j = 0; j < n; j++) {
            const k = (j + 0.5) / n;
            const px = ax + dx * k;
            const py = ay + dy * k;
            let x0 = Math.floor(px);
            let y0 = Math.floor(py);
            const fx = px - x0;
            const fy = py - y0;
            let x1 = x0 + 1;
            let y1 = y0 + 1;
            if (x0 < 0) x0 = 0;
            else if (x0 >= W) x0 = W - 1;
            if (x1 < 0) x1 = 0;
            else if (x1 >= W) x1 = W - 1;
            if (y0 < 0) y0 = 0;
            else if (y0 >= H) y0 = H - 1;
            if (y1 < 0) y1 = 0;
            else if (y1 >= H) y1 = H - 1;
            const r0 = base + y0 * W;
            const r1 = base + y1 * W;
            const a0 = src[r0 + x0];
            const b0 = src[r1 + x0];
            const top = a0 + (src[r0 + x1] - a0) * fx;
            const bot = b0 + (src[r1 + x1] - b0) * fx;
            sum += top + (bot - top) * fy;
          }
          dst[base + i] = sum / n;
        }
      }
    }
  }

  /** 분리형 가우시안 (가장자리 복제) */
  private gaussBlur(a: Float32Array, off: number, W: number, H: number, sigma: number): void {
    const r = Math.max(1, Math.ceil(2.5 * sigma));
    const k = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = this.tmp;
    for (let y = 0; y < H; y++) {
      const o = off + y * W;
      for (let x = 0; x < W; x++) tmp[x] = a[o + x];
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let i = -r; i <= r; i++) {
          const xx = x + i < 0 ? 0 : x + i >= W ? W - 1 : x + i;
          v += k[i + r] * tmp[xx];
        }
        a[o + x] = v;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) tmp[y] = a[off + y * W + x];
      for (let y = 0; y < H; y++) {
        let v = 0;
        for (let i = -r; i <= r; i++) {
          const yy = y + i < 0 ? 0 : y + i >= H ? H - 1 : y + i;
          v += k[i + r] * tmp[yy];
        }
        a[off + y * W + x] = v;
      }
    }
  }

  private blur121(a: Float32Array, off: number, W: number, H: number): void {
    const tmp = this.tmp;
    for (let y = 0; y < H; y++) {
      const r = off + y * W;
      for (let x = 0; x < W; x++) tmp[x] = a[r + x];
      a[r] = (3 * tmp[0] + tmp[1]) * 0.25;
      for (let x = 1; x < W - 1; x++) a[r + x] = (tmp[x - 1] + 2 * tmp[x] + tmp[x + 1]) * 0.25;
      a[r + W - 1] = (tmp[W - 2] + 3 * tmp[W - 1]) * 0.25;
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) tmp[y] = a[off + y * W + x];
      a[off + x] = (3 * tmp[0] + tmp[1]) * 0.25;
      for (let y = 1; y < H - 1; y++) a[off + y * W + x] = (tmp[y - 1] + 2 * tmp[y] + tmp[y + 1]) * 0.25;
      a[off + (H - 1) * W + x] = (tmp[H - 2] + 3 * tmp[H - 1]) * 0.25;
    }
  }
}
