// 렌더된 작업 해상도 프레임 캐시 (.cache/frames/). 렌더가 벤치 시간의 대부분이라, 두 번째 실행부터는
// 추적기만 돈다. 키(지문)는 "장면 함수들을 모든 프레임 시각에서 평가한 값 + 렌더 코드 해시"라서
// 궤적·조명·코드가 조금이라도 바뀌면 자동으로 다시 렌더한다.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { GrayImage } from "../../src/lib/tracking/types";
import { hashString } from "./rng";
import { type Sequence, pipelineOptions } from "./sequence";
import { CACHE_DIR, TEXTURES, readTextureMeta, writeFileAtomic } from "./textures";

export const FRAME_DIR = path.join(CACHE_DIR, "frames");

/** 렌더 결과를 바꾸는 소스 파일들 */
const RENDER_SOURCES = ["render.ts", "camera.ts", "sequence.ts", "imageops.ts", "textures.ts", "rng.ts"];
let codeHash: string | null = null;
function renderCodeHash(): string {
  if (codeHash) return codeHash;
  let s = "";
  for (const f of RENDER_SOURCES) {
    try {
      s += fs.readFileSync(path.join(__dirname, f), "utf8");
    } catch {
      s += f;
    }
  }
  codeHash = hashString(s).toString(16);
  return codeHash;
}

/** 시퀀스 지문: 처리 시각마다 자세·광원·손·그림자·스트림 크기 + 기준 설정 + 텍스처·코드 해시 */
export function sequenceFingerprint(seq: Sequence): string {
  const sc = seq.scenario;
  const sn = seq.scene;
  const parts: (string | number)[] = [
    renderCodeHash(),
    sc.id,
    sc.side,
    sc.target,
    sc.pin,
    JSON.stringify(sc.transport ?? null),
    JSON.stringify(pipelineOptions),
    sn.exposureMs,
    sn.readoutMs,
    JSON.stringify(sn.noise),
    sn.seed,
    JSON.stringify(sn.flicker ?? null),
    seq.refTime,
    readTextureMeta(sc.target)?.hash ?? "?",
  ];
  const bgId = sc.background ?? TEXTURES[sc.target].background ?? "wall";
  parts.push(readTextureMeta(bgId)?.hash ?? "?");
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const e = sn.exposureMs / 1000;
  const ro = sn.readoutMs / 1000;
  const probe = (t: number) => {
    for (const tau of [t, t - e / 2 - ro / 2, t + e / 2 + ro / 2]) {
      const p = sn.poseAt(tau);
      parts.push(...p.R.map(r6), ...p.C.map(r6));
      const hp = sn.hand?.at(tau);
      if (hp) parts.push(r6(hp.x), r6(hp.y), r6(hp.angle));
    }
    const K = sn.streamAt(t);
    const ph = sn.photoAt(t);
    parts.push(K.width, K.height, r6(ph.scene), r6(ph.gain), r6(ph.contrast), r6(ph.brightness));
    parts.push(r6(sn.ae?.(t) ?? 1), r6(sn.focusSigma?.(t) ?? 0), seq.qualityAt(t));
    const b = sn.shadow?.(t);
    if (b) parts.push(r6(b.x), r6(b.y), r6(b.rx), r6(b.ry), r6(b.depth), r6(b.soft));
  };
  probe(seq.refTime);
  for (const t of seq.times) probe(t);
  return hashString(parts.join(",")).toString(16).padStart(8, "0");
}

/** 파일 이름 앞부분: 시나리오 id + 길이 (게이트용 짧은 버전과 전체 버전이 서로의 캐시를 지우지 않게) */
function cachePrefix(seq: Sequence): string {
  return `${seq.scenario.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}.d${Math.round(seq.scenario.duration * 1000)}.`;
}

export function cacheFile(seq: Sequence, fp = sequenceFingerprint(seq)): string {
  return path.join(FRAME_DIR, `${cachePrefix(seq)}${fp}.bin`);
}

const MAGIC = 0x31464254; // "TBF1"

/** 압축된 프레임 목록을 캐시 파일로 (원자적). 같은 시나리오의 옛 캐시는 지운다 */
export function writeFrameCache(seq: Sequence, frames: Buffer[], fp = sequenceFingerprint(seq)): void {
  const header = Buffer.from(
    JSON.stringify({ id: seq.scenario.id, fp, count: frames.length, dims: seq.gt.map((g) => [g.width, g.height]) }),
  );
  const parts: Buffer[] = [];
  const h = Buffer.alloc(8);
  h.writeUInt32LE(MAGIC, 0);
  h.writeUInt32LE(header.length, 4);
  parts.push(h, header);
  for (const f of frames) {
    const l = Buffer.alloc(4);
    l.writeUInt32LE(f.length, 0);
    parts.push(l, f);
  }
  const file = cacheFile(seq, fp);
  const prefix = cachePrefix(seq);
  try {
    for (const old of fs.readdirSync(FRAME_DIR)) {
      if (old.startsWith(prefix) && old.endsWith(".bin") && path.join(FRAME_DIR, old) !== file) {
        fs.rmSync(path.join(FRAME_DIR, old), { force: true });
      }
    }
  } catch {
    // 디렉터리가 아직 없음
  }
  writeFileAtomic(file, Buffer.concat(parts));
}

export function compressFrame(img: GrayImage): Buffer {
  return zlib.deflateRawSync(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { level: 1 });
}

/** 캐시에서 읽은 프레임 모음. 없거나 손상됐으면 null */
export interface CachedFrames {
  count: number;
  frame(k: number): GrayImage;
}

export function readFrameCache(seq: Sequence, fp = sequenceFingerprint(seq)): CachedFrames | null {
  const file = cacheFile(seq, fp);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  try {
    if (buf.readUInt32LE(0) !== MAGIC) return null;
    const hl = buf.readUInt32LE(4);
    const header = JSON.parse(buf.subarray(8, 8 + hl).toString("utf8")) as { count: number; dims: [number, number][] };
    if (header.count !== seq.times.length) return null;
    const offs: number[] = [];
    let p = 8 + hl;
    for (let k = 0; k < header.count; k++) {
      const len = buf.readUInt32LE(p);
      offs.push(p + 4, len);
      p += 4 + len;
    }
    if (p !== buf.length) return null;
    return {
      count: header.count,
      frame(k: number): GrayImage {
        const [w, h] = header.dims[k];
        const raw = zlib.inflateRawSync(buf.subarray(offs[2 * k], offs[2 * k] + offs[2 * k + 1]));
        if (raw.length !== w * h) throw new Error(`frame cache corrupt: ${seq.scenario.id} #${k}`);
        return { width: w, height: h, data: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) };
      },
    };
  } catch {
    return null;
  }
}

export function hasFrameCache(seq: Sequence): boolean {
  return fs.existsSync(cacheFile(seq));
}
