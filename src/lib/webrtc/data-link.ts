// 상위 계층(추적 프로토콜 등)이 RTCDataChannel을 직접 만지지 않게 하는 얇은 전송 인터페이스.
// 미디어 계층 격리 원칙(CLAUDE.md): RTCDataChannel은 src/lib/webrtc 밖으로 새지 않는다.
//
// - 순서 보장·신뢰 채널을 가정한다 ('draw' 채널 기본값).
// - 큰 전송(기준 이미지 조각)은 bufferedAmount 기반 역압(backpressure)으로 내부 큐에 쌓았다가
//   bufferedamountlow 이벤트에 맞춰 흘려보낸다. 한 번 큐에 들어가면 이후 메시지도 큐 뒤로 (순서 유지).
// - 채널이 늦게 열려도 되고(connecting), 재연결 때 새 채널로 교체할 수 있다(attach).
// - 닫혀 있을 때 send는 false — 메시지를 쌓아 두지 않는다. 다시 열리면 상위 계층이 onOpenChange로 재동기화한다.

export type LinkData = string | ArrayBuffer;

export interface DataLink {
  /** 전송했거나 순서 보장 큐에 넣었으면 true. 닫혀 있거나 큐가 넘치면 false (버림) */
  send(data: LinkData): boolean;
  /** 수신 콜백 등록. 반환값은 해제 함수 */
  onMessage(cb: (data: LinkData) => void): () => void;
  /** 열림/닫힘 변화 콜백 등록 (값이 실제로 바뀔 때만). 반환값은 해제 함수 */
  onOpenChange(cb: (open: boolean) => void): () => void;
  isOpen(): boolean;
  /** 아직 나가지 않은 바이트 (채널 버퍼 + 내부 큐) */
  bufferedAmount(): number;
}

/** RTCDataChannel에서 실제로 쓰는 부분만 (테스트에서 가짜 채널을 넣기 위함) */
export type DataChannelLike = Pick<
  RTCDataChannel,
  | "readyState"
  | "bufferedAmount"
  | "bufferedAmountLowThreshold"
  | "binaryType"
  | "addEventListener"
  | "removeEventListener"
> & { send(data: string | ArrayBuffer): void };

export interface ChannelLinkOptions {
  /** 채널 버퍼가 이 이상이면 내부 큐에 쌓는다 (기본 256KB) */
  highWaterMark?: number;
  /** bufferedAmountLowThreshold (기본 64KB) */
  lowWaterMark?: number;
  /** 내부 큐 상한. 넘으면 send가 false (기본 4MB) */
  maxQueueBytes?: number;
  /** bufferedamountlow가 안 오는 브라우저 대비 폴링 간격 ms (기본 100) */
  pollMs?: number;
}

export interface ChannelDataLink extends DataLink {
  /** 채널 연결·교체(재연결). null이면 분리. 이전 채널은 닫지 않는다 (소유자는 CallSession) */
  attach(dc: RTCDataChannel | DataChannelLike | null): void;
  /** 리스너·큐·타이머 정리. 채널은 닫지 않는다 */
  dispose(): void;
}

const DEFAULTS = {
  highWaterMark: 256 * 1024,
  lowWaterMark: 64 * 1024,
  maxQueueBytes: 4 * 1024 * 1024,
  pollMs: 100,
};

function byteSize(data: LinkData): number {
  // 문자열은 UTF-8 길이 근사(대부분 ASCII JSON) — 역압 판단용이라 정확할 필요 없다
  return typeof data === "string" ? data.length : data.byteLength;
}

class RTCChannelLink implements ChannelDataLink {
  private dc: DataChannelLike | null = null;
  private queue: LinkData[] = [];
  private queueHead = 0;
  private queuedBytes = 0;
  private open = false;
  private disposed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Blob 수신(드묾)을 순서대로 넘기기 위한 체인 */
  private chain: Promise<void> | null = null;
  private readonly msgCbs = new Set<(data: LinkData) => void>();
  private readonly openCbs = new Set<(open: boolean) => void>();
  private readonly opts: Required<ChannelLinkOptions>;

