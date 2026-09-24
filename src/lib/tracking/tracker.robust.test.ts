import { describe, expect, it } from "vitest";
import type { TrackResult } from "./types";
import { applyH } from "./geometry";
import { PlanarTracker } from "./tracker";
import { RH, RW, buildRobustSeq, robustCases, type RobustCase } from "./cv/testing/robust-scenes";

// 강건성: 벤치(scripts/tracking-bench)가 다루지 않는 영상 조건 — 렌즈 왜곡, 돌출부 시차(2~6mm 키),
// ISP 샤프닝 후광, 강한 모션 블러, 초점 흐림, 저조도 잡음, 노출 급변.
// 3D 카메라로 렌더한 합성 시퀀스(cv/testing/robust-scenes.ts)에서 핀 정답과 비교한다.
//
// 판정 (벤치와 같은 정의): 표시(tracking/weak) 중 핀 오차 > 8px 이거나 핀이 화면 밖으로 8px 넘게 나가면 "틀린 표시".
// 모든 시나리오에서 틀린 표시 0이 목표. minRate는 "전부 숨겨서 통과"를 막는 하한 (보이는 프레임 중 올바른 표시 비율).
// 렌더 비용 때문에 초표본 1 (계단 현상은 폰 카메라의 앨리어싱과 비슷한 수준).

interface Outcome {
  visible: number;
  correct: number;
  wrong: string[];
  maxErr: number;
  firstShown: number;
}

function run(c: RobustCase): Outcome {
  const seq = buildRobustSeq({ ...c.spec, supersample: 1 });
  const tr = new PlanarTracker();
  const info = tr.setReference(seq.ref, seq.roi, seq.initialH, seq.pinRef);
  expect(info.trackable).toBe(true);
  const out: Outcome = { visible: 0, correct: 0, wrong: [], maxErr: 0, firstShown: -1 };
  // 고객 쪽은 앵커가 0.2초 늦게 도착한다 (그동안 폰이 움직임)
  for (let t = c.spec.engineer ? 1 : 6; t < seq.frames.length; t++) {
    const r: TrackResult = tr.process(seq.frames[t], seq.times[t]);
    const g = seq.pins[t];
    const inFrame = !!g && g.x >= -0.5 && g.y >= -0.5 && g.x <= RW - 0.5 && g.y <= RH - 0.5;
    if (inFrame) out.visible++;
    const shown = (r.state === "tracking" || r.state === "weak") && !!r.H;
    // 계약: H는 표시 상태에서만, hint는 lost+offscreen에서만
    if (!shown) expect(r.H).toBeNull();
    if (r.hint) expect(r.state === "lost" && r.reason === "offscreen").toBe(true);
    if (!shown) continue;
    const e = applyH(r.H!, seq.pinRef);
    const off = g ? Math.max(0, -0.5 - g.x, g.x - (RW - 0.5), -0.5 - g.y, g.y - (RH - 0.5)) : Infinity;
    const err = e && g ? Math.hypot(e.x - g.x, e.y - g.y) : Infinity;
    if (err > 8 || off > 8) {
      out.wrong.push(`#${t} ${r.state} err ${err.toFixed(1)}px`);
      continue;
    }
    if (inFrame) {
      out.correct++;
      out.maxErr = Math.max(out.maxErr, err);
      if (out.firstShown < 0) out.firstShown = t;
    }
  }
  return out;
}

describe("PlanarTracker robustness (lens distortion, relief parallax, ISP, blur, noise, exposure)", () => {
  for (const c of robustCases()) {
    it(c.spec.name, { timeout: 60000 }, () => {
      const o = run(c);
      const rate = o.correct / Math.max(1, o.visible);
      // 실패 시 무엇이 틀렸는지 보이게
      expect(o.wrong).toEqual([]);
      expect(rate).toBeGreaterThanOrEqual(c.minRate);
      expect(o.maxErr).toBeLessThanOrEqual(8);
    });
  }
});
