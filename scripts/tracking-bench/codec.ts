// 실제 WebRTC 코덱 왕복: 렌더한 고객 카메라 영상(ISP 포함, 컬러)을 Playwright Chromium의 가짜 카메라(y4m)로 넣고
// 한 페이지 안의 RTCPeerConnection 두 개(송신 → 수신) 루프백으로 실제 인코더(libvpx VP8/VP9, libaom AV1)를 통과시킨다.
// 수신 <video>에서 requestVideoFrameCallback마다 VideoFrame의 Y 평면(디코더 출력, 16~235)을 읽어 저장한다
// — 런타임(frame-source VideoFrame 경로)이 읽는 것과 같은 데이터.
//
// 프레임 번호: 영상 아래에 32행 띠를 덧붙여 번호를 새긴다(이미지 영역은 그대로). 16칸 = 흰/비트0..12/홀짝/검정.
// 가짜 카메라는 파일을 반복 재생하므로 첫 바퀴는 연결·대역폭 추정이 자리잡는 데 쓰고 두 번째 바퀴를 기록한다.
// 앞 구간(CODEC_LEAD_S)을 붙여 루프 경계의 장면 전환이 기록 구간 앞에서 끝나게 한다.
//
// H.264: Playwright Chromium은 독점 코덱이 빠진 빌드라 쓸 수 없다 (VP8·VP9·AV1만). 실제 앱은 Chrome↔Chrome이면 보통 VP8.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { GrayImage } from "../../src/lib/tracking/types";
import { scenarioById } from "./catalog";
import { CODEC_DIR, CODEC_MIN_DELIVERY, type CodecStats, codecRange, saveCodecCapture } from "./codec-cache";
import type { Scenario } from "./scenarios";
import { CAMERA_FPS, type Sequence, buildSequence, pipelineOptions } from "./sequence";
import { rgbToYuv420 } from "./y4m";
import { defaultJobs, workerSource } from "./prerender";

export const BAND_ROWS = 32;
const CELLS = 16;
const INDEX_BITS = 13;

/** 띠 칸 값: 칸0 흰색, 칸1..13 번호 비트, 칸14 홀짝(비트 XOR), 칸15 검정 */
export function bandBits(index: number): boolean[] {
  const bits: boolean[] = [true];
  let par = false;
  for (let b = 0; b < INDEX_BITS; b++) {
    const v = ((index >> b) & 1) === 1;
    bits.push(v);
    par = par !== v;
  }
  bits.push(par);
  bits.push(false);
  return bits;
}

/** Y 평면(전체 높이 hTot, 띠는 아래 bandH행)에서 번호 읽기. 칸 가운데 절반 영역 평균 > 126이면 1. 검사 실패면 null */
export function decodeBand(y: Uint8Array | Uint8ClampedArray, w: number, hTot: number, bandH: number): number | null {
  const y0 = hTot - bandH + Math.floor(bandH / 4);
  const y1 = hTot - Math.floor(bandH / 4);
  const cw = w / CELLS;
  const bit = (c: number) => {
    const x0 = Math.floor(c * cw + cw / 4);
    const x1 = Math.max(x0 + 1, Math.floor(c * cw + (3 * cw) / 4));
    let s = 0;
    let n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++, n++) s += y[yy * w + xx];
    return s / Math.max(1, n) > 126;
  };
  if (!bit(0) || bit(CELLS - 1)) return null;
  let v = 0;
  let par = false;
  for (let b = 0; b < INDEX_BITS; b++) {
    if (bit(b + 1)) {
      v |= 1 << b;
      par = !par;
    }
  }
  return bit(CELLS - 2) === par ? v : null;
}

function stampBand(yuv: Buffer, w: number, hImg: number, index: number): void {
  const hTot = hImg + BAND_ROWS;
  const bits = bandBits(index);
  const cw = w / CELLS;
  for (let y = hImg; y < hTot; y++) for (let x = 0; x < w; x++) yuv[y * w + x] = bits[Math.min(CELLS - 1, Math.floor(x / cw))] ? 235 : 16;
}