  constructor(dc: RTCDataChannel | DataChannelLike | null, opts?: ChannelLinkOptions) {
    this.opts = { ...DEFAULTS, ...opts };
    if (dc) this.attach(dc);
  }

  attach(dc: RTCDataChannel | DataChannelLike | null): void {
    if (this.disposed) return;
    const next = dc as DataChannelLike | null;
    if (next === this.dc) return;
    this.detach();
    if (!next) return;
    this.dc = next;
    try {
      next.binaryType = "arraybuffer";
      next.bufferedAmountLowThreshold = this.opts.lowWaterMark;
    } catch {
      // 일부 구현은 닫힌 채널에서 설정 불가 — 무시
    }
    next.addEventListener("open", this.handleOpen);
    next.addEventListener("close", this.handleClose);
    next.addEventListener("closing", this.handleClose);
    next.addEventListener("error", this.handleError);
    next.addEventListener("message", this.handleMessage);
    next.addEventListener("bufferedamountlow", this.handleLow);
    this.setOpen(next.readyState === "open");
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.msgCbs.clear();
    this.openCbs.clear();
  }

  send(data: LinkData): boolean {
    const dc = this.dc;
    if (!dc || !this.open || dc.readyState !== "open") return false;
    const size = byteSize(data);
    const buffered = dc.bufferedAmount;
    // 버퍼가 비어 있으면 크기와 무관하게 바로 보낸다 (큐는 순서 유지용일 뿐)
    if (this.queueLength() === 0 && (buffered === 0 || buffered + size <= this.opts.highWaterMark)) {
      try {
        dc.send(data);
        return true;
      } catch (e) {
        // 메시지 과대·경합으로 닫힘 등 — 버린다
        console.warn("[data-link] send 실패:", e);
        return false;
      }
    }
    if (this.queuedBytes + size > this.opts.maxQueueBytes) return false;
    this.queue.push(data);
    this.queuedBytes += size;
    // 채널 버퍼에 이미 자리가 있으면 폴링을 기다리지 않고 바로 흘려보낸다 (순서는 큐가 지킨다)
    this.flush();
    return true;
  }

  onMessage(cb: (data: LinkData) => void): () => void {
    this.msgCbs.add(cb);
    return () => {
      this.msgCbs.delete(cb);
    };
  }

  onOpenChange(cb: (open: boolean) => void): () => void {
    this.openCbs.add(cb);
    return () => {
      this.openCbs.delete(cb);
    };
  }

  isOpen(): boolean {
    return this.open && this.dc?.readyState === "open";
  }

  bufferedAmount(): number {
    let n = this.queuedBytes;
    try {
      n += this.dc?.bufferedAmount ?? 0;
    } catch {
      // 무시
    }
    return n;
  }

  // ───────────────────────── 내부 ─────────────────────────

  private queueLength(): number {
    return this.queue.length - this.queueHead;
  }

  private detach() {
    const dc = this.dc;
    if (dc) {
      dc.removeEventListener("open", this.handleOpen);
      dc.removeEventListener("close", this.handleClose);
      dc.removeEventListener("closing", this.handleClose);
      dc.removeEventListener("error", this.handleError);
      dc.removeEventListener("message", this.handleMessage);
      dc.removeEventListener("bufferedamountlow", this.handleLow);
    }
    this.dc = null;
    this.dropQueue();
    this.chain = null;
    this.setOpen(false);
  }

