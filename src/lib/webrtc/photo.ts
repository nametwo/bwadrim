import type { DataLink } from "./data-link";

// 사진 찍기 (요구사항 CALL-16). 엔지니어가 누르면 고객 폰이 자기 카메라로 원본 사진을 찍어 보낸다.
// 영상(WebRTC)은 망 상태에 따라 화질이 떨어지지만, 고객 폰 안에서 찍은 사진은 명판·에러 코드 글자가 선명하다.
// 전용 DataChannel 'photo'(CallSession.photoLink)로 주고받는다 — 큰 사진 조각이 포인터·방향 지시를 막지 않게.
// 사진은 어디에도 올리지 않는다. 엔지니어 폰 메모리에만 있다가 통화를 끝낼 때 저장할지 묻는다.
//
// 메시지(JSON 문자열):
//   엔지니어 → 고객  { t: "photo-req", id }
//   고객 → 엔지니어  { t: "photo-chunk", id, i, n, d }  (d = JPEG base64 조각, 순서 보장 채널)
//                    { t: "photo-fail", id }

export type PhotoMsg =
  | { t: "photo-req"; id: string }
  | { t: "photo-chunk"; id: string; i: number; n: number; d: string }
  | { t: "photo-fail"; id: string };

/** base64 조각 크기(글자) */
const CHUNK = 16_000;
/** 받아들일 최대 조각 수 (약 16MB) */
const MAX_CHUNKS = 1000;
/** 긴 변 최대(px). 폰 원본(4000px 등)은 줄여서 보낸다 — 글자 읽기에 충분하고 전송이 빠르다 */
export const PHOTO_MAX_SIDE = 2560;
const JPEG_QUALITY = 0.9;
/** 요청 후 첫 조각까지 기다리는 시간, 조각 사이 최대 간격 */
const FIRST_CHUNK_MS = 12_000;
const IDLE_MS = 8_000;

export function parsePhotoMsg(v: unknown): PhotoMsg | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id || m.id.length > 64) return null;
  if (m.t === "photo-req") return { t: "photo-req", id: m.id };
  if (m.t === "photo-fail") return { t: "photo-fail", id: m.id };
  if (
    m.t === "photo-chunk" &&
    typeof m.i === "number" &&
    typeof m.n === "number" &&
    typeof m.d === "string" &&
    Number.isInteger(m.i) &&
    Number.isInteger(m.n) &&
    m.n >= 1 &&
    m.n <= MAX_CHUNKS &&
    m.i >= 0 &&
    m.i < m.n
  ) {
    return { t: "photo-chunk", id: m.id, i: m.i, n: m.n, d: m.d };
  }
  return null;
}

function parse(data: unknown): PhotoMsg | null {
  if (typeof data !== "string") return null;
  try {
    return parsePhotoMsg(JSON.parse(data));
  } catch {
    return null;
  }
}

/** ArrayBuffer → base64 (3바이트 배수로 잘라 이어 붙인다) */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const step = 3 * 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += step) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + step)));
  }
  return out;
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─────────────── 고객: 찍기 ───────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function toJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY));
}

function frameOf(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  return toJpeg(video, video.videoWidth, video.videoHeight);
}

/** 다음 영상 프레임(해상도를 바꾼 뒤 새 크기 프레임)이 올 때까지 */
function nextFrame(video: HTMLVideoElement, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    const t = setTimeout(done, ms);
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback(() => {
        clearTimeout(t);
        // 해상도가 바뀐 첫 프레임은 흐릴 수 있어 한 프레임 더
        v.requestVideoFrameCallback!(() => done());
      });
    }
  });
}

/**
 * 고객 폰에서 사진 한 장을 찍는다.
 * 1) 사진 촬영 기능(ImageCapture.takePhoto, 안드로이드 크롬)이 있으면 카메라 원본으로
 * 2) 없으면(아이폰 등) 찍는 순간만 카메라 해상도를 올렸다가 한 장 뜨고 되돌린다
 * 3) 그것도 안 되면 지금 화면(영상 프레임) 그대로
 */
