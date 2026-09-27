import { DESC_WORDS } from "./orb";

// 해밍 거리 매칭 (256비트 = 32비트 단어 × 8, Int32Array). 전수 비교 + 비율 테스트 + 상호 확인.

/** 32비트 popcount (SWAR) */
export function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** 두 디스크립터(특징 인덱스 기준) 사이 해밍 거리 */
export function hamming(a: Int32Array, ai: number, b: Int32Array, bi: number): number {
  let d = 0;
  const ao = ai * DESC_WORDS;
  const bo = bi * DESC_WORDS;
  for (let w = 0; w < DESC_WORDS; w++) d += popcount32(a[ao + w] ^ b[bo + w]);
  return d;
}

export interface MatchParams {
  /** 허용 최대 거리 (256 중) */
  maxDistance: number;
  /** best < ratio × secondBest 여야 채택 (Lowe 비율 테스트) */
  ratio: number;
  /** 상호 최근접만 채택 */
  mutual: boolean;
}

export class MatchList {
  n = 0;
  /** 쿼리 특징 인덱스 (qIdx가 있으면 그 값) */
  q = new Int32Array(0);
  /** 트레인 특징 인덱스 */
  t = new Int32Array(0);
  dist = new Uint16Array(0);
  /** best / second (비율, 작을수록 확실) */
  ratio = new Float32Array(0);

  reserve(cap: number): void {
    if (cap <= this.q.length) return;
    const nc = Math.max(cap, this.q.length * 2, 64);
    const q = new Int32Array(nc);
    const t = new Int32Array(nc);
    const d = new Uint16Array(nc);
    const r = new Float32Array(nc);
    q.set(this.q.subarray(0, this.n));
    t.set(this.t.subarray(0, this.n));
    d.set(this.dist.subarray(0, this.n));
    r.set(this.ratio.subarray(0, this.n));
    this.q = q;
    this.t = t;
    this.dist = d;
    this.ratio = r;
  }
}

/** 버퍼를 재사용하는 전수 매처 */
export class HammingMatcher {
  private tBestD = new Uint16Array(0);
  private tBestQ = new Int32Array(0);
  private qBest = new Int32Array(0);
  private qD1 = new Uint16Array(0);
  private qD2 = new Uint16Array(0);

  /**
   * query(부분집합 qIdx) → train 매칭. 결과는 out에 덮어쓴다.
   * 결정적: 동률이면 인덱스가 작은 쪽.
   */
  match(
    qDesc: Int32Array,
    qIdx: Int32Array | null,
    nq: number,
    tDesc: Int32Array,
    nt: number,
    p: MatchParams,
    out: MatchList,
  ): number {
    out.n = 0;
    if (nq === 0 || nt === 0) return 0;
    if (this.tBestD.length < nt) {
      this.tBestD = new Uint16Array(nt * 2);
      this.tBestQ = new Int32Array(nt * 2);
    }
    if (this.qBest.length < nq) {
      this.qBest = new Int32Array(nq * 2);
      this.qD1 = new Uint16Array(nq * 2);
      this.qD2 = new Uint16Array(nq * 2);
    }
    const tBestD = this.tBestD;
    const tBestQ = this.tBestQ;
    tBestD.fill(0xffff, 0, nt);
    tBestQ.fill(-1, 0, nt);
    best2Kernel(qDesc, qIdx, nq, tDesc, nt, this.qBest, this.qD1, this.qD2, tBestD, tBestQ);

    out.reserve(nq);
    let n = 0;
    for (let qi = 0; qi < nq; qi++) {
      const bj = this.qBest[qi];
      if (bj < 0) continue;
      const d1 = this.qD1[qi];
      const d2 = this.qD2[qi];
      if (d1 > p.maxDistance) continue;
      if (d2 !== 0xffff && d1 >= p.ratio * d2) continue;
      if (p.mutual && tBestQ[bj] !== qi) continue;
      out.q[n] = qIdx ? qIdx[qi] : qi;
      out.t[n] = bj;
      out.dist[n] = d1;
      out.ratio[n] = d2 === 0xffff ? 0 : d1 / Math.max(1, d2);
      n++;
    }
    out.n = n;
    return n;
  }
}

/**
 * 전수 비교 커널: 쿼리마다 최근접·차근접 거리, 트레인마다 최근접 쿼리.
 * 객체 속성 접근 없이 형식 배열만 다룬다 (V8 최적화가 안정적이도록 분리).
 */
