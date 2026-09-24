// 지표 (README "품질 목표" 정의 그대로):
//   표시(displayed)   = state ∈ {tracking, weak} 이고 H가 있음
//   오차(err)         = 표시 중일 때 H·pinRef 와 정답 핀 사이 거리 (작업 해상도 px)
//   틀린 표시(wrong)  = 표시 중인데 (핀이 화면 밖 — 8px 여유 — 이거나 오차 > 8px)   ← 분모: 전체 처리 프레임
//   추적률(tracked)   = 핀이 보이는(화면 안·안 가려진) 프레임 중 "표시 && 오차 ≤ 8px" 비율
//   손에 가려진 핀을 제자리(오차 ≤ 8px)에 계속 그리는 것은 틀린 표시가 아니다 (손 위에 핀이 보이는 게 맞다).
import type { Point, TrackState } from "../../src/lib/tracking/types";
import type { Category, Side } from "./scenarios";

export const ERR_PX = 8;
/** 복귀 판정: 핀이 이만큼(초) 이상 안 보였다가 다시 보이면 "복귀" 이벤트 */
export const REENTRY_MIN_ABSENT_S = 0.3;
/** 복귀 판정: ROI가 이만큼 이상 화면에 보여야 복귀로 친다 */
export const REENTRY_MIN_ROI_VISIBLE = 0.5;
export const ACQUIRE_WITHIN = 5;
export const REACQUIRE_WITHIN = 10;

export interface FrameRecord {
  k: number;
  tMs: number;
  // 정답
  inFrame: boolean;
  occluded: boolean;
  visible: boolean;
  offscreenBy: number;
  roiVisible: number;
  gtPin: Point | null;
  // 추적기
  state: TrackState;
  displayed: boolean;
  estPin: Point | null;
  /** 표시 중일 때만. 추정 핀이 카메라 뒤로 가면 Infinity */
  err: number | null;
  correct: boolean;
  wrong: boolean;
  redetected: boolean;
  ms: number;
  inliers: number;
  tracked: number;
  confidence: number;
}

export interface Stats {
  n: number;
  median: number | null;
  p95: number | null;
  mean: number | null;
  max: number | null;
}

/** 분위수 통계. NaN은 무시, Infinity(카메라 뒤 등)는 상위 분위수로 반영 */
export function stats(input: number[]): Stats {
  const values = input.filter((x) => !Number.isNaN(x));
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { n: values.length, median: null, p95: null, mean: null, max: values.length ? Infinity : null };
  const q = (p: number) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  const inf = values.length - n; // 무한대(카메라 뒤) 오차는 상위 분위수에 반영
  const all = [...v, ...new Array(inf).fill(Infinity)];
  const qa = (p: number) => all[Math.min(all.length - 1, Math.round((all.length - 1) * p))];
  return {
    n: values.length,
    median: inf ? qa(0.5) : q(0.5),
    p95: inf ? qa(0.95) : q(0.95),
    mean: v.reduce((a, b) => a + b, 0) / n,
    max: inf ? Infinity : v[n - 1],
  };
}

export interface Reentry {
  /** 복귀 프레임 순번 */
  k: number;
  /** 복귀 후 처음 올바르게 표시될 때까지 프레임 수 (null = 다시 사라지기 전까지 못 찾음) */
  latency: number | null;
}

export interface Check {
  name: string;
  value: number | null;
  op: ">=" | "<=";
  target: number;
  /** null = 해당 없음(측정값 없음) */
  pass: boolean | null;
}

export interface ScenarioMetrics {
  id: string;
  category: Category;
  side: Side;
  title: string;
  frames: number;
  visibleFrames: number;
  trackable: boolean;
  refFeatures: number;
  /** 보이는 프레임 중 올바르게 표시 (0~1) */
  tracked: number | null;
  /** 보이는 프레임 중 표시(정확도 무관) */
  shown: number | null;
  err: Stats;
  /** 틀린 표시 비율 (0~1, 전체 프레임 대비) */
  wrong: number;
  wrongFrames: number;
  /** 고객 쪽: 처음 올바르게 표시된 처리 프레임 순번 (0부터). null = 못 찾음 */
  acquireFrames: number | null | undefined;
  acquireMs: number | null | undefined;
  reentries: Reentry[];
  msTrack: Stats;
  msRedetect: Stats;
  msAll: Stats;
  drift?: { firstMedian: number | null; lastMedian: number | null };
  checks: Check[];
}

/** README 목표 (범주별). stress·drift는 README 표 밖이라 벤치 자체 목표 */
export const TARGETS: Record<
  Category,
  { tracked?: number; medianErr?: number; wrong: number; acquire5?: number; reacquire10?: number; readme: boolean }
