// 시드 고정 PRNG (mulberry32). RANSAC·BRIEF 패턴 생성·테스트용.
// 초월함수를 쓰지 않아 엔진(V8·JSC)이 달라도 같은 시드 → 같은 수열.

export class Rng {
  private s: number;

  constructor(seed = 1) {
    this.s = seed >>> 0;
  }

  reseed(seed: number): void {
    this.s = seed >>> 0;
  }

  /** 균등 uint32 */
  nextU32(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** [0, 1) */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** [0, n) 정수 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** [a, b) 실수 */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** 근사 표준정규 (Irwin–Hall 6개 합, 분산 1로 보정) */
  gauss(): number {
    let s = 0;
    for (let i = 0; i < 6; i++) s += this.next();
    return (s - 3) * Math.SQRT2;
  }
}