/** 이미지 + 띠 → YUV420 한 장 */
function frameYuv(planes: Uint8Array[], w: number, hImg: number, index: number): Buffer {
  const hTot = hImg + BAND_ROWS;
  const img = rgbToYuv420(planes, w, hImg);
  const out = Buffer.alloc(w * hTot * 1.5, 128);
  // Y
  img.copy(out, 0, 0, w * hImg);
  // U, V (이미지 부분만 복사, 띠 부분은 128)
  const cw = w >> 1;
  const chImg = hImg >> 1;
  const chTot = hTot >> 1;
  img.copy(out, w * hTot, w * hImg, w * hImg + cw * chImg);
  img.copy(out, w * hTot + cw * chTot, w * hImg + cw * chImg, w * hImg + 2 * cw * chImg);
  stampBand(out, w, hImg, index);
  return out;
}

interface CameraTask {
  kind: "camera";
  id: string;
  duration: number;
  i0: number;
  i1: number;
}

/** 원본 카메라 프레임(컬러, ISP 포함)을 작업자들로 병렬 렌더 */
async function renderSource(seq: Sequence, i0: number, i1: number, jobs: number, log: (s: string) => void): Promise<Map<number, Uint8Array[]>> {
  const out = new Map<number, Uint8Array[]>();
  const chunk = 16;
  const tasks: CameraTask[] = [];
  for (let a = i0; a <= i1; a += chunk) tasks.push({ kind: "camera", id: seq.scenario.id, duration: seq.scenario.duration, i0: a, i1: Math.min(i1 + 1, a + chunk) });
  if (jobs <= 1) {
    for (let i = i0; i <= i1; i++) out.set(i, seq.renderCameraIndex(i, true).planes);
    return out;
  }
  const t0 = Date.now();
  let last = t0;
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
    for (let k = 0; k < Math.min(jobs, tasks.length); k++) {
      const w = new Worker(workerSource(), { eval: true, execArgv: [], workerData: { pipelineOptions } });
      workers.push(w);
      active++;
      w.on("message", (r: { error?: string; frames?: { i: number; planes: Uint8Array[] }[] }) => {
        if (r.error) {
          failed = true;
          workers.forEach((x) => void x.terminate());
          reject(new Error(`codec source render failed: ${r.error}`));
          return;
        }
        for (const f of r.frames!) out.set(f.i, f.planes);
        if (Date.now() - last > 10000) {
          last = Date.now();
          log(`    원본 렌더 ${out.size}/${i1 - i0 + 1}장 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
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
  return out;
}

/** 작업자 쪽: 카메라 프레임 렌더 (render-worker.ts에서 부른다) */
export function renderCameraTask(seq: Sequence, task: CameraTask): { i: number; planes: Uint8Array[] }[] {
  const frames: { i: number; planes: Uint8Array[] }[] = [];
  for (let i = task.i0; i < task.i1; i++) frames.push({ i, planes: seq.renderCameraIndex(i, true).planes.map((p) => new Uint8Array(p)) });
  return frames;
}

// 페이지 스크립트 (문자열 — 트랜스파일러 헬퍼가 끼지 않게). cfg: {codec, kbps, scale, degradation, W, H, bandRows, total}
const PAGE_SCRIPT = `async (cfg) => {
  const CELLS = 16, BITS = 13;
  const decode = (y, w, hTot, bandH) => {
    const y0 = hTot - bandH + Math.floor(bandH / 4), y1 = hTot - Math.floor(bandH / 4), cw = w / CELLS;
    const bit = (c) => {
      const x0 = Math.floor(c * cw + cw / 4), x1 = Math.max(x0 + 1, Math.floor(c * cw + 3 * cw / 4));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++, n++) s += y[yy * w + xx];
      return s / Math.max(1, n) > 126;
    };
    if (!bit(0) || bit(CELLS - 1)) return null;
    let v = 0, par = false;
    for (let b = 0; b < BITS; b++) if (bit(b + 1)) { v |= 1 << b; par = !par; }
    return bit(CELLS - 2) === par ? v : null;
  };
  const s = await navigator.mediaDevices.getUserMedia({ video: true });
  const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
  const tr = pc1.addTransceiver(s.getVideoTracks()[0], { direction: 'sendonly' });
  const caps = RTCRtpSender.getCapabilities('video').codecs;
  const want = caps.filter((c) => c.mimeType === 'video/' + cfg.codec);
  if (!want.length) throw new Error('codec not available: ' + cfg.codec + ' (have ' + caps.map((c) => c.mimeType).join(',') + ')');
  tr.setCodecPreferences([...want, ...caps.filter((c) => c.mimeType === 'video/rtx')]);
  const v = document.getElementById('v');
  pc2.ontrack = (e) => { v.srcObject = new MediaStream([e.track]); };
  await pc1.setLocalDescription(); await pc2.setRemoteDescription(pc1.localDescription);
  await pc2.setLocalDescription(); await pc1.setRemoteDescription(pc2.localDescription);
  const p = tr.sender.getParameters();
  p.encodings[0].maxBitrate = cfg.kbps * 1000;
  if (cfg.scale > 1) p.encodings[0].scaleResolutionDownBy = cfg.scale;
  p.degradationPreference = cfg.degradation;
  await tr.sender.setParameters(p);
  await v.play().catch(() => {});
  const snap = async () => {
    const o = {};
    (await pc1.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') Object.assign(o, { bytes: r.bytesSent, fe: r.framesEncoded, qp: r.qpSum, enc: r.encoderImplementation, ql: r.qualityLimitationReason, w: r.frameWidth, h: r.frameHeight }); });
    (await pc2.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') Object.assign(o, { dec: r.decoderImplementation, fd: r.framesDecoded }); });
    return o;
  };
  let wraps = 0, prev = null, startStats = null;
  const rec = [];
  const t0 = performance.now();
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), cfg.timeoutMs);
    const cb = async (now, meta) => {
      let done = false;
      try {
        const vf = new VideoFrame(v, { timestamp: 0 });
        const fmt = vf.format;
        const W = vf.visibleRect.width, H = vf.visibleRect.height;
        const buf = new Uint8Array(vf.allocationSize());
        const layout = await vf.copyTo(buf);
        const full = vf.colorSpace && vf.colorSpace.fullRange === true;
        vf.close();
        const y = new Uint8Array(W * H);
        for (let r = 0; r < H; r++) y.set(buf.subarray(layout[0].offset + r * layout[0].stride, layout[0].offset + r * layout[0].stride + W), r * W);
        const bandH = Math.round(H * cfg.bandRows / (cfg.H + cfg.bandRows));
        const idx = (fmt === 'I420' || fmt === 'NV12' || fmt === 'I420A') ? decode(y, W, H, bandH) : null;
        if (idx !== null && idx < cfg.total) {
          if (prev !== null && idx + cfg.total / 2 < prev) {
            wraps++;
            if (wraps === 1) startStats = await snap();
          }
          prev = idx;
          if (wraps === 1) {
            // 기록 중에는 복사만 (전송은 끝나고) — 읽기가 밀려 프레임을 놓치지 않게
            const hImg = H - bandH;
            rec.push({ idx, w: W, h: hImg, full, img: y.slice(0, W * hImg) });
          }
          if (wraps >= 2) done = true;
        }
      } catch (e) { console.log('frame err ' + e.message); }
      if (done) { clearTimeout(timer); resolve('ok'); } else v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  });
  const endStats = await snap();
  pc1.close(); pc2.close(); s.getTracks().forEach((t) => t.stop());
  for (const f of rec) {
    let bin = '';
    for (let i = 0; i < f.img.length; i += 32768) bin += String.fromCharCode.apply(null, f.img.subarray(i, i + 32768));
    await window.__put(JSON.stringify({ idx: f.idx, w: f.w, h: f.h, full: f.full }), btoa(bin));
  }
  return { res, n: rec.length, startStats, endStats, seconds: (performance.now() - t0) / 1000 };
}`;

interface PageResult {
  res: string;
  n: number;
  startStats: Record<string, number | string> | null;
  endStats: Record<string, number | string>;
  seconds: number;
}

/** 원본(컬러, ISP 포함) 프레임 렌더 → 띠를 붙인 y4m (임시 파일) */
async function writeSourceY4m(
  seq: Sequence,
  opts: { jobs?: number; log?: (s: string) => void },
): Promise<{ y4m: string; i0: number; total: number; W: number; H: number }> {
  const log = opts.log ?? (() => {});
  const sc = seq.scenario;
  const [i0, i1] = codecRange(sc, CAMERA_FPS);
  const total = i1 - i0 + 1;
  const K = seq.streamAt(0);
  const W = K.width;
  const H = K.height;
  if ((W & 1) || (H & 1)) throw new Error("odd stream size");
  const t0 = Date.now();
  const planes = await renderSource(seq, i0, i1, opts.jobs ?? defaultJobs(), log);
  fs.mkdirSync(CODEC_DIR, { recursive: true });
  const y4m = path.join(os.tmpdir(), `bench-codec-${process.pid}-${sc.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}.y4m`);
  const fd = fs.openSync(y4m, "w");
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H + BAND_ROWS} F${CAMERA_FPS}:1 Ip A1:1 C420jpeg\n`);
  for (let i = i0; i <= i1; i++) {
    const p = planes.get(i);
    if (!p) throw new Error(`missing source frame ${i}`);
    const k = seq.streamAt(i / CAMERA_FPS);
    if (k.width !== W || k.height !== H) throw new Error(`${sc.id}: stream size changes (orientation) — codec capture not supported`);
    fs.writeSync(fd, "FRAME\n");
    fs.writeSync(fd, frameYuv(p, W, H, i - i0));
  }
  fs.closeSync(fd);
  planes.clear();
  log(`    원본 ${total}장 렌더·y4m ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { y4m, i0, total, W, H };
}

/** 한 번 캡처 (y4m → Chromium 루프백) */
async function captureOnce(
  seq: Sequence,
  src: { y4m: string; i0: number; total: number; W: number; H: number },
  log: (s: string) => void,
): Promise<{ frames: { i: number; img: GrayImage }[]; stats: CodecStats }> {
  const sc = seq.scenario;
  const spec = sc.realism!.codec!;
  const { y4m, i0, total, W, H } = src;
  const t0 = Date.now();
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${y4m}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  const frames: { i: number; img: GrayImage }[] = [];
  const seen = new Set<number>();
  const dims = new Set<string>();
  let fullRange = false;
  let res: PageResult;
  try {
    const page = await browser.newPage();
    await page.route("https://bench.test/", (rt) =>
      rt.fulfill({ body: "<video id=v autoplay muted playsinline style='width:160px'></video>", contentType: "text/html" }),
    );
    await page.goto("https://bench.test/");
    await page.exposeFunction("__put", (meta: string, b64: string) => {
      const m = JSON.parse(meta) as { idx: number; w: number; h: number; full: boolean };
      if (seen.has(m.idx)) return;
      seen.add(m.idx);
      if (m.full) fullRange = true;
      const y = Buffer.from(b64, "base64");
      dims.add(`${m.w}x${m.h}`);
      frames.push({ i: m.idx + i0, img: { width: m.w, height: m.h, data: new Uint8Array(y.buffer, y.byteOffset, y.length) } });
    });
    const cfg = {
      codec: spec.codec,
      kbps: spec.kbps,
      scale: spec.scaleDown ?? 1,
      degradation: spec.degradation ?? "maintain-resolution",
      W,
      H,
      bandRows: BAND_ROWS,
      total,
      timeoutMs: Math.round((3 * total) / CAMERA_FPS * 1000 + 20000),
    };
    res = (await page.evaluate(`(${PAGE_SCRIPT})(${JSON.stringify(cfg)})`)) as PageResult;
  } finally {
    await browser.close();
  }
  if (res.res !== "ok") throw new Error(`${sc.id}: codec capture ${res.res} (${frames.length} frames)`);
  if (fullRange) throw new Error(`${sc.id}: decoder returned full-range frames — 변환 규칙을 확인하세요`);
  const a = res.startStats ?? {};
  const b = res.endStats;
  const dt = (total / CAMERA_FPS);
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const fe = num(b.fe) - num(a.fe);
  const stats: CodecStats = {
    codec: spec.codec,
    encoder: String(b.enc ?? "?"),
    decoder: String(b.dec ?? "?"),
    kbps: Math.round(((num(b.bytes) - num(a.bytes)) * 8) / dt / 1000),
    qpMean: fe > 0 ? Math.round(((num(b.qp) - num(a.qp)) / fe) * 10) / 10 : null,
    sourceFrames: total,
    capturedFrames: frames.length,
    resolutions: [...dims],
    qualityLimitation: String(b.ql ?? "?"),
    framesDecoded: num(b.fd) - num(a.fd),
    attempts: 1,
    lowDelivery: false,
  };
  log(
    `    ${spec.codec} ${stats.encoder} ${stats.kbps}kbps QP ${stats.qpMean} 해상도 ${stats.resolutions.join(",")} — 받음 ${frames.length}/${total}장 (디코드 ${stats.framesDecoded}) (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  return { frames, stats };
}

/**
 * 시나리오 하나 캡처 → 캐시. 디코드된 프레임 중 읽어 온 비율이 CODEC_MIN_DELIVERY 미만이면(기계 부하로 읽기가 밀림)
 * 다시 뜨고(최대 3번), 끝내 미달이면 가장 나은 것. 인코더가 비트레이트 때문에 버린 프레임은 실제 현상이라 그대로 둔다.
 */
export async function captureCodec(seq: Sequence, opts: { jobs?: number; log?: (s: string) => void; keepY4m?: boolean } = {}): Promise<string> {
  const log = opts.log ?? (() => {});
  if (!seq.scenario.realism?.codec) throw new Error(`${seq.scenario.id}: not a codec scenario`);
  const src = await writeSourceY4m(seq, opts);
  let best: { frames: { i: number; img: GrayImage }[]; stats: CodecStats } | null = null;
  let attempts = 0;
  try {
    for (; attempts < 3; attempts++) {
      const r = await captureOnce(seq, src, log);
      if (!best || r.frames.length > best.frames.length) best = r;
      // 인코더가 버린 프레임(디코드 수에 안 잡힘)은 실제 현상이라 그대로 둔다. 디코드됐는데 우리가 못 읽은 프레임만 문제
      if (r.frames.length >= CODEC_MIN_DELIVERY * Math.max(1, r.stats.framesDecoded)) break;
      log(`    읽기 ${r.frames.length}/${r.stats.framesDecoded} (디코드 대비 ${((100 * r.frames.length) / Math.max(1, r.stats.framesDecoded)).toFixed(0)}%) < ${CODEC_MIN_DELIVERY * 100}% — 다시 뜸`);
    }
  } finally {
    if (!opts.keepY4m) fs.rmSync(src.y4m, { force: true });
  }
  const stats = { ...best!.stats, attempts: Math.min(3, attempts + 1), lowDelivery: best!.frames.length < CODEC_MIN_DELIVERY * Math.max(1, best!.stats.framesDecoded) };
  if (stats.lowDelivery) log(`    경고: 3번 모두 읽기 미달 — 가장 나은 캡처(${best!.frames.length}/디코드 ${stats.framesDecoded})를 씁니다`);
  return saveCodecCapture(seq.scenario.id, seq.codecKey, best!.frames, stats);
}

/** 코덱 시나리오 중 캡처가 없는 것만 캡처 (실시간이라 차례로). 반환: 새로 캡처한 수 */
export async function ensureCodecCaptures(scs: Scenario[], opts: { jobs?: number; log?: (s: string) => void } = {}): Promise<number> {
  const log = opts.log ?? (() => {});
  let n = 0;
  for (const sc of scs) {
    if (!sc.realism?.codec) continue;
    const seq = buildSequence(sc);
    if (seq.codec) continue;
    log(`코덱 캡처: ${sc.id} (${sc.realism.codec.codec} ${sc.realism.codec.kbps}kbps${sc.realism.codec.scaleDown ? ` ÷${sc.realism.codec.scaleDown}` : ""})`);
    let err: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await captureCodec(seq, opts);
        err = null;
        break;
      } catch (e) {
        err = e;
        log(`    실패 (${attempt + 1}/2): ${(e as Error).message}`);
      }
    }
    if (err) throw err;
    n++;
  }
  return n;
}

export { scenarioById };