> = {
  jitter: { tracked: 0.95, medianErr: 2, wrong: 0.005, readme: true },
  motion: { tracked: 0.85, medianErr: 3, wrong: 0.01, readme: true },
  repetitive: { wrong: 0.01, readme: true },
  lowtex: { wrong: 0.01, readme: true },
  reentry: { reacquire10: 0.8, wrong: 0.01, readme: true },
  acquire: { acquire5: 0.9, wrong: 0.01, readme: true },
  stress: { wrong: 0.01, readme: false },
  drift: { tracked: 0.85, medianErr: 3, wrong: 0.01, readme: false },
};

export const PERF_TARGETS = { trackMedianMs: 5, redetectMedianMs: 15 };

export function classifyFrame(
  gt: { inFrame: boolean; offscreenBy: number; pin: Point | null },
  displayed: boolean,
  estPin: Point | null,
): { err: number | null; wrong: boolean; correct: boolean } {
  if (!displayed) return { err: null, wrong: false, correct: false };
  let err: number | null = null;
  if (gt.pin) err = estPin ? Math.hypot(estPin.x - gt.pin.x, estPin.y - gt.pin.y) : Infinity;
  const offscreen = !gt.pin || gt.offscreenBy > ERR_PX;
  const wrong = offscreen || err === null || err > ERR_PX;
  return { err, wrong, correct: !wrong };
}

/** 복귀 이벤트: REENTRY_MIN_ABSENT_S 이상 안 보이다가 (보인 적이 있은 뒤) 다시 보이고 ROI 절반 이상이 화면에 들어온 프레임 */
export function findReentries(recs: FrameRecord[]): Reentry[] {
  const out: Reentry[] = [];
  let seenVisible = false;
  let absentSince: number | null = null;
  let armed = false;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r.visible) {
      if (absentSince === null) absentSince = r.tMs;
      if (seenVisible && r.tMs - absentSince >= REENTRY_MIN_ABSENT_S * 1000) armed = true;
      continue;
    }
    if (armed && r.roiVisible >= REENTRY_MIN_ROI_VISIBLE) {
      // 다음에 다시 사라지기 전까지 첫 올바른 표시
      let lat: number | null = null;
      for (let j = i; j < recs.length && recs[j].visible; j++) {
        if (recs[j].correct) {
          lat = j - i;
          break;
        }
      }
      out.push({ k: r.k, latency: lat });
      armed = false;
    }
    if (!armed) absentSince = null;
    seenVisible = true;
  }
  return out;
}

export function scenarioMetrics(
  meta: { id: string; category: Category; side: Side; title: string; trackable: boolean; refFeatures: number },
  recs: FrameRecord[],
): ScenarioMetrics {
  const visible = recs.filter((r) => r.visible);
  const errs = recs.filter((r) => r.displayed && r.inFrame && r.err !== null).map((r) => r.err as number);
  const wrongFrames = recs.filter((r) => r.wrong).length;
  let acquireFrames: number | null | undefined;
  let acquireMs: number | null | undefined;
  if (meta.side === "customer") {
    const i = recs.findIndex((r) => r.correct && r.visible);
    acquireFrames = i >= 0 ? i : null;
    acquireMs = i >= 0 ? recs[i].tMs - recs[0].tMs : null;
  }
  const m: ScenarioMetrics = {
    ...meta,
    frames: recs.length,
    visibleFrames: visible.length,
    tracked: visible.length ? visible.filter((r) => r.correct).length / visible.length : null,
    shown: visible.length ? visible.filter((r) => r.displayed).length / visible.length : null,
    err: stats(errs),
    wrong: recs.length ? wrongFrames / recs.length : 0,
    wrongFrames,
    acquireFrames,
    acquireMs,
    reentries: findReentries(recs),
    msTrack: stats(recs.filter((r) => !r.redetected).map((r) => r.ms)),
    msRedetect: stats(recs.filter((r) => r.redetected).map((r) => r.ms)),
    msAll: stats(recs.map((r) => r.ms)),
    checks: [],
  };
  if (meta.category === "drift" && recs.length) {
    const t0 = recs[0].tMs;
    const t1 = recs[recs.length - 1].tMs;
    const e = (lo: number, hi: number) =>
      stats(recs.filter((r) => r.tMs >= lo && r.tMs <= hi && r.displayed && r.inFrame && r.err !== null).map((r) => r.err!)).median;
    m.drift = { firstMedian: e(t0, t0 + 10000), lastMedian: e(t1 - 10000, t1) };
  }
  m.checks = categoryChecks(meta.category, {
    tracked: m.tracked,
    medianErr: m.err.median,
    wrong: m.wrong,
    acquire: acquireFrames === undefined ? [] : [acquireFrames],
    reentries: m.reentries,
  });
  return m;
}

