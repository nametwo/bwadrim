// 사전 렌더 작업자 (worker_threads). prerender.ts가 띄운다.
import { parentPort, workerData } from "node:worker_threads";
import { compressFrame } from "./framecache";
import type { RenderResult, RenderTask } from "./prerender";
import { SCENARIOS } from "./scenarios";
import { type Sequence, buildSequence, pipelineOptions } from "./sequence";

Object.assign(pipelineOptions, (workerData as { pipelineOptions?: typeof pipelineOptions })?.pipelineOptions ?? {});
const seqs = new Map<string, Sequence>();

parentPort?.on("message", (task: RenderTask) => {
  try {
    const key = `${task.id}|${task.duration}`;
    let seq = seqs.get(key);
    if (!seq) {
      const sc = SCENARIOS.find((s) => s.id === task.id);
      if (!sc) throw new Error(`unknown scenario ${task.id}`);
      seq = buildSequence({ ...sc, duration: task.duration });
      seqs.set(key, seq);
    }
    const frames: Uint8Array[] = [];
    for (let k = task.k0; k < task.k1; k++) {
      const c = compressFrame(seq.renderFrame(k));
      frames.push(new Uint8Array(c)); // 독립 버퍼로 복사 → 전송
    }
    const res: RenderResult = { id: task.id, k0: task.k0, frames };
    parentPort!.postMessage(res, frames.map((f) => f.buffer as ArrayBuffer));
  } catch (e) {
    const res: RenderResult = { id: task.id, k0: task.k0, frames: [], error: String((e as Error)?.stack ?? e) };
    parentPort!.postMessage(res);
  }
});
