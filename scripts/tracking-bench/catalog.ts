// 시나리오 목록 전체 (base + realism + holdout). 홀드아웃은 holdout.ts에 따로 있다 — 추적기 개발 중에는 보지 말 것.
import { HOLDOUT_SCENARIOS } from "./holdout";
import { SCENARIOS, type Scenario, type Suite, suiteOf } from "./scenarios";
import { REALISM_SCENARIOS } from "./scenarios-realism";

let all: Scenario[] | null = null;

export function allScenarios(): Scenario[] {
  if (!all) {
    all = [...SCENARIOS, ...REALISM_SCENARIOS, ...HOLDOUT_SCENARIOS];
    const ids = new Set<string>();
    for (const s of all) {
      if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
      ids.add(s.id);
    }
  }
  return all;
}

export function scenarioById(id: string): Scenario | undefined {
  return allScenarios().find((s) => s.id === id);
}

/**
 * 묶음(suites)으로 거른 뒤 --scenario 필터 (id 부분문자열·범주·묶음 이름, 쉼표로 여러 개).
 * 기본 묶음 = base + realism (holdout은 --holdout으로만).
 */
export function selectScenarios(filter: string | undefined, suites: Suite[] = ["base", "realism"]): Scenario[] {
  const pool = allScenarios().filter((s) => suites.includes(suiteOf(s)));
  if (!filter) return pool;
  const parts = filter.split(",").map((s) => s.trim()).filter(Boolean);
  return pool.filter((s) => parts.some((p) => s.id.includes(p) || s.category === p || suiteOf(s) === p));
}
