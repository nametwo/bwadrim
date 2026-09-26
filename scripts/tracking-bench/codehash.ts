// 캐시 지문에 넣는 렌더 코드 해시 + 장면 탐침. framecache(작업 해상도 프레임)와 codec-cache(코덱 캡처)가 같이 쓴다.
// 기존(base) 시나리오는 BASE 소스만, 실감 시나리오는 REALISM 소스도 — 실감 코드만 바꾸면 base 캐시는 그대로다.
import fs from "node:fs";
import path from "node:path";
import type { SceneSetup } from "./render";
import { hashString } from "./rng";

/** 렌더 결과를 바꾸는 소스 (모든 시나리오) */
export const BASE_SOURCES = ["render.ts", "camera.ts", "sequence.ts", "imageops.ts", "textures.ts", "rng.ts"];
/** 실감 시나리오에만 영향 */
export const REALISM_SOURCES = ["lens.ts", "relief.ts", "isp.ts", "dlt.ts", "photoize.ts"];

const cache = new Map<string, string>();
export function sourceHash(files: readonly string[]): string {
  const key = files.join("|");
  const hit = cache.get(key);
  if (hit) return hit;
  let s = "";
  for (const f of files) {
    try {
      s += fs.readFileSync(path.join(__dirname, f), "utf8");
    } catch {
      s += f;
    }
  }
  const h = hashString(s).toString(16);
  cache.set(key, h);
  return h;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** 시각 t의 장면 상태(자세·손·조명·스트림·노출·초점·그림자)를 지문 조각으로 */
export function probeScene(sn: SceneSetup, t: number, parts: (string | number)[], quality: number): void {
  const e = sn.exposureMs / 1000;
  const ro = sn.readoutMs / 1000;
  for (const tau of [t, t - e / 2 - ro / 2, t + e / 2 + ro / 2]) {
    const p = sn.poseAt(tau);
    parts.push(...p.R.map(r6), ...p.C.map(r6));
    const hp = sn.hand?.at(tau);
    if (hp) parts.push(r6(hp.x), r6(hp.y), r6(hp.angle));
  }
  const K = sn.streamAt(t);
  const ph = sn.photoAt(t);
  parts.push(K.width, K.height, r6(ph.scene), r6(ph.gain), r6(ph.contrast), r6(ph.brightness));
  parts.push(r6(sn.ae?.(t) ?? 1), r6(sn.focusSigma?.(t) ?? 0), quality);
  const b = sn.shadow?.(t);
  if (b) parts.push(r6(b.x), r6(b.y), r6(b.rx), r6(b.ry), r6(b.depth), r6(b.soft));
}

/** 실감 장면 전용 추가 지문 (초점 호흡은 streamAt의 f) */
export function probeRealism(sn: SceneSetup, t: number, parts: (string | number)[]): void {
  parts.push(r6(sn.streamAt(t).f));
}
