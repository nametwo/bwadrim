// 결정적 난수·신호 헬퍼. 벤치마크의 모든 무작위성은 여기서 시드로 만든다.

/** FNV-1a 32bit — 문자열(시나리오 id 등) → 시드 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — 빠르고 품질 충분한 32bit PRNG */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** 표준정규 (Box-Muller) */
  normal(): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
}

/**
 * 표준정규 난수 표. 센서 노이즈처럼 픽셀마다 난수가 필요한 곳에서
 * Box-Muller를 픽셀마다 돌리지 않고 (행마다 임의 오프셋으로) 표를 읽는다.
 * 크기는 2의 거듭제곱.
 */
export function gaussianTable(log2Size: number, seed: number): Float32Array {
  const n = 1 << log2Size;
  const t = new Float32Array(n);
  const r = new Rng(seed);
  for (let i = 0; i < n; i++) t[i] = r.normal();
  return t;
}

/**
 * 부드러운 1차원 난수 신호: 무작위 주파수·위상 사인파의 합, RMS = 1.
 * 손떨림(느린 흔들림 + 생리적 떨림)을 만들 때 쓴다.
 */
export class SmoothNoise {
  private readonly f: Float64Array;
  private readonly p: Float64Array;
  private readonly a: Float64Array;
  constructor(seed: number, minHz: number, maxHz: number, components = 6) {
    const r = new Rng(seed);
    this.f = new Float64Array(components);
    this.p = new Float64Array(components);
    this.a = new Float64Array(components);
    let sumSq = 0;
    for (let i = 0; i < components; i++) {
      // 로그 균등 주파수, 저주파일수록 약간 크게 (1/f 경향)
      const f = minHz * Math.pow(maxHz / minHz, (i + r.next()) / components);
      this.f[i] = f;
      this.p[i] = r.next() * Math.PI * 2;
      const a = (0.6 + 0.8 * r.next()) / Math.sqrt(f / minHz);
      this.a[i] = a;
      sumSq += (a * a) / 2;
    }
    const norm = 1 / Math.sqrt(sumSq);
    for (let i = 0; i < components; i++) this.a[i] *= norm;
  }
  at(t: number): number {
    let s = 0;
    for (let i = 0; i < this.f.length; i++) {
      s += this.a[i] * Math.sin(2 * Math.PI * this.f[i] * t + this.p[i]);
    }
    return s;
  }
}

/** 0~1 사이 부드러운 보간 (C2 연속) */
export function smootherstep(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
