import type { LinkData } from "@/lib/webrtc/data-link";
import type { AnchorDescriptor, Annotation, Point, Rect, TrackState } from "./types";

// DataChannel('draw') 추적 프로토콜 (README "DataChannel 프로토콜").
//
//   엔지니어→고객  {"t":"anchor","anchor":AnchorDescriptor,"img":{"bytes":N,"mime":"image/jpeg","width":W,"height":H}}
//                  직후 바이너리 조각 ⌈N/16000⌉개 (각 조각 = 8바이트 헤더 + 최대 16000바이트)
//   엔지니어→고객  {"t":"ann","anchorId":id,"ann":Annotation}
//   엔지니어→고객  {"t":"clear"}
//   고객→엔지니어  {"t":"status","anchorId":id,"state":TrackState}
//
// 바이너리 조각 헤더 (8바이트, big-endian):
//   [0] 0xBD 매직  [1] 버전(1)  [2..3] 전송 태그 = anchor.id의 16비트 해시
//   [4..5] 조각 번호(0부터)  [6..7] 조각 개수
// 태그로 이전(버려진) 전송의 조각을 걸러내고, 번호로 순서가 뒤바뀐 조각도 제자리에 모은다.
//
// 수신측은 모든 것을 엄격히 검증하고, 한도를 넘거나 형식이 틀리면 조용히 버린다 (예외 없음).
// 검증을 통과한 값은 입력 객체를 그대로 쓰지 않고 필요한 필드만 새 객체로 복사한다.

export const PROTOCOL_LIMITS = {
  /** 기준 이미지 최대 바이트 */
  maxImageBytes: 512 * 1024,
  /** 앵커당 주석 최대 개수 */
  maxAnnotations: 50,
  /** 선 하나의 점 최대 개수 */
  maxStrokePoints: 500,
  /** 선 하나의 점 최소 개수 */
  minStrokePoints: 2,
  /** id 최대 길이 */
  maxIdLength: 64,
  /** norm 좌표 허용 범위 */
  coordMin: -0.5,
  coordMax: 1.5,
  /** ref·이미지 한 변 최대 px */
  maxDimension: 4096,
  /** ref 한 변 최소 px */
  minDimension: 8,
  /** 텍스트 메시지 최대 길이 (JSON.parse 전에 거른다) */
  maxTextLength: 256 * 1024,
} as const;

export const CHUNK_PAYLOAD_BYTES = 16000;
export const CHUNK_HEADER_BYTES = 8;
const CHUNK_MAGIC = 0xbd;
const CHUNK_VERSION = 1;
/** 보내는 쪽: 앵커 헤더 JSON 예산. 넘치는 주석은 조각 뒤에 ann 메시지로 보낸다 (작은 max-message-size 대비) */
export const ANCHOR_HEADER_BUDGET = 48 * 1024;
/** 조각이 이 시간 동안 안 오면 전송을 버린다 */
export const TRANSFER_TIMEOUT_MS = 15000;

export const TRACK_STATES: readonly TrackState[] = ["searching", "tracking", "weak", "lost"];

export interface ImageMeta {
  bytes: number;
  mime: "image/jpeg";
  width: number;
  height: number;
}

export interface AnchorMessage {
  t: "anchor";
  anchor: AnchorDescriptor;
  img: ImageMeta;
}

export interface AnnMessage {
  t: "ann";
  anchorId: string;
  ann: Annotation;
}

export interface ClearMessage {
  t: "clear";
}

export interface StatusMessage {
  t: "status";
  anchorId: string;
  state: TrackState;
}

export type ProtocolMessage = AnchorMessage | AnnMessage | ClearMessage | StatusMessage;

// ───────────────────────── 검증 ─────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isCoord(v: unknown): v is number {
  return isNum(v) && v >= PROTOCOL_LIMITS.coordMin && v <= PROTOCOL_LIMITS.coordMax;
}

function isIntIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

export function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= PROTOCOL_LIMITS.maxIdLength;
}

