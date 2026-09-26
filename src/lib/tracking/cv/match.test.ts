import { describe, expect, it } from "vitest";
import { HammingMatcher, MatchList, hamming, minDistanceOutside, popcount32 } from "./match";
import { Rng } from "./rng";

function naivePop(v: number): number {
  let c = 0;
  v >>>= 0;
  while (v) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

function randomDescs(n: number, rng: Rng): Int32Array {
  const d = new Int32Array(n * 8);
  for (let i = 0; i < d.length; i++) d[i] = rng.nextU32() | 0;
  return d;
}

/** 무작위 k비트 뒤집기 */
function perturb(src: Int32Array, i: number, bits: number, rng: Rng, dst: Int32Array, j: number): void {
  for (let w = 0; w < 8; w++) dst[j * 8 + w] = src[i * 8 + w];
  const used = new Set<number>();
  while (used.size < bits) used.add(rng.int(256));
  for (const b of used) dst[j * 8 + (b >> 5)] ^= 1 << (b & 31);
}

describe("hamming matcher", () => {
  it("popcount32 agrees with the naive count", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const v = rng.nextU32();
      expect(popcount32(v)).toBe(naivePop(v));
    }
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(-1)).toBe(32);
  });

  it("finds perturbed copies (mutual + ratio) and reports distances", () => {
    const rng = new Rng(8);
    const q = randomDescs(100, rng);
    const t = new Int32Array(150 * 8);
    // 앞 100개는 q의 섞인 순서 사본(10비트 잡음), 뒤 50개는 무작위
    const perm = Array.from({ length: 100 }, (_, i) => i).sort(() => rng.next() - 0.5);
    perm.forEach((qi, j) => perturb(q, qi, 10, rng, t, j));
    t.set(randomDescs(50, rng), 100 * 8);
    const out = new MatchList();
    const n = new HammingMatcher().match(q, null, 100, t, 150, { maxDistance: 64, ratio: 0.8, mutual: true }, out);
    expect(n).toBe(100);
    for (let k = 0; k < n; k++) {
      expect(perm[out.t[k]]).toBe(out.q[k]);
      expect(out.dist[k]).toBe(10);
      expect(hamming(q, out.q[k], t, out.t[k])).toBe(10);
    }
  });

  it("ratio test rejects ambiguous (duplicated) candidates", () => {
    const rng = new Rng(9);
    const q = randomDescs(1, rng);
    const t = new Int32Array(3 * 8);
    perturb(q, 0, 8, rng, t, 0);
    perturb(q, 0, 9, rng, t, 1); // 거의 같은 복제본 → 모호
    t.set(randomDescs(1, rng), 16);
    const out = new MatchList();
    expect(new HammingMatcher().match(q, null, 1, t, 3, { maxDistance: 64, ratio: 0.8, mutual: false }, out)).toBe(0);
    // 비율을 풀면 통과
    expect(new HammingMatcher().match(q, null, 1, t, 3, { maxDistance: 64, ratio: 1.01, mutual: false }, out)).toBe(1);
  });

  it("mutual check drops many-to-one matches; qIdx subsets queries", () => {
    const rng = new Rng(10);
    const base = randomDescs(1, rng);
    const q = new Int32Array(2 * 8);
    perturb(base, 0, 5, rng, q, 0);
    perturb(base, 0, 20, rng, q, 1); // 둘 다 같은 트레인을 가리키지만 0번이 더 가깝다
    const t = new Int32Array(8);
    t.set(base);
    const out = new MatchList();
    const m = new HammingMatcher();
    expect(m.match(q, null, 2, t, 1, { maxDistance: 64, ratio: 0.8, mutual: true }, out)).toBe(1);
    expect(out.q[0]).toBe(0);
    // 부분집합 [1]만 쿼리하면 1번이 채택되고 원래 인덱스로 보고된다
    expect(m.match(q, new Int32Array([1]), 1, t, 1, { maxDistance: 64, ratio: 0.8, mutual: true }, out)).toBe(1);
    expect(out.q[0]).toBe(1);
    // 거리 한도
    expect(m.match(q, new Int32Array([1]), 1, t, 1, { maxDistance: 10, ratio: 0.8, mutual: true }, out)).toBe(0);
  });

  it("minDistanceOutside ignores spatial neighbours", () => {
    const rng = new Rng(11);
    const q = randomDescs(1, rng);
    const t = new Int32Array(2 * 8);
    t.set(q, 0); // 같은 위치의 자기 자신
    perturb(q, 0, 12, rng, t, 1); // 멀리 있는 쌍둥이
    const out = new Uint16Array(1);
    const f32 = (a: number[]) => new Float32Array(a);
    minDistanceOutside(q, f32([10]), f32([10]), f32([6]), 1, t, f32([10, 100]), f32([10, 10]), 2, out);
    expect(out[0]).toBe(12);
    minDistanceOutside(q, f32([10]), f32([10]), f32([200]), 1, t, f32([10, 100]), f32([10, 10]), 2, out);
    expect(out[0]).toBe(0xffff);
  });
});