function check(name: string, value: number | null, op: ">=" | "<=", target: number): Check {
  return { name, value, op, target, pass: value === null ? null : op === ">=" ? value >= target : value <= target };
}

export function categoryChecks(
  cat: Category,
  v: { tracked: number | null; medianErr: number | null; wrong: number; acquire: (number | null)[]; reentries: Reentry[] },
): Check[] {
  const T = TARGETS[cat];
  const out: Check[] = [];
  if (T.tracked !== undefined) out.push(check("추적률", v.tracked, ">=", T.tracked));
  if (T.medianErr !== undefined) out.push(check("오차 중앙값", v.medianErr, "<=", T.medianErr));
  if (T.acquire5 !== undefined) {
    const ok = v.acquire.filter((a) => a !== null && a < ACQUIRE_WITHIN).length;
    out.push(check(`${ACQUIRE_WITHIN}프레임 내 탐색`, v.acquire.length ? ok / v.acquire.length : null, ">=", T.acquire5));
  }
  if (T.reacquire10 !== undefined) {
    const ok = v.reentries.filter((r) => r.latency !== null && r.latency < REACQUIRE_WITHIN).length;
    out.push(check(`${REACQUIRE_WITHIN}프레임 내 재검출`, v.reentries.length ? ok / v.reentries.length : null, ">=", T.reacquire10));
  }
  out.push(check("틀린 표시", v.wrong, "<=", T.wrong));
  return out;
}

export interface CategoryMetrics {
  category: Category;
  scenarios: string[];
  frames: number;
  visibleFrames: number;
  tracked: number | null;
  err: Stats;
  wrong: number;
  acquireRate: number | null;
  reacquireRate: number | null;
  reentries: number;
  checks: Check[];
  pass: boolean;
}

/** 범주별 합산 (프레임을 모아서) — 품질 게이트의 공식 판정 */
export function aggregate(
  results: { metrics: ScenarioMetrics; records: FrameRecord[] }[],
): { categories: CategoryMetrics[]; perf: { msTrack: Stats; msRedetect: Stats; checks: Check[] }; pass: boolean } {
  const cats = new Map<Category, { metrics: ScenarioMetrics; records: FrameRecord[] }[]>();
  for (const r of results) {
    const l = cats.get(r.metrics.category) ?? [];
    l.push(r);
    cats.set(r.metrics.category, l);
  }
  const order: Category[] = ["jitter", "motion", "repetitive", "lowtex", "reentry", "acquire", "stress", "drift"];
  const categories: CategoryMetrics[] = [];
  for (const cat of order) {
    const l = cats.get(cat);
    if (!l) continue;
    const recs = l.flatMap((x) => x.records);
    const visible = recs.filter((r) => r.visible);
    const tracked = visible.length ? visible.filter((r) => r.correct).length / visible.length : null;
    const errs = stats(recs.filter((r) => r.displayed && r.inFrame && r.err !== null).map((r) => r.err!));
    const wrong = recs.length ? recs.filter((r) => r.wrong).length / recs.length : 0;
    const acquire = l.filter((x) => x.metrics.acquireFrames !== undefined).map((x) => x.metrics.acquireFrames as number | null);
    const reentries = l.flatMap((x) => x.metrics.reentries);
    const checks = categoryChecks(cat, { tracked, medianErr: errs.median, wrong, acquire, reentries });
    categories.push({
      category: cat,
      scenarios: l.map((x) => x.metrics.id),
      frames: recs.length,
      visibleFrames: visible.length,
      tracked,
      err: errs,
      wrong,
      acquireRate: acquire.length ? acquire.filter((a) => a !== null && a < ACQUIRE_WITHIN).length / acquire.length : null,
      reacquireRate: reentries.length
        ? reentries.filter((r) => r.latency !== null && r.latency < REACQUIRE_WITHIN).length / reentries.length
        : null,
      reentries: reentries.length,
      checks,
      pass: checks.every((c) => c.pass !== false),
    });
  }
  const all = results.flatMap((x) => x.records);
  const msTrack = stats(all.filter((r) => !r.redetected).map((r) => r.ms));
  const msRedetect = stats(all.filter((r) => r.redetected).map((r) => r.ms));
  const perfChecks = [
    check("추적 프레임 ms 중앙값", msTrack.median, "<=", PERF_TARGETS.trackMedianMs),
    check("재검출 프레임 ms 중앙값", msRedetect.median, "<=", PERF_TARGETS.redetectMedianMs),
  ];
  return {
    categories,
    perf: { msTrack, msRedetect, checks: perfChecks },
    pass: categories.every((c) => c.pass) && perfChecks.every((c) => c.pass !== false),
  };
}