export async function capturePhoto(video: HTMLVideoElement | null, track: MediaStreamTrack | null): Promise<Blob | null> {
  if (!video) return null;
  const live = track && track.readyState === "live" ? track : null;

  const IC = (globalThis as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
  if (live && IC) {
    try {
      const raw = await withTimeout(new IC(live).takePhoto(), 5000);
      const bmp = await createImageBitmap(raw);
      const jpeg = await toJpeg(bmp, bmp.width, bmp.height);
      bmp.close();
      if (jpeg) return jpeg;
    } catch {
      // 지원하지 않거나 실패 — 아래 방법으로
    }
  }

  if (live && typeof live.applyConstraints === "function") {
    const before = live.getConstraints();
    const w = video.videoWidth;
    try {
      await withTimeout(live.applyConstraints({ ...before, width: { ideal: 1920 }, height: { ideal: 1440 } }), 2500);
      if (video.videoWidth !== w) await nextFrame(video, 1200);
      else await nextFrame(video, 400);
      const jpeg = await frameOf(video);
      if (jpeg) return jpeg;
    } catch {
      // 해상도를 못 바꾸는 폰 — 지금 화면으로
    } finally {
      live.applyConstraints(before).catch(() => {});
    }
  }

  return frameOf(video);
}

/**
 * 고객: 엔지니어의 사진 요청을 받아 찍어 보낸다. 요청은 한 번에 하나씩 차례로.
 * onRequest는 찍기 시작할 때 부른다(고객 화면 '기사님이 사진을 찍었어요'). 반환값은 해제 함수.
 */
export function servePhotos(
  link: DataLink,
  capture: () => Promise<Blob | null>,
  onRequest?: () => void,
): () => void {
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  const off = link.onMessage((data) => {
    const msg = parse(data);
    if (!msg || msg.t !== "photo-req") return;
    const { id } = msg;
    chain = chain.then(async () => {
      if (disposed) return;
      onRequest?.();
      let blob: Blob | null = null;
      try {
        blob = await capture();
      } catch {
        blob = null;
      }
      if (disposed) return;
      if (!blob) {
        link.send(JSON.stringify({ t: "photo-fail", id }));
        return;
      }
      const b64 = toBase64(await blob.arrayBuffer());
      const n = Math.ceil(b64.length / CHUNK);
      if (n > MAX_CHUNKS) {
        link.send(JSON.stringify({ t: "photo-fail", id }));
        return;
      }
      for (let i = 0; i < n; i++) {
        const d = b64.slice(i * CHUNK, (i + 1) * CHUNK);
        if (!link.send(JSON.stringify({ t: "photo-chunk", id, i, n, d }))) {
          link.send(JSON.stringify({ t: "photo-fail", id }));
          return;
        }
      }
    });
  });
  return () => {
    disposed = true;
    off();
  };
}

// ─────────────── 엔지니어: 요청하고 받기 ───────────────

export class PhotoError extends Error {
  constructor(public reason: "closed" | "failed" | "timeout") {
    super(reason);
  }
}

type Pending = {
  parts: string[] | null;
  got: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (b: Blob) => void;
  reject: (e: PhotoError) => void;
};

/** 엔지니어: 사진을 요청하고 조각을 모아 JPEG Blob으로 돌려준다 */
export class PhotoRequester {
  private pending = new Map<string, Pending>();
  private readonly off: () => void;
  private readonly offOpen: () => void;

  constructor(private readonly link: DataLink) {
    this.off = link.onMessage((data) => this.receive(data));
    // 연결이 끊기면 기다리던 요청은 실패로 끝낸다 (재연결 뒤 고객 쪽은 새 채널이라 답이 오지 않는다)
    this.offOpen = link.onOpenChange((open) => {
      if (!open) this.failAll("closed");
    });
  }

  /** 연결이 열려 있으면 요청을 보내고 사진을 기다린다 */
  request(): Promise<Blob> {
    const id = crypto.randomUUID();
    return new Promise<Blob>((resolve, reject) => {
      if (!this.link.isOpen() || !this.link.send(JSON.stringify({ t: "photo-req", id }))) {
        reject(new PhotoError("closed"));
        return;
      }
      const p: Pending = {
        parts: null,
        got: 0,
        timer: setTimeout(() => this.finish(id, new PhotoError("timeout")), FIRST_CHUNK_MS),
        resolve,
        reject,
      };
      this.pending.set(id, p);
    });
  }

  dispose() {
    this.off();
    this.offOpen();
    this.failAll("closed");
  }

  private failAll(reason: PhotoError["reason"]) {
    for (const id of [...this.pending.keys()]) this.finish(id, new PhotoError(reason));
  }

  private finish(id: string, result: Blob | PhotoError) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (result instanceof PhotoError) p.reject(result);
    else p.resolve(result);
  }

  private receive(data: unknown) {
    const msg = parse(data);
    if (!msg || msg.t === "photo-req") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.t === "photo-fail") {
      this.finish(msg.id, new PhotoError("failed"));
      return;
    }
    if (!p.parts) p.parts = new Array(msg.n);
    if (p.parts.length !== msg.n || p.parts[msg.i] !== undefined) return;
    p.parts[msg.i] = msg.d;
    p.got++;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.finish(msg.id, new PhotoError("timeout")), IDLE_MS);
    if (p.got < msg.n) return;
    try {
      const bytes = fromBase64(p.parts.join(""));
      this.finish(msg.id, new Blob([bytes], { type: "image/jpeg" }));
    } catch {
      this.finish(msg.id, new PhotoError("failed"));
    }
  }
}