  private dropQueue() {
    this.queue = [];
    this.queueHead = 0;
    this.queuedBytes = 0;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private setOpen(open: boolean) {
    if (open === this.open) return;
    this.open = open;
    for (const cb of [...this.openCbs]) {
      try {
        cb(open);
      } catch (e) {
        console.warn("[data-link] onOpenChange 콜백 오류:", e);
      }
    }
  }

  private emit(data: LinkData) {
    for (const cb of [...this.msgCbs]) {
      try {
        cb(data);
      } catch (e) {
        console.warn("[data-link] onMessage 콜백 오류:", e);
      }
    }
  }

  private flush() {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") {
      this.dropQueue();
      return;
    }
    while (this.queueLength() > 0) {
      const next = this.queue[this.queueHead];
      const size = byteSize(next);
      // 버퍼가 비어 있으면 크기와 무관하게 하나는 보낸다 (고착 방지)
      const buffered = dc.bufferedAmount;
      if (buffered > 0 && buffered + size > this.opts.highWaterMark) break;
      try {
        dc.send(next);
      } catch (e) {
        console.warn("[data-link] 큐 전송 실패, 큐 폐기:", e);
        this.dropQueue();
        return;
      }
      this.queueHead++;
      this.queuedBytes -= size;
    }
    if (this.queueLength() === 0) {
      this.queue = [];
      this.queueHead = 0;
      this.queuedBytes = 0;
    } else if (this.queueHead > 64) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
    this.schedulePoll();
  }

  private schedulePoll() {
    if (this.pollTimer !== null || this.queueLength() === 0) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.flush();
    }, this.opts.pollMs);
  }

  private handleOpen = () => {
    this.setOpen(this.dc?.readyState === "open");
  };

  private handleClose = () => {
    this.dropQueue();
    this.setOpen(false);
  };

  private handleError = (e: Event) => {
    const err = (e as { error?: { message?: unknown } }).error;
    // pc.close()·채널 close()로 닫을 때 Chrome이 보내는 "User-Initiated Abort"는 정상 종료 — 경고하지 않는다
    const benign = typeof err?.message === "string" && /User-Initiated Abort/i.test(err.message);
    if (!benign) console.warn("[data-link] 채널 오류:", err ?? e);
    if (this.dc?.readyState !== "open") this.handleClose();
  };

  private handleLow = () => {
    this.flush();
  };

  private handleMessage = (e: Event) => {
    const d = (e as MessageEvent).data as unknown;
    let item: LinkData | Promise<ArrayBuffer>;
    if (typeof d === "string" || d instanceof ArrayBuffer) {
      item = d;
    } else if (ArrayBuffer.isView(d)) {
      const copy = new Uint8Array(d.byteLength);
      copy.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      item = copy.buffer;
    } else if (typeof Blob !== "undefined" && d instanceof Blob) {
      // binaryType 설정 전에 도착한 경우 등 — 비동기 변환. 읽기는 바로 시작하고 넘기는 순서만 지킨다
      item = d.arrayBuffer();
    } else {
      return;
    }
    if (!this.chain && !(item instanceof Promise)) {
      this.emit(item);
      return;
    }
    // 앞선 비동기 변환이 끝날 때까지 모든 메시지를 체인 뒤로 (순서 보장). 체인이 비면 다시 동기로 넘긴다
    const dc = this.dc;
    const pending = item;
    const p: Promise<void> = (this.chain ?? Promise.resolve())
      .then(() => pending)
      .then((v) => {
        if (this.dc === dc) this.emit(v);
      })
      .catch(() => {})
      .finally(() => {
        if (this.chain === p) this.chain = null;
      });
    this.chain = p;
  };
}

/**
 * RTCDataChannel을 DataLink로 감싼다. binaryType='arraybuffer'로 바꾸고,
 * 채널이 아직 connecting이면 open 이벤트 때 onOpenChange(true)를 알린다.
 * 재연결로 새 채널이 오면 attach(newDc)로 교체한다 (DataLink 객체는 그대로).
 */
export function fromRTCDataChannel(
  dc: RTCDataChannel | DataChannelLike | null,
  opts?: ChannelLinkOptions,
): ChannelDataLink {
  return new RTCChannelLink(dc, opts);
}