export function isTrackState(v: unknown): v is TrackState {
  return typeof v === "string" && (TRACK_STATES as readonly string[]).includes(v);
}

export function validatePoint(v: unknown): Point | null {
  if (!isObj(v)) return null;
  const { x, y } = v;
  if (!isCoord(x) || !isCoord(y)) return null;
  return { x, y };
}

export function validateAnnotation(v: unknown): Annotation | null {
  if (!isObj(v) || !isValidId(v.id)) return null;
  const id = v.id;
  if (v.kind === "pin") {
    const p = validatePoint(v.p);
    return p ? { id, kind: "pin", p } : null;
  }
  if (v.kind === "stroke") {
    const pts = v.points;
    if (
      !Array.isArray(pts) ||
      pts.length < PROTOCOL_LIMITS.minStrokePoints ||
      pts.length > PROTOCOL_LIMITS.maxStrokePoints
    ) {
      return null;
    }
    const points: Point[] = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const p = validatePoint(pts[i]);
      if (!p) return null;
      points[i] = p;
    }
    return { id, kind: "stroke", points };
  }
  return null;
}

/** norm 좌표 ROI. 넓이 > 0, 네 변 모두 [-0.5, 1.5] 안 */
export function validateRoi(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const { x, y, width, height } = v;
  if (!isCoord(x) || !isCoord(y) || !isNum(width) || !isNum(height)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  if (!isCoord(x + width) || !isCoord(y + height)) return null;
  return { x, y, width, height };
}

export function validateAnchorDescriptor(v: unknown): AnchorDescriptor | null {
  if (!isObj(v) || !isValidId(v.id)) return null;
  const { refWidth, refHeight } = v;
  const { minDimension: lo, maxDimension: hi } = PROTOCOL_LIMITS;
  if (!isIntIn(refWidth, lo, hi) || !isIntIn(refHeight, lo, hi)) return null;
  const roi = validateRoi(v.roi);
  if (!roi) return null;
  const list = v.annotations;
  if (!Array.isArray(list) || list.length > PROTOCOL_LIMITS.maxAnnotations) return null;
  const annotations: Annotation[] = [];
  const ids = new Set<string>();
  for (const item of list) {
    const a = validateAnnotation(item);
    if (!a || ids.has(a.id)) return null;
    ids.add(a.id);
    annotations.push(a);
  }
  return { id: v.id, refWidth, refHeight, roi, annotations };
}

/** ref가 있으면 이미지 비율이 ref 비율과 2% 안에서 맞아야 한다 */
export function validateImageMeta(
  v: unknown,
  ref?: { refWidth: number; refHeight: number },
): ImageMeta | null {
  if (!isObj(v)) return null;
  const { bytes, mime, width, height } = v;
  if (!isIntIn(bytes, 1, PROTOCOL_LIMITS.maxImageBytes)) return null;
  if (mime !== "image/jpeg") return null;
  const hi = PROTOCOL_LIMITS.maxDimension;
  if (!isIntIn(width, 1, hi) || !isIntIn(height, 1, hi)) return null;
  if (ref) {
    const a = width / height;
    const b = ref.refWidth / ref.refHeight;
    if (Math.abs(a / b - 1) > 0.02) return null;
  }
  return { bytes, mime, width, height };
}

/** 이미 JSON.parse된 값 → 검증된 메시지 (새 객체). 모르는 t나 형식 오류면 null */
export function validateMessage(v: unknown): ProtocolMessage | null {
  if (!isObj(v)) return null;
  switch (v.t) {
    case "anchor": {
      const anchor = validateAnchorDescriptor(v.anchor);
      if (!anchor) return null;
      const img = validateImageMeta(v.img, anchor);
      return img ? { t: "anchor", anchor, img } : null;
    }
    case "ann": {
      if (!isValidId(v.anchorId)) return null;
      const ann = validateAnnotation(v.ann);
      return ann ? { t: "ann", anchorId: v.anchorId, ann } : null;
    }
    case "clear":
      return { t: "clear" };
    case "status":
      if (!isValidId(v.anchorId) || !isTrackState(v.state)) return null;
      return { t: "status", anchorId: v.anchorId, state: v.state };
    default:
      return null;
  }
}

/** 텍스트 메시지 파싱 + 검증. 절대 throw하지 않는다 */
export function parseMessage(text: string): ProtocolMessage | null {
  if (typeof text !== "string" || text.length === 0 || text.length > PROTOCOL_LIMITS.maxTextLength) {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  return validateMessage(v);
}

// ───────────────────────── 인코딩 ─────────────────────────

/** norm 좌표 양자화 (1e-4 = 작업 해상도에서 0.03px). 보내는 쪽이 주석을 만들 때 적용해 양쪽 값을 같게 한다 */
export function quantizeNorm(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export function quantizePoint(p: Point): Point {
  return { x: quantizeNorm(p.x), y: quantizeNorm(p.y) };
}

export function encodeMessage(msg: ProtocolMessage): string {
  return JSON.stringify(msg);
}

/** 전송 태그: anchor id의 FNV-1a 32비트 해시를 16비트로 접는다 */
export function transferTag(anchorId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < anchorId.length; i++) {
    h ^= anchorId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
}

export function chunkCount(bytes: number): number {
  return Math.ceil(bytes / CHUNK_PAYLOAD_BYTES);
}

/** 이미지 바이트 → 바이너리 조각들 (각각 독립 ArrayBuffer) */
export function encodeChunks(anchorId: string, data: Uint8Array): ArrayBuffer[] {
  const n = chunkCount(data.length);
  if (n > 0xffff) throw new RangeError("image too large for chunking");
  const tag = transferTag(anchorId);
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * CHUNK_PAYLOAD_BYTES;
    const end = Math.min(data.length, start + CHUNK_PAYLOAD_BYTES);
    const buf = new ArrayBuffer(CHUNK_HEADER_BYTES + end - start);
    const dv = new DataView(buf);
    dv.setUint8(0, CHUNK_MAGIC);
    dv.setUint8(1, CHUNK_VERSION);
    dv.setUint16(2, tag);
    dv.setUint16(4, i);
    dv.setUint16(6, n);
    new Uint8Array(buf, CHUNK_HEADER_BYTES).set(data.subarray(start, end));
    out.push(buf);
  }
  return out;
}

export interface ChunkHeader {
  tag: number;
  index: number;
  count: number;
  /** 페이로드 길이 (헤더 제외) */
  length: number;
}

/** 조각 헤더 읽기. 형식이 틀리면 null */
export function readChunkHeader(buf: ArrayBuffer): ChunkHeader | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength <= CHUNK_HEADER_BYTES) return null;
  if (buf.byteLength > CHUNK_HEADER_BYTES + CHUNK_PAYLOAD_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== CHUNK_MAGIC || dv.getUint8(1) !== CHUNK_VERSION) return null;
  const tag = dv.getUint16(2);
  const index = dv.getUint16(4);
  const count = dv.getUint16(6);
  if (count === 0 || index >= count) return null;
  return { tag, index, count, length: buf.byteLength - CHUNK_HEADER_BYTES };
}

