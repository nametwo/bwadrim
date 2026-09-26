// npm run bench:tracking — 합성 시퀀스로 평면 추적기 품질을 정답과 비교한다.
// 사용법은 scripts/tracking-bench/README.md 또는 --help.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TrackerConfig } from "../../src/lib/tracking/types";
import { type ScenarioRun, runSequence } from "./harness";
import {
  type CategoryMetrics,
  type ScenarioMetrics,
  PERF_TARGETS,
  aggregate,
  categoryName,
  categoryTable,
  formatTable,
  hintTable,
  scenarioTable,
  suiteLabel,
} from "./metrics";
import { scenarioById, selectScenarios } from "./catalog";
import { ensureCodecCaptures } from "./codec";
import { cachedRef, readFrameCache } from "./framecache";
import { defaultJobs, prerender } from "./prerender";
import { type Scenario, type Suite, suiteOf } from "./scenarios";
import { type Sequence, buildSequence, pipelineOptions } from "./sequence";
import { type TrackerName, getTracker, trackerExists } from "./trackers";
import { BENCH_DIR, ensureTextures, texturesFor } from "./textures";
import { Y4M_DEFAULTS, exportY4m } from "./y4m";

const OUT_DIR = path.join(BENCH_DIR, "out");

const HELP = `합성 추적 벤치마크 (scripts/tracking-bench)

  npm run bench:tracking -- [옵션]

옵션
  --tracker=planar|oracle|null|shifted   추적기 (기본 planar). oracle=정답, null=항상 못 찾음, shifted=정답+10px
  --scenario=<부분문자열[,…]|범주|묶음>  시나리오 거르기 (예: --scenario=acquire, --scenario=router,reentry, --scenario=realism)
  --suite=base|realism|holdout|all[,…]   묶음 (기본 base,realism). realism = base의 실감 변형(렌즈·입체·ISP·실제 코덱)
  --holdout                              홀드아웃만 (과적합 확인용 — 추적기 튜닝에 쓰지 말 것). --suite=holdout과 같다
  --no-codec                             실제 코덱(WebRTC) 시나리오 빼기 (Chromium 캡처 없이)
  --json[=<파일>]                        결과 JSON (기본 out/latest.json, 추적기가 planar가 아니면 out/latest-<추적기>.json)
  --compare=<파일>                       이전 JSON과 비교해 차이 출력
  --frames-dir=<폴더>                    점검용 PNG (정답 핀=초록 십자, 추적 핀=빨강 원, ROI 사각형, 틀린 표시는 보라 테두리)
  --every=<N>                            --frames-dir 덤프 간격 (기본 10, 틀린 표시 프레임은 항상)
  --y4m[=<id,…>]                         브라우저 E2E용 가짜 카메라 y4m(640x480·480x640) + 정답 JSON → .cache/y4m/
  --jobs=<N>                             병렬 렌더 작업자 수 (기본 CPU-1)
  --render                               기준선 추적기(oracle 등)도 프레임을 렌더 (기본은 생략)
  --no-cache                             프레임 캐시 쓰지 않음 (매번 렌더)
  --render-only                          렌더(캐시 채우기)만
  --exact-jpeg                           프레임마다 jpeg-js로 실제 압축 (느림; 기본은 같은 손실의 DCT 시뮬레이터)
  --exact-blur                           모션 블러를 서브프레임 자세 평균으로 (느림; 기본은 운동 벡터 선 적분)
  --config=<JSON>                        PlanarTracker 설정 덮어쓰기 (예: --config='{"minInliers":12}')
  --strict                               목표 미달이면 종료 코드 1
  --list                                 시나리오 목록
  --quiet                                진행 로그 생략
`;

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function listScenarios(list: Scenario[]): void {
  const rows = [["id", "묶음", "범주", "쪽", "길이", "대상", "핀", "스트림", "설명"]];
  for (const s of list) {
    rows.push([
      s.id,
      suiteOf(s),
      s.category,
      s.side === "engineer" ? "엔지니어" : "고객",
      `${s.duration}s`,
      s.target,
      s.pin,
      (s.stream ?? [480, 640]).join("x"),
      s.title,
    ]);
  }
  console.log(formatTable(rows));
  console.log(`\n${list.length}개 시나리오`);
}

const REASON_CODE: Record<string, string> = { offscreen: "O", unverified: "U", untrackable: "X", invalid_frame: "I" };

