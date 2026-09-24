// 사전 렌더 작업자 (worker_threads). prerender.ts(작업 해상도 프레임)·codec.ts(코덱 원본 카메라 프레임)가 띄운다.
import { parentPort, workerData } from "node:worker_threads";
import { scenarioById } from "./catalog";
import { renderCameraTask } from "./codec";
import { compressFrame } from "./framecache";
import type { RenderResult, RenderTask } from "./prerender";
import { type Sequence, buildSequence, pipelineOptions } from "./sequence";

Object.assign(pipelineOptions, (workerData as { pipelineOptions?: typeof pipelineOptions })?.pipelineOptions ?? {});
const seqs = new Map<string, Sequence>();

function sequenceFor(id: string, duration: number): Sequence {
  const key = `${id}|${duration}`;
  let seq = seqs.get(key);
  if (!seq) {
    const sc = scenarioById(id);
    if (!sc) throw new Error(`unknown scenario ${id}`);
    seq = buildSequence({ ...sc, duration });
    seqs.set(key, seq);
  }
  return seq;
}

type Task = RenderTask | { kind: "camera"; id: string; duration: number; i0: number; i1: number };

parentPort?.on("message", (task: Task) => {
  try {
    const seq = sequenceFor(task.id, task.duration);
    if ("kind" in task && task.kind === "camera") {
      const frames = renderCameraTask(seq, task);
      parentPort!.postMessage({ frames }, frames.flatMap((f) => f.planes.map((p) => p.buffer as ArrayBuffer)));
      return;
    }
    const t = task as RenderTask;
    const frames: Uint8Array[] = [];
    for (let k = t.k0; k < t.k1; k++) {
      const c = compressFrame(seq.renderFrame(k));
      frames.push(new Uint8Array(c)); // 독립 버퍼로 복사 → 전송
    }
    const res: RenderResult = { id: t.id, k0: t.k0, frames };
    parentPort!.postMessage(res, frames.map((f) => f.buffer as ArrayBuffer));
  } catch (e) {
    const res = { id: task.id, k0: "k0" in task ? task.k0 : 0, frames: [], error: String((e as Error)?.stack ?? e) };
    parentPort!.postMessage(res);
  }
});
