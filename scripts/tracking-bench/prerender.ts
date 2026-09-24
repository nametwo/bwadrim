// 병렬 사전 렌더: 시나리오를 프레임 묶음으로 쪼개 worker_threads에 나눠 렌더 → 프레임 캐시에 저장.
// 추적기 시간 측정은 그 다음에 (다른 부하 없이) 한다.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { compressFrame, readFrameCache, sequenceFingerprint, writeFrameCache } from "./framecache";
import type { Scenario } from "./scenarios";
import { type Sequence, buildSequence, pipelineOptions } from "./sequence";

export interface RenderTask {
  id: string;
  /** 시나리오 길이 덮어쓰기 (게이트용 짧은 버전) */
  duration: number;
  k0: number;
  k1: number;
}

export interface RenderResult {
  id: string;
  k0: number;
  frames: Uint8Array[];
  error?: string;
}

export function defaultJobs(): number {
  return Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1));
}

/** 작업자 진입점: tsx CJS 등록 후 TS 모듈을 require (실행 환경이 tsx든 vitest든 같게) */
function workerSource(): string {
  const req = createRequire(__filename);
  const api = req.resolve("tsx/cjs/api");
  const entry = path.join(__dirname, "render-worker.ts");
  return `require(${JSON.stringify(api)}).register(); require(${JSON.stringify(entry)});`;
}

/**
 * 캐시가 없는 시나리오의 프레임을 병렬로 렌더해 캐시에 쓴다. 이미 만든 Sequence를 넘기면 다시 만들지 않는다.
 * 시나리오는 SCENARIOS의 것 그대로이거나 duration만 바꾼 사본이어야 한다 (작업자는 id로 다시 찾는다).
 * jobs ≤ 1이면 이 프로세스에서 차례로 렌더.
 * 반환: 새로 렌더한 시나리오 수
 */
export async function prerender(
  items: (Scenario | Sequence)[],
  opts: { jobs?: number; chunk?: number; log?: (s: string) => void } = {},
): Promise<number> {
  const log = opts.log ?? (() => {});
  const jobs = opts.jobs ?? defaultJobs();
  const chunk = opts.chunk ?? 45;
  const pending: { seq: Sequence; fp: string; frames: (Buffer | null)[]; left: number }[] = [];
  for (const it of items) {
    const seq = "gt" in it ? it : buildSequence(it);
    const fp = sequenceFingerprint(seq);
    if (readFrameCache(seq, fp)) continue;
    pending.push({ seq, fp, frames: new Array(seq.times.length).fill(null), left: seq.times.length });
  }
  if (pending.length === 0) return 0;
  const total = pending.reduce((s, p) => s + p.seq.times.length, 0);
  log(`렌더: 시나리오 ${pending.length}개, 프레임 ${total}장, 작업자 ${jobs}개`);
  const t0 = Date.now();

  if (jobs <= 1) {
    for (const p of pending) {
      const frames = p.seq.times.map((_, k) => compressFrame(p.seq.renderFrame(k)));
      writeFrameCache(p.seq, frames, p.fp);
      log(`  ${p.seq.scenario.id} (${frames.length}장)`);
    }
    log(`렌더 완료 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return pending.length;
  }

  // 긴 시나리오부터 쪼개서 큐에
  const byId = new Map(pending.map((p) => [p.seq.scenario.id, p]));
  const tasks: RenderTask[] = [];
  for (const p of [...pending].sort((a, b) => b.seq.times.length - a.seq.times.length)) {
    for (let k0 = 0; k0 < p.seq.times.length; k0 += chunk) {
      tasks.push({ id: p.seq.scenario.id, duration: p.seq.scenario.duration, k0, k1: Math.min(p.seq.times.length, k0 + chunk) });
    }
  }
  let done = 0;
  let lastLog = Date.now();
  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let failed = false;
    const workers: Worker[] = [];
    const next = (w: Worker) => {
      const task = tasks.shift();
      if (!task) {
        void w.terminate();
        active--;
        if (active === 0 && !failed) resolve();
        return;
      }
      w.postMessage(task);
    };
    for (let i = 0; i < Math.min(jobs, tasks.length); i++) {
      const w = new Worker(workerSource(), {
        eval: true,
        execArgv: [],
        workerData: { pipelineOptions },
      });
      workers.push(w);
      active++;
      w.on("message", (r: RenderResult) => {
        if (r.error) {
          failed = true;
          workers.forEach((x) => void x.terminate());
          reject(new Error(`render worker failed (${r.id}): ${r.error}`));
          return;
        }
        const p = byId.get(r.id)!;
        r.frames.forEach((f, i) => {
          p.frames[r.k0 + i] = Buffer.from(f.buffer, f.byteOffset, f.length);
        });
        p.left -= r.frames.length;
        done += r.frames.length;
        if (p.left === 0) {
          writeFrameCache(p.seq, p.frames as Buffer[], p.fp);
          log(`  ${p.seq.scenario.id} (${p.frames.length}장)`);
        }
        if (Date.now() - lastLog > 10000) {
          lastLog = Date.now();
          log(`  … ${done}/${total}장 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        }
        next(w);
      });
      w.on("error", (e) => {
        if (failed) return;
        failed = true;
        workers.forEach((x) => void x.terminate());
        reject(e);
      });
      next(w);
    }
  });
  log(`렌더 완료 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return pending.length;
}