function best2Kernel(
  qDesc: Int32Array,
  qIdx: Int32Array | null,
  nq: number,
  td: Int32Array,
  nt: number,
  qBest: Int32Array,
  qD1: Uint16Array,
  qD2: Uint16Array,
  tBestD: Uint16Array,
  tBestQ: Int32Array,
): void {
  for (let qi = 0; qi < nq; qi++) {
    const qo = (qIdx ? qIdx[qi] : qi) * 8;
    const a0 = qDesc[qo];
    const a1 = qDesc[qo + 1];
    const a2 = qDesc[qo + 2];
    const a3 = qDesc[qo + 3];
    const a4 = qDesc[qo + 4];
    const a5 = qDesc[qo + 5];
    const a6 = qDesc[qo + 6];
    const a7 = qDesc[qo + 7];
    let b1 = 0xffff;
    let b2 = 0xffff;
    let bj = -1;
    for (let j = 0, o = 0; j < nt; j++, o += 8) {
      // 8단어 popcount: 바이트 단위 부분합을 모았다가 한 번에 합산 (바이트당 ≤ 64)
      let x = a0 ^ td[o];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      let acc = (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a1 ^ td[o + 1];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a2 ^ td[o + 2];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a3 ^ td[o + 3];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a4 ^ td[o + 4];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a5 ^ td[o + 5];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a6 ^ td[o + 6];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a7 ^ td[o + 7];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      const d = Math.imul(acc, 0x01010101) >>> 24;
      if (d < b1) {
        b2 = b1;
        b1 = d;
        bj = j;
      } else if (d < b2) {
        b2 = d;
      }
      if (d < tBestD[j]) {
        tBestD[j] = d;
        tBestQ[j] = qi;
      }
    }
    qBest[qi] = bj;
    qD1[qi] = b1;
    qD2[qi] = b2;
  }
}

/**
 * 각 쿼리 특징에 대해, 자기 위치 반경 exclR[q] 밖의 트레인 특징 중 최소 해밍 거리.
 * 기준 프레임 안 "쌍둥이"(반복 패턴의 복제본) 찾기용. out[q] = 최소 거리 (없으면 0xffff),
 * outIdx가 있으면 그 트레인 인덱스 (없으면 −1).
 * bound: 이 거리 이상은 관심 없음 — 앞 3단어(96비트) 부분합이 이미 min(현재 최소, bound) 이상이면
 * 나머지를 건너뛴다 (무관한 쌍 대부분이 여기서 끝난다). 최소가 bound 이상이면 0xffff.
 */
export function minDistanceOutside(
  qDesc: Int32Array,
  qx: Float32Array,
  qy: Float32Array,
  exclR: Float32Array,
  nq: number,
  tDesc: Int32Array,
  tx: Float32Array,
  ty: Float32Array,
  nt: number,
  out: Uint16Array,
  outIdx: Int32Array | null = null,
  bound = 0xffff,
): void {
  for (let qi = 0; qi < nq; qi++) {
    const qo = qi * 8;
    const a0 = qDesc[qo];
    const a1 = qDesc[qo + 1];
    const a2 = qDesc[qo + 2];
    const a3 = qDesc[qo + 3];
    const a4 = qDesc[qo + 4];
    const a5 = qDesc[qo + 5];
    const a6 = qDesc[qo + 6];
    const a7 = qDesc[qo + 7];
    const px = qx[qi];
    const py = qy[qi];
    const r2 = exclR[qi] * exclR[qi];
    let best = 0xffff;
    let bi = -1;
    let lim = bound;
    for (let j = 0, o = 0; j < nt; j++, o += 8) {
      // 디스크립터 앞부분으로 먼저 거른다 (대부분 여기서 끝) → 위치 검사는 후보만
      let x = a0 ^ tDesc[o];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      let acc = (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a1 ^ tDesc[o + 1];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a2 ^ tDesc[o + 2];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      if (Math.imul(acc, 0x01010101) >>> 24 >= lim) continue;
      const dx = tx[j] - px;
      const dy = ty[j] - py;
      if (dx * dx + dy * dy < r2) continue;
      x = a3 ^ tDesc[o + 3];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a4 ^ tDesc[o + 4];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a5 ^ tDesc[o + 5];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a6 ^ tDesc[o + 6];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      x = a7 ^ tDesc[o + 7];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      acc += (x + (x >>> 4)) & 0x0f0f0f0f;
      const d = Math.imul(acc, 0x01010101) >>> 24;
      if (d < best && d < lim) {
        best = d;
        bi = j;
        lim = d;
      }
    }
    out[qi] = best;
    if (outIdx) outIdx[qi] = bi;
  }
}