export interface ImagePayload {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * 앵커 전송 한 벌: 헤더(JSON) → 조각들 → (헤더 예산을 넘친 주석들의) ann 메시지.
 * 한도를 넘는 입력은 RangeError (보내는 쪽 버그).
 */
export function encodeAnchorTransfer(
  anchor: AnchorDescriptor,
  image: ImagePayload,
  headerBudget = ANCHOR_HEADER_BUDGET,
): LinkData[] {
  const n = image.bytes.length;
  if (n < 1 || n > PROTOCOL_LIMITS.maxImageBytes) {
    throw new RangeError(`reference image ${n} bytes out of range`);
  }
  if (anchor.annotations.length > PROTOCOL_LIMITS.maxAnnotations) {
    throw new RangeError("too many annotations");
  }
  const img: ImageMeta = { bytes: n, mime: "image/jpeg", width: image.width, height: image.height };
  const bare: AnchorDescriptor = { ...anchor, annotations: [] };
  let used = encodeMessage({ t: "anchor", anchor: bare, img }).length;
  const head: Annotation[] = [];
  const rest: Annotation[] = [];
  for (const a of anchor.annotations) {
    const len = JSON.stringify(a).length + 1;
    if (rest.length === 0 && used + len <= headerBudget) {
      head.push(a);
      used += len;
    } else {
      rest.push(a);
    }
  }
  const out: LinkData[] = [encodeMessage({ t: "anchor", anchor: { ...bare, annotations: head }, img })];
  for (const c of encodeChunks(anchor.id, image.bytes)) out.push(c);
  for (const a of rest) out.push(encodeMessage({ t: "ann", anchorId: anchor.id, ann: a }));
  return out;
}

// ───────────────────────── 수신 ─────────────────────────

/** 조각 모음 (한 번에 전송 하나) */
class ChunkAssembly {
  readonly tag: number;
  readonly count: number;
  readonly total: number;
  readonly data: Uint8Array;
  private got: Uint8Array;
  private received = 0;
  lastActivity: number;