/** realism 변형과 원본을 나란히 (둘 다 이번 실행에 있을 때) */
function variantTable(runs: ScenarioRun[]): string {
  const byId = new Map(runs.map((r) => [r.scenario.id, r]));
  const rows = [["변형", "원본 추적률", "→ 실감", "원본 오차중앙", "→ 실감", "원본 틀림", "→ 실감", "탐색/재검출 원본→실감"]];
  const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
  const px = (v: number | null) => (v === null ? "-" : Number.isFinite(v) ? v.toFixed(2) : "inf");
  const acq = (r: ScenarioRun) =>
    r.metrics.acquireFrames !== undefined
      ? r.metrics.acquireFrames === null
        ? "못찾음"
        : `${r.metrics.acquireFrames}f`
      : r.metrics.reentries.length
        ? `${r.metrics.reentries.filter((e) => e.latency !== null && e.latency < 10).length}/${r.metrics.reentries.length}`
        : "-";
  for (const r of runs) {
    const b = r.scenario.variantOf ? byId.get(r.scenario.variantOf) : undefined;
    if (!b) continue;
    rows.push([
      r.scenario.id,
      pct(b.metrics.tracked),
      pct(r.metrics.tracked),
      px(b.metrics.err.median),
      px(r.metrics.err.median),
      pct(b.metrics.wrong),
      pct(r.metrics.wrong),
      `${acq(b)} → ${acq(r)}`,
    ]);
  }
  return rows.length > 1 ? formatTable(rows, [1, 2, 3, 4, 5, 6]) : "";
}

function compactTrace(run: ScenarioRun) {
  const code: Record<string, string> = { tracking: "T", weak: "W", lost: "L", searching: "S" };
  return {
    t: run.records.map((r) => Math.round(r.tMs)),
    state: run.records.map((r) => code[r.state]).join(""),
    err: run.records.map((r) => (r.err === null ? null : Number.isFinite(r.err) ? Math.round(r.err * 100) / 100 : -1)),
    ms: run.records.map((r) => (Number.isFinite(r.ms) ? Math.round(r.ms * 100) / 100 : null)),
    redetected: run.records.map((r) => (r.redetected ? "1" : "0")).join(""),
    visible: run.records.map((r) => (r.visible ? "1" : r.inFrame ? "o" : "0")).join(""),
    wrong: run.records.map((r) => (r.wrong ? "1" : "0")).join(""),
    inliers: run.records.map((r) => r.inliers),
    /** TrackResult.reason: O=offscreen U=unverified X=untrackable I=invalid_frame, -=없음 */
    reason: run.records.map((r) => (r.reason ? REASON_CODE[r.reason] : "-")).join(""),
    /** 화면 밖 안내 방향 오차(도) — 핀이 화면 밖이고 hint가 있을 때만, 나머지 null. hint만 있고 핀이 화면 안이면 -1 */
    hintErr: run.records.map((r) => (r.hintErrDeg !== null ? Math.round(r.hintErrDeg * 10) / 10 : r.hint ? -1 : null)),
  };
}

interface BenchJson {
  tracker: string;
  filter: string | null;
  pass: boolean;
  env: { node: string; cpu: string; platform: string };
  categories: CategoryMetrics[];
  perf: ReturnType<typeof aggregate>["perf"];
  suites: Suite[];
  scenarios: (ScenarioMetrics & {
    variantOf: string | null;
    codec: unknown;
    refMs: number;
    roi: unknown;
    stageMs: Record<string, number>;
    trace: ReturnType<typeof compactTrace>;
  })[];
}

