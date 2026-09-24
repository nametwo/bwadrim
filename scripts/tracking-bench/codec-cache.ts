// 실제 WebRTC 코덱 캡처 결과 캐시 (.cache/codec/). 캡처는 실시간·비결정적이라 한 번 떠서 저장하고 계속 쓴다.
// 키 = 원본 프레임 지문(장면·렌더 코드) + 코덱 설정 + 캡처 코드 해시. 원본이 바뀌면 다시 캡처한다.
//
// 저장 형식: "TBC1" + 헤더 JSON 길이 + 헤더 JSON + 프레임마다 (길이 + deflate(Y 전체범위 8bit, 이미지 영역만)).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { GrayImage } from "../../src/lib/tracking/types";
import { hashString } from "./rng";
import type { CodecSpec } from "./scenarios";
import { CACHE_DIR, writeFileAtomic } from "./textures";

export const CODEC_DIR = path.join(CACHE_DIR, "codec");
/** 인코더에 먼저 먹이는 앞 구간 (초). 루프 경계의 장면 전환 후 인코더·대역폭 추정이 안정되게 */
export const CODEC_LEAD_S = 2;

/**
 * 캡처할 카메라 프레임 번호 구간 [i0, i1] (30fps, 0 = t=0). 앞 구간 포함.
 * 고객 쪽은 기준 이미지 한 장만 필요하므로 기준 +0.5초까지만.
 */
export function codecRange(sc: { side: string; duration: number; refTime: number }, fps: number): [number, number] {
  const i0 = -Math.round(CODEC_LEAD_S * fps);
  let i1 = Math.floor(sc.duration * fps + 1e-6);
  if (sc.side === "customer") i1 = Math.min(i1, Math.round((sc.refTime + 0.5) * fps));
  return [i0, i1];
}

export interface CodecStats {
  codec: string;
  encoder: string;
  decoder: string;
  /** 캡처 구간 평균 비트레이트 (kbps, 송신 바이트 기준) */
  kbps: number;
  /** 평균 양자화 파라미터 (코덱마다 척도 다름: VP8/VP9 0~127) */
  qpMean: number | null;
  /** 원본 프레임 수(앞 구간 포함) 대비 캡처된 프레임 수 */
  sourceFrames: number;
  capturedFrames: number;
  /** 디코드 해상도 (이미지 영역) 목록 */
  resolutions: string[];
  qualityLimitation: string;
  /** 수신 쪽 디코드 프레임 수 (기록 구간) — 받은 프레임보다 많으면 읽기가 밀린 것 */
  framesDecoded: number;
  /** 시도 횟수 (전달률 미달이면 다시 뜬다) */
  attempts: number;
  /** 모든 시도가 읽기 미달(디코드 대비)이라 가장 나은 것을 썼음 */
  lowDelivery: boolean;
}

export interface CodecCapture {
  id: string;
  key: string;
  /** 캡처된 카메라 프레임 번호 (30fps, 0 = t=0, 오름차순, 앞 구간 제외) */
  indices: number[];
  frame(i: number): GrayImage | null;
  stats: CodecStats;
  /** 디코드 결과 내용 해시 (프레임 캐시 지문용) */
  contentHash: string;
}

/**
 * 캡처 방식 버전 — 캡처 결과를 바꾸는 수정(페이지 스크립트·띠 규칙·기록 구간·변환)을 하면 올린다.
 * (코드 해시 대신 수동 버전: 캡처는 실시간이라 다시 뜨는 비용이 크고, 리팩터링마다 무효화할 이유가 없다)
 */
export const CODEC_VERSION = 2;
/** 디코드된 프레임 중 읽어 온 비율이 이 미만이면 다시 뜬다 (기계 부하로 읽기가 밀린 캡처를 거름) */
export const CODEC_MIN_DELIVERY = 0.9;

export function codecKey(sourceFp: string, spec: CodecSpec): string {
  return hashString(`${sourceFp}|${JSON.stringify(spec)}|${CODEC_LEAD_S}|v${CODEC_VERSION}`).toString(16).padStart(8, "0");
}

function fileFor(id: string, key: string): string {
  return path.join(CODEC_DIR, `${id.replace(/[^a-zA-Z0-9_-]+/g, "_")}.${key}.bin`);
}

const MAGIC = 0x31434254; // "TBC1"
const loaded = new Map<string, CodecCapture | null>();

export function loadCodecCapture(id: string, key: string): CodecCapture | null {
  const file = fileFor(id, key);
  if (loaded.has(file)) return loaded.get(file)!;
  let cap: CodecCapture | null = null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32LE(0) === MAGIC) {
      const hl = buf.readUInt32LE(4);
      const header = JSON.parse(buf.subarray(8, 8 + hl).toString("utf8")) as {
        id: string;
        key: string;
        frames: { i: number; w: number; h: number }[];
        stats: CodecStats;
        contentHash: string;
      };
      const offs = new Map<number, { off: number; len: number; w: number; h: number }>();
      let p = 8 + hl;
      for (const f of header.frames) {
        const len = buf.readUInt32LE(p);
        offs.set(f.i, { off: p + 4, len, w: f.w, h: f.h });
        p += 4 + len;
      }
      if (p === buf.length) {
        cap = {
          id: header.id,
          key: header.key,
          indices: header.frames.map((f) => f.i).filter((i) => i >= 0),
          stats: header.stats,
          contentHash: header.contentHash,
          frame(i: number): GrayImage | null {
            const o = offs.get(i);
            if (!o) return null;
            const raw = zlib.inflateRawSync(buf.subarray(o.off, o.off + o.len));
            return { width: o.w, height: o.h, data: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) };
          },
        };
      }
    }
  } catch {
    cap = null;
  }
  loaded.set(file, cap);
  return cap;
}

export function saveCodecCapture(
  id: string,
  key: string,
  frames: { i: number; img: GrayImage }[],
  stats: CodecStats,
): string {
  frames.sort((a, b) => a.i - b.i);
  let h = 0x811c9dc5;
  const blobs = frames.map((f) => {
    const d = Buffer.from(f.img.data.buffer, f.img.data.byteOffset, f.img.data.length);
    for (let k = 0; k < d.length; k += 97) h = Math.imul(h ^ d[k], 0x01000193);
    return zlib.deflateRawSync(d, { level: 6 });
  });
  const header = Buffer.from(
    JSON.stringify({
      id,
      key,
      frames: frames.map((f) => ({ i: f.i, w: f.img.width, h: f.img.height })),
      stats,
      contentHash: (h >>> 0).toString(16),
    }),
  );
  const parts: Buffer[] = [];
  const hd = Buffer.alloc(8);
  hd.writeUInt32LE(MAGIC, 0);
  hd.writeUInt32LE(header.length, 4);
  parts.push(hd, header);
  for (const b of blobs) {
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length, 0);
    parts.push(l, b);
  }
  const file = fileFor(id, key);
  const prefix = path.basename(file).split(".")[0] + ".";
  try {
    for (const old of fs.readdirSync(CODEC_DIR)) {
      if (old.startsWith(prefix) && old.endsWith(".bin") && path.join(CODEC_DIR, old) !== file) fs.rmSync(path.join(CODEC_DIR, old), { force: true });
    }
  } catch {
    // 아직 폴더 없음
  }
  writeFileAtomic(file, Buffer.concat(parts));
  loaded.delete(file);
  return file;
}