  constructor(anchorId: string, total: number, now: number) {
    this.tag = transferTag(anchorId);
    this.total = total;
    this.count = chunkCount(total);
    this.data = new Uint8Array(total);
    this.got = new Uint8Array(this.count);
    this.lastActivity = now;
  }

  /** "done" | "progress" | "ignored" */
  push(h: ChunkHeader, buf: ArrayBuffer, now: number): "done" | "progress" | "ignored" {
    if (h.tag !== this.tag || h.count !== this.count || this.got[h.index]) return "ignored";
    const expected =
      h.index < this.count - 1 ? CHUNK_PAYLOAD_BYTES : this.total - CHUNK_PAYLOAD_BYTES * (this.count - 1);
    if (h.length !== expected) return "ignored";
    this.data.set(new Uint8Array(buf, CHUNK_HEADER_BYTES, h.length), h.index * CHUNK_PAYLOAD_BYTES);
    this.got[h.index] = 1;
    this.received++;
    this.lastActivity = now;
    return this.received === this.count ? "done" : "progress";
  }
}

export interface ReceivedAnchor {
  anchor: AnchorDescriptor;
  img: ImageMeta;
  /** JPEG 바이트 (독립 버퍼) */
  bytes: Uint8Array;
}

export interface ReceiverHandlers {
  /** 앵커 헤더 + 이미지 조각이 모두 도착 */
  onAnchor?(r: ReceivedAnchor): void;
  /** 앵커 헤더 도착 (이미지 수신 시작) */
  onAnchorPending?(anchor: AnchorDescriptor, img: ImageMeta): void;
  /** 현재 앵커에 주석 추가 (중복·한도 검사 후) */
  onAnn?(anchorId: string, ann: Annotation): void;
  onClear?(): void;
  onStatus?(anchorId: string, state: TrackState): void;
  /** 버린 메시지·전송 (디버그용) */
  onDrop?(reason: string): void;
}

export interface ReceiverOptions {
  /** customer: anchor·ann·clear만 받음 / engineer: status만 받음 */
  role: "customer" | "engineer";
  transferTimeoutMs?: number;
  now?: () => number;
}

interface PendingTransfer {
  anchor: AnchorDescriptor;
  img: ImageMeta;
  ids: Set<string>;
  assembly: ChunkAssembly;
}

/**
 * 링크에서 받은 원시 데이터를 검증된 이벤트로 바꾼다.
 * - 새 anchor 헤더는 진행 중이던 이전 전송을 버린다 (clear도 마찬가지)
 * - 조각은 태그·번호·길이를 검사해 순서와 무관하게 모으고, 중복·쓰레기는 무시
 * - 전송 중에 온 같은 앵커의 ann은 대기 중인 앵커에 붙였다가 완료 때 함께 넘긴다
 * - 조각이 transferTimeoutMs 동안 안 오면 전송을 버린다 (다음 수신 때 판정)
 */
export class ProtocolReceiver {
  private pending: PendingTransfer | null = null;
  private current: { id: string; ids: Set<string> } | null = null;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly handlers: ReceiverHandlers,
    private readonly opts: ReceiverOptions,
  ) {
    this.timeoutMs = opts.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 완료된 현재 앵커 id (customer) */
  currentAnchorId(): string | null {
    return this.current?.id ?? null;
  }

  /** 이미지 수신 중인지 */
  isReceiving(): boolean {
    return this.pending !== null;
  }

  /** 진행 중 전송만 버린다 (링크 재연결 등) */
  abortTransfer(reason = "aborted"): void {
    if (this.pending) {
      this.pending = null;
      this.drop(reason);
    }
  }

  /** 모두 잊는다 */
  reset(): void {
    this.pending = null;
    this.current = null;
  }

  receive(data: LinkData): void {
    try {
      this.expire();
      if (typeof data === "string") this.receiveText(data);
      else if (data instanceof ArrayBuffer) this.receiveChunk(data);
      else this.drop("unknown-data");
    } catch (e) {
      // 핸들러 오류가 링크 루프로 새지 않게
      console.warn("[protocol] 수신 처리 오류:", e);
    }
  }

  private drop(reason: string) {
    this.handlers.onDrop?.(reason);
  }

  private expire() {
    const p = this.pending;
    if (p && this.now() - p.assembly.lastActivity > this.timeoutMs) {
      this.pending = null;
      this.drop("transfer-timeout");
    }
  }

  private receiveText(text: string) {
    const msg = parseMessage(text);
    if (!msg) {
      this.drop("invalid-message");
      return;
    }
    if (this.opts.role === "engineer") {
      if (msg.t === "status") this.handlers.onStatus?.(msg.anchorId, msg.state);
      else this.drop(`unexpected-${msg.t}`);
      return;
    }
    switch (msg.t) {
      case "anchor": {
        if (this.pending) this.drop("transfer-superseded");
        const ids = new Set(msg.anchor.annotations.map((a) => a.id));
        this.pending = {
          anchor: msg.anchor,
          img: msg.img,
          ids,
          assembly: new ChunkAssembly(msg.anchor.id, msg.img.bytes, this.now()),
        };
        this.handlers.onAnchorPending?.(msg.anchor, msg.img);
        return;
      }
      case "ann": {
        const p = this.pending;
        if (p && p.anchor.id === msg.anchorId) {
          if (p.ids.has(msg.ann.id) || p.ids.size >= PROTOCOL_LIMITS.maxAnnotations) {
            this.drop("ann-rejected");
            return;
          }
          p.ids.add(msg.ann.id);
          p.anchor = { ...p.anchor, annotations: [...p.anchor.annotations, msg.ann] };
          return;
        }
        const c = this.current;
        if (!c || c.id !== msg.anchorId) {
          this.drop("ann-unknown-anchor");
          return;
        }
        if (c.ids.has(msg.ann.id) || c.ids.size >= PROTOCOL_LIMITS.maxAnnotations) {
          this.drop("ann-rejected");
          return;
        }
        c.ids.add(msg.ann.id);
        this.handlers.onAnn?.(msg.anchorId, msg.ann);
        return;
      }
      case "clear":
        this.pending = null;
        this.current = null;
        this.handlers.onClear?.();
        return;
      case "status":
        this.drop("unexpected-status");
        return;
    }
  }

  private receiveChunk(buf: ArrayBuffer) {
    if (this.opts.role !== "customer") {
      this.drop("unexpected-binary");
      return;
    }
    const h = readChunkHeader(buf);
    const p = this.pending;
    if (!h || !p) {
      this.drop(h ? "chunk-without-transfer" : "invalid-chunk");
      return;
    }
    const r = p.assembly.push(h, buf, this.now());
    if (r === "ignored") {
      this.drop("chunk-rejected");
      return;
    }
    if (r === "done") {
      this.pending = null;
      this.current = { id: p.anchor.id, ids: p.ids };
      this.handlers.onAnchor?.({ anchor: p.anchor, img: p.img, bytes: p.assembly.data });
    }
  }
}
