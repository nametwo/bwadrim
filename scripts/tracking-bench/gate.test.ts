// 품질 게이트: 대표 시나리오 부분집합(GATE_SUBSET)을 실제 PlanarTracker로 돌려 README "품질 목표"를 확인한다.
// - src/lib/tracking/tracker.ts가 없으면 건너뛴다 (메시지 출력).
// - 프레임은 .cache/frames에 캐시 — 첫 실행은 병렬 렌더(~1400장)로 1분 남짓, 이후 ~20초.
// - 성능 목표(추적 ≤5ms, 재검출 ≤15ms 중앙값)는 다른 테스트와 CPU를 나눠 쓰므로 기본 2배 여유로 확인.
//   TRACKING_GATE_PERF=strict 이면 README 값 그대로, =off 이면 확인 안 함.
import { beforeAll, describe, expect, it } from "vitest";
import { readFrameCache } from "./framecache";
import { runSequence } from "./harness";
import {
  type Check,
  PERF_TARGETS,
  aggregate,
  categoryName,
  categoryTable,
  scenarioTable,
} from "./metrics";
import { defaultJobs, prerender } from "./prerender";
import { type Category, gateScenarios } from "./scenarios";
import { buildSequence } from "./sequence";
import { ensureTextures } from "./textures";
import { getTracker, trackerExists } from "./trackers";

const HAS_TRACKER = trackerExists();
const PERF_MODE = process.env.TRACKING_GATE_PERF ?? "lenient";
const GATE_CATEGORIES: Category[] = ["jitter", "motion", "repetitive", "lowtex", "reentry", "acquire"];

if (!HAS_TRACKER) {
  console.warn("[tracking gate] src/lib/tracking/tracker.ts가 없어 품질 게이트를 건너뜁니다.");
}

function explain(checks: Check[]): string {
  return checks
    .map((c) => `${c.pass === false ? "✗" : c.pass === null ? "·" : "✓"} ${c.name} ${c.value === null ? "-" : c.value.toFixed(4)} ${c.op} ${c.target}`)
    .join("; ");
}

describe.skipIf(!HAS_TRACKER)("tracking quality gate (README 품질 목표)", () => {
  let agg: ReturnType<typeof aggregate>;

  beforeAll(async () => {
    await ensureTextures();
    const seqs = gateScenarios().map((sc) => buildSequence(sc));
    await prerender(seqs, { jobs: defaultJobs() });
    const factory = await getTracker("planar");
    // JIT 예열 (측정 제외)
    {
      const seq = seqs[0];
      const cached = readFrameCache(seq);
      const tr = factory.create(seq);
      tr.setReference(seq.ref, seq.roi, seq.initialH, seq.pinRef);
      for (let k = 0; k < Math.min(10, seq.times.length); k++) {
        tr.process(cached ? cached.frame(k) : seq.renderFrame(k), seq.times[k] * 1000);
      }
    }
    const runs = seqs.map((seq) => runSequence(seq, factory));
    agg = aggregate(runs.map((r) => ({ metrics: r.metrics, records: r.records })));
    console.log(`\n${scenarioTable(runs.map((r) => r.metrics))}\n\n${categoryTable(agg.categories)}`);
    console.log(
      `perf: track median ${agg.perf.msTrack.median?.toFixed(2)}ms (n=${agg.perf.msTrack.n}), redetect median ${agg.perf.msRedetect.median?.toFixed(2)}ms (n=${agg.perf.msRedetect.n})`,
    );
  }, 600_000);

  for (const cat of GATE_CATEGORIES) {
    it(`${categoryName(cat)} (${cat})`, () => {
      const c = agg.categories.find((x) => x.category === cat);
      expect(c, `category ${cat} missing from gate subset`).toBeDefined();
      const failed = c!.checks.filter((k) => k.pass === false);
      expect(failed, explain(c!.checks)).toEqual([]);
    });
  }

  it.skipIf(PERF_MODE === "off")(`성능 (${PERF_MODE === "strict" ? "README 값" : "2배 여유"})`, () => {
    const slack = PERF_MODE === "strict" ? 1 : 2;
    const { msTrack, msRedetect } = agg.perf;
    if (msTrack.median !== null) expect(msTrack.median).toBeLessThanOrEqual(PERF_TARGETS.trackMedianMs * slack);
    if (msRedetect.median !== null) expect(msRedetect.median).toBeLessThanOrEqual(PERF_TARGETS.redetectMedianMs * slack);
  });
});

if (!HAS_TRACKER) {
  describe("tracking quality gate", () => {
    it.skip("src/lib/tracking/tracker.ts not found — PlanarTracker 구현 후 자동으로 실행됩니다", () => {});
  });
}