function printCompare(prevFile: string, cur: BenchJson): void {
  let prev: BenchJson;
  try {
    prev = JSON.parse(fs.readFileSync(prevFile, "utf8")) as BenchJson;
  } catch (e) {
    console.log(`비교 파일을 읽지 못함: ${prevFile} (${(e as Error).message})`);
    return;
  }
  const d = (a: number | null | undefined, b: number | null | undefined, scale = 100, digits = 1) =>
    a === null || a === undefined || b === null || b === undefined ? "-" : `${b - a >= 0 ? "+" : ""}${((b - a) * scale).toFixed(digits)}`;
  const rows = [["범주/시나리오", "추적률 Δ%p", "오차중앙 Δpx", "틀림 Δ%p"]];
  for (const c of cur.categories) {
    const p = prev.categories.find((x) => x.category === c.category && (x.suite ?? "base") === c.suite);
    if (!p) continue;
    rows.push([`${suiteLabel(c.suite)}${categoryName(c.category)}`, d(p.tracked, c.tracked), d(p.err.median, c.err.median, 1, 2), d(p.wrong, c.wrong, 100, 2)]);
  }
  for (const s of cur.scenarios) {
    const p = prev.scenarios.find((x) => x.id === s.id);
    if (!p) continue;
    const changed =
      Math.abs((s.tracked ?? 0) - (p.tracked ?? 0)) > 0.02 ||
      Math.abs(s.wrong - p.wrong) > 0.002 ||
      Math.abs((s.err.median ?? 0) - (p.err.median ?? 0)) > 0.3;
    if (changed) rows.push([`  ${s.id}`, d(p.tracked, s.tracked), d(p.err.median, s.err.median, 1, 2), d(p.wrong, s.wrong, 100, 2)]);
  }
  console.log(`\n이전 결과와 비교 (${path.relative(process.cwd(), prevFile)})`);
  console.log(formatTable(rows, [1, 2, 3]));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(HELP);
    return 0;
  }
  const quiet = !!args.quiet;
  const log = (s: string) => {
    if (!quiet) console.log(s);
  };
  pipelineOptions.exactJpeg = !!args["exact-jpeg"];
  pipelineOptions.exactBlur = !!args["exact-blur"];
  const filter = typeof args.scenario === "string" ? args.scenario : undefined;
  let suites: Suite[] = ["base", "realism"];
  if (args.holdout) suites = ["holdout"];
  if (typeof args.suite === "string") {
    suites = args.suite.split(",").flatMap((x) => (x === "all" ? (["base", "realism", "holdout"] as Suite[]) : [x as Suite]));
    const bad = suites.filter((x) => !["base", "realism", "holdout"].includes(x));
    if (bad.length) {
      console.error(`알 수 없는 묶음: ${bad.join(",")}`);
      return 2;
    }
  }
  let scenarios = selectScenarios(filter, suites);
  if (args["no-codec"]) scenarios = scenarios.filter((s) => !s.realism?.codec);
  if (args.list) {
    listScenarios(scenarios);
    return 0;
  }
  if (scenarios.length === 0) {
    console.error(`시나리오 없음: --scenario=${filter}`);
    return 2;
  }

  await ensureTextures(texturesFor(args.y4m ? [...scenarios, ...selectScenarios(undefined)] : scenarios), { log });

  // y4m 내보내기
  if (args.y4m) {
    const ids = typeof args.y4m === "string" ? args.y4m.split(",").map((id) => ({ id, seconds: undefined as number | undefined })) : Y4M_DEFAULTS;
    for (const { id, seconds } of ids) {
      const sc = scenarioById(id);
      if (!sc) {
        console.error(`y4m: 시나리오 없음 ${id}`);
        return 2;
      }
      for (const stream of [
        [640, 480],
        [480, 640],
      ] as [number, number][]) {
        const t0 = Date.now();
        const r = exportY4m(sc, { stream, seconds, marker: !args["no-marker"], preview: true });
        log(
          `y4m: ${path.relative(process.cwd(), r.file)} (${r.frames}프레임, ${(r.bytes / 1e6).toFixed(0)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s) + ${path.basename(r.sidecar)}`,
        );
      }
    }
    if (!args.tracker) return 0;
  }

  const trackerName = (typeof args.tracker === "string" ? args.tracker : "planar") as TrackerName;
  if (suites.includes("holdout")) log("※ 홀드아웃: 과적합 확인용입니다. 이 결과로 추적기를 튜닝하지 마세요.");
  const framesDir = typeof args["frames-dir"] === "string" ? path.resolve(args["frames-dir"]) : undefined;
  // 기준선(oracle/null/shifted)은 영상을 보지 않는다 → 렌더 생략 (--render 또는 --frames-dir면 렌더)
  const baseline = trackerName !== "planar";
  const blankFrames = baseline && !args.render && !framesDir && !args["render-only"] && !args.prerender;
  const useCache = !args["no-cache"];
  const jobs = typeof args.jobs === "string" ? Math.max(1, parseInt(args.jobs, 10) || 1) : defaultJobs();
  // 실제 코덱 시나리오: 캡처(렌더 + Chromium 루프백)가 캐시에 없으면 먼저 뜬다 — 처리 프레임·기준 시각이 캡처 결과로 정해진다
  const built = new Map<Scenario, Sequence>();
  if (!blankFrames) {
    const n = await ensureCodecCaptures(scenarios, { jobs, log, built });
    if (n) log(`코덱 캡처 ${n}개 완료`);
  }
  const seqs = scenarios.map((sc) => built.get(sc) ?? buildSequence(sc));
  if (useCache && !blankFrames) await prerender(seqs, { jobs, log });
  if (args["render-only"] || args.prerender) return 0;
  if (blankFrames) log("기준선 추적기: 프레임 렌더 생략 (--render로 강제)");

  if (!["planar", "oracle", "null", "shifted"].includes(trackerName)) {
    console.error(`알 수 없는 추적기: ${trackerName}`);
    return 2;
  }
  if (trackerName === "planar" && !trackerExists()) {
    console.error("src/lib/tracking/tracker.ts가 아직 없습니다. --tracker=oracle 또는 --tracker=null로 하네스만 돌려볼 수 있습니다.");
    return 2;
  }
  let config: Partial<TrackerConfig> = {};
  if (typeof args.config === "string") config = JSON.parse(args.config) as Partial<TrackerConfig>;
  const factory = await getTracker(trackerName, config);
  log(`추적기: ${factory.name} — ${factory.describe}`);

  const dumpEvery = typeof args.every === "string" ? Math.max(1, parseInt(args.every, 10) || 10) : 10;

  // JIT 예열 (시간 측정 공정성): 첫 시나리오 앞부분을 한 번 돌리고 버린다
  {
    const seq = seqs[0];
    const tr = factory.create(seq);
    // 기준선(빈 프레임)은 기준 이미지도 렌더하지 않는다
    const blankRef = { width: seq.gt[0].width, height: seq.gt[0].height, data: new Uint8Array(seq.gt[0].width * seq.gt[0].height) };
    tr.setReference(blankFrames ? blankRef : useCache ? cachedRef(seq) : seq.ref, seq.roi, seq.initialH, seq.pinRef);
    const n = blankFrames ? 0 : Math.min(15, seq.times.length);
    const cached = useCache ? readFrameCache(seq) : null;
    for (let k = 0; k < n; k++) {
      tr.beforeFrame?.(k, seq.gt[k]);
      tr.process(cached ? cached.frame(k) : seq.renderFrame(k), seq.times[k] * 1000);
    }
  }

  const runs: ScenarioRun[] = [];
  const t0 = Date.now();
  for (const seq of seqs) {
    const sc = seq.scenario;
    const run = runSequence(seq, factory, { useCache, framesDir, dumpEvery, blankFrames });
    runs.push(run);
    const m = run.metrics;
    log(
      `  ${sc.id.padEnd(34)} 추적 ${m.tracked === null ? "  -  " : `${(m.tracked * 100).toFixed(1)}%`.padStart(6)}  틀림 ${`${(m.wrong * 100).toFixed(2)}%`.padStart(6)}  ${m.frames}f${run.cached || blankFrames ? "" : " (렌더)"}`,
    );
  }
  log(`추적 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const agg = aggregate(runs.map((r) => ({ metrics: r.metrics, records: r.records })));
  console.log("");
  console.log(scenarioTable(runs.map((r) => r.metrics)));
  console.log("");
  console.log(categoryTable(agg.categories));
  console.log("  * = README 표 밖 (벤치 자체 목표: 틀린 표시 ≤1%, 드리프트는 이동 기준)");
  const ht = hintTable(agg.categories);
  if (ht) {
    console.log("\n화면 밖 안내 (TrackResult.hint, 목표 없음 — 참고): 핀이 화면 밖일 때 hint 제공률과 화살표 방향 오차(프레임 중심 기준)");
    console.log(ht);
  }
  const p = agg.perf;
  const f = (v: number | null) => (v === null ? "-" : v.toFixed(2));
  console.log(
    `\n성능 (Node, 작업 해상도): 추적 프레임 중앙값 ${f(p.msTrack.median)}ms / p95 ${f(p.msTrack.p95)}ms (n=${p.msTrack.n}, 목표 ≤${PERF_TARGETS.trackMedianMs}ms)` +
      `  재검출 프레임 중앙값 ${f(p.msRedetect.median)}ms / p95 ${f(p.msRedetect.p95)}ms (n=${p.msRedetect.n}, 목표 ≤${PERF_TARGETS.redetectMedianMs}ms)`,
  );
  {
    // setReference 시간 (시나리오당 1번, 기준 이미지 렌더는 타이머 밖). trackable=false도 포함
    const ms = runs.map((r) => r.refMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (ms.length && !blankFrames) {
      const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * (ms.length - 1) + 0.5))];
      const worst = runs.reduce((a, b) => (b.refMs > a.refMs ? b : a));
      console.log(
        `setReference: 중앙값 ${f(q(0.5))}ms / p95 ${f(q(0.95))}ms / 최대 ${f(ms[ms.length - 1])}ms (${worst.scenario.id}, n=${ms.length})`,
      );
    }
  }
  const drift = runs.find((r) => r.metrics.drift);
  if (drift?.metrics.drift) {
    console.log(
      `드리프트 (${drift.scenario.id}): 처음 10초 오차 중앙값 ${f(drift.metrics.drift.firstMedian)}px → 마지막 10초 ${f(drift.metrics.drift.lastMedian)}px`,
    );
  }
  const variants = variantTable(runs);
  if (variants) {
    console.log("\n실감 변형 ↔ 원본 (같은 궤적·핀; 원본이 이번 실행에 있을 때만)");
    console.log(variants);
  }
  const codecRuns = runs.filter((r) => r.seq.codec);
  if (codecRuns.length) {
    const rows = [["코덱 시나리오", "코덱", "인코더", "kbps", "QP 평균", "디코드 해상도", "원본", "디코드", "받음", "품질 제한"]];
    for (const r of codecRuns) {
      const st = r.seq.codec!.stats;
      rows.push([
        r.scenario.id,
        st.codec,
        st.encoder,
        String(st.kbps),
        st.qpMean === null ? "-" : st.qpMean.toFixed(1),
        st.resolutions.join(","),
        String(st.sourceFrames),
        st.framesDecoded === undefined ? "-" : String(st.framesDecoded),
        String(st.capturedFrames),
        st.qualityLimitation,
      ]);
    }
    console.log("\n실제 WebRTC 코덱 캡처 (Chromium 루프백, 캐시된 결과) — 원본(앞 구간 포함)·디코드(인코더가 버린 프레임 제외)·받음(rVFC로 읽은 프레임)");
    console.log(formatTable(rows, [3, 4, 6, 7, 8]));
  }
  const suitePass = (x: Suite) => agg.categories.filter((c) => c.suite === x).every((c) => c.pass);
  const present = [...new Set(agg.categories.map((c) => c.suite))];
  const perSuite = present.length > 1 ? ` — ${present.map((x) => `${x} ${suitePass(x) ? "PASS" : "FAIL"}`).join(", ")}` : "";
  console.log(`\n종합: ${agg.pass ? "PASS" : "FAIL"}${perSuite} (${factory.name}${filter ? `, --scenario=${filter}` : ""}, 묶음 ${suites.join("+")})`);
  if (framesDir) console.log(`프레임 덤프: ${framesDir}`);

  const json: BenchJson = {
    tracker: factory.name,
    filter: filter ?? null,
    pass: agg.pass,
    env: { node: process.version, cpu: os.cpus()[0]?.model ?? "?", platform: `${os.platform()} ${os.arch()}` },
    categories: agg.categories,
    perf: agg.perf,
    suites,
    scenarios: runs.map((r) => ({
      ...r.metrics,
      variantOf: r.scenario.variantOf ?? null,
      codec: r.seq.codec?.stats ?? null,
      refMs: Math.round(r.refMs * 100) / 100,
      roi: r.info?.roi ?? null,
      stageMs: r.stageMs,
      trace: compactTrace(r),
    })),
  };
  if (args.json) {
    const file =
      typeof args.json === "string"
        ? path.resolve(args.json)
        : path.join(OUT_DIR, `${factory.name === "planar" ? "latest" : `latest-${factory.name}`}${suites.includes("holdout") ? "-holdout" : ""}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, (_k, v) => (v === Infinity ? "Infinity" : v), 1));
    console.log(`JSON: ${path.relative(process.cwd(), file)}`);
  }
  if (typeof args.compare === "string") printCompare(path.resolve(args.compare), json);
  return args.strict && !agg.pass ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e);
    process.exitCode = 1;
  },
);