// ───────────────────────── 표 출력 ─────────────────────────

const CAT_KO: Record<Category, string> = {
  jitter: "손떨림",
  motion: "이동·확대·기울임",
  repetitive: "반복 패턴",
  lowtex: "무늬 없음",
  reentry: "화면 밖→복귀",
  acquire: "고객 최초 탐색",
  stress: "스트레스(표 밖)",
  drift: "드리프트(60초)",
};

export function categoryName(c: Category): string {
  return CAT_KO[c];
}

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? "-" : Number.isFinite(v) ? v.toFixed(d) : "inf";

/** 문자열 표시 폭 (한글 2칸) */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힣一-鿿]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s: string, w: number, right = false): string {
  const n = Math.max(0, w - dispWidth(s));
  return right ? " ".repeat(n) + s : s + " ".repeat(n);
}

export function formatTable(rows: string[][], rightCols: number[] = []): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => dispWidth(r[i] ?? ""))));
  return rows
    .map((r, ri) => {
      const line = r.map((c, i) => pad(c, widths[i], rightCols.includes(i) && ri > 0)).join("  ");
      return ri === 0 ? `${line}\n${widths.map((w) => "─".repeat(w)).join("  ")}` : line;
    })
    .join("\n");
}

function checkMark(checks: Check[]): string {
  if (checks.some((c) => c.pass === false)) return "FAIL";
  if (checks.every((c) => c.pass === null)) return "-";
  return "ok";
}

export function scenarioTable(ms: ScenarioMetrics[]): string {
  const rows: string[][] = [
    ["시나리오", "범주", "쪽", "프레임", "보임", "추적률", "오차중앙", "p95", "틀림", "탐색", "재검출≤10", "ms추적 중앙/p95", "ms재검출 중앙/p95(n)", "판정"],
  ];
  for (const m of ms) {
    const re = m.reentries.length
      ? `${m.reentries.filter((r) => r.latency !== null && r.latency < REACQUIRE_WITHIN).length}/${m.reentries.length}`
      : "-";
    const acq = m.acquireFrames === undefined ? "-" : m.acquireFrames === null ? "못찾음" : `${m.acquireFrames}f`;
    rows.push([
      m.id + (m.trackable ? "" : " (trackable=false)"),
      m.category,
      m.side === "engineer" ? "엔" : "고",
      String(m.frames),
      String(m.visibleFrames),
      pct(m.tracked),
      num(m.err.median, 2),
      num(m.err.p95, 1),
      pct(m.wrong, 2),
      acq,
      re,
      `${num(m.msTrack.median, 2)}/${num(m.msTrack.p95, 1)}`,
      m.msRedetect.n ? `${num(m.msRedetect.median, 1)}/${num(m.msRedetect.p95, 1)}(${m.msRedetect.n})` : "-",
      checkMark(m.checks),
    ]);
  }
  return formatTable(rows, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
}

export function categoryTable(cs: CategoryMetrics[]): string {
  const rows: string[][] = [["범주", "시나리오", "프레임", "추적률", "오차중앙", "p95", "틀림", "탐색≤5", "재검출≤10", "목표", "판정"]];
  for (const c of cs) {
    const T = TARGETS[c.category];
    const goal = [
      T.tracked !== undefined ? `추적≥${T.tracked * 100}%` : "",
      T.medianErr !== undefined ? `중앙≤${T.medianErr}px` : "",
      T.acquire5 !== undefined ? `탐색≥${T.acquire5 * 100}%` : "",
      T.reacquire10 !== undefined ? `재검출≥${T.reacquire10 * 100}%` : "",
      `틀림≤${(T.wrong * 100).toFixed(1)}%`,
    ]
      .filter(Boolean)
      .join(" ");
    rows.push([
      `${categoryName(c.category)}${TARGETS[c.category].readme ? "" : "*"}`,
      String(c.scenarios.length),
      String(c.frames),
      pct(c.tracked),
      num(c.err.median, 2),
      num(c.err.p95, 1),
      pct(c.wrong, 2),
      c.acquireRate === null ? "-" : pct(c.acquireRate, 0),
      c.reacquireRate === null ? "-" : `${pct(c.reacquireRate, 0)} (${c.reentries})`,
      goal,
      c.pass ? "PASS" : "FAIL",
    ]);
  }
  return formatTable(rows, [1, 2, 3, 4, 5, 6, 7, 8]);
}
