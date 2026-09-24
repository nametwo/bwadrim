import type { DataLink } from "@/lib/webrtc/data-link";
import type {
  AnchorDescriptor,
  Annotation,
  GrayImage,
  Mat3,
  Point,
  Rect,
  ReferenceInfo,
  TrackState,
  TrackUpdate,
} from "./types";
import { IDENTITY, applyH, invert3, pointInPolygon, rectNormToPx, warpRect } from "./geometry";
import { AnchorTracker, type AnchorSpec } from "./client";
import {
  captureReference,
  decodeReference,
  readJpegSize,
  roiFromStroke,
  roiFromTap,
  type CapturedReference,
} from "./capture";
import {
  PROTOCOL_LIMITS,
  ProtocolReceiver,
  encodeAnchorTransfer,
  encodeMessage,
  quantizeNorm,
  quantizePoint,
  type ReceivedAnchor,
} from "./protocol";
import { cssToFrame, insideFrame, mappingForVideo, type ObjectFit } from "./overlay";
import type { Size } from "./frame-source";

// 엔지니어·고객 쪽 앵커 세션. React useSyncExternalStore에 바로 쓸 수 있는 subscribe/getSnapshot 제공.
//
//   const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, () => EMPTY_ENGINEER_SNAPSHOT);
//
// 엔지니어: 탭 = 핀, 드래그 = 선. 활성 앵커의 ROI(현재 H로 비춘 사각형) 안이면 같은 앵커에 추가(H⁻¹로 ref 좌표),
//          밖이면 지금 프레임으로 새 앵커(initialH = I, 이전 것 대체). 새 앵커는 누르는 순간 임시로 추적을 시작해
//          드래그 중 카메라가 움직여도 선이 사물에 붙고, 손을 떼면 확정해 고객에게 보낸다(anchor + JPEG 조각).
// 고객: 받은 JPEG를 기준 그레이로 풀어 initialH 없이(탐색) 추적. 상태가 바뀌면 status로 알리고,
//       searching/lost가 0.8초 이상이면 카드(기준 이미지)를 띄운다.
// 둘 다 아무것도 저장하지 않는다 (메모리만). destroy()가 Worker·루프·객체 URL·리스너를 모두 정리.

/**
 * 탭/드래그 구분: 누른 곳에서 CSS 10px 이상 움직이면 드래그(선), 아니면 핀.
 * 빠른 탭(<250ms)뿐 아니라 제자리 길게 누르기도 핀으로 본다 — 아무 일도 안 일어나는 것보다 낫다.
 */
export const TAP_SLOP_PX = 10;
export const CARD_DELAY_MS = 800;
/** 드래그 원시 샘플 상한 (5초 × 120Hz 여유) */
const MAX_RAW_POINTS = 4000;
/** 선 단순화 허용 오차 시작값 (ref px) */
const SIMPLIFY_EPSILON = 0.6;
/** 고객 status 최소 간격 (ms) — 상태가 떨려도 메시지 폭주 방지. 마지막 상태는 반드시 보낸다 */
const STATUS_MIN_INTERVAL_MS = 150;
/** 드래그 미리보기 스냅샷 갱신 간격 (ms) */
const DRAFT_EMIT_MS = 16;
/** attachPointerInput이 무시하는 대상 (컨테이너 안에 겹쳐 둔 버튼 등). data-anchor-ignore로 직접 지정 가능 */
const INTERACTIVE_SELECTOR = "button, a, input, select, textarea, label, [role=button], [data-anchor-ignore]";

// ───────────────────────── 공용 ─────────────────────────

/** AnchorTracker에서 세션이 쓰는 부분 (테스트에서 가짜 추적기를 넣기 위함) */
export interface TrackerLike {
  setAnchor(spec: AnchorSpec): Promise<ReferenceInfo | null>;
  clearAnchor(): void;
  frameSize(): Size | null;
  destroy(): void;
}

export type CreateTracker = (
  video: HTMLVideoElement,
  opts: { fps: number; onUpdate: (u: TrackUpdate) => void },
) => TrackerLike;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const defaultCreateTracker: CreateTracker = (video, opts) =>
  new AnchorTracker(video, { fps: opts.fps, onUpdate: opts.onUpdate });

/** 짧은 무작위 id (앵커·주석). 보안 용도 아님 */
export function randomId(prefix: string): string {
  let s = "";
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(8);
    c.getRandomValues(b);
    for (const x of b) s += (x % 36).toString(36);
  } else {
    for (let i = 0; i < 8; i++) s += ((Math.random() * 36) | 0).toString(36);
  }
  return `${prefix}${s}`;
}

class Store<S> {
  private listeners = new Set<() => void>();
  constructor(private snap: S) {}
  get(): S {
    return this.snap;
  }
  set(next: S) {
    this.snap = next;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        console.warn("[anchor-session] 구독자 오류:", e);
      }
    }
  }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  clear() {
    this.listeners.clear();
  }
}

/**
 * 선 단순화 (Ramer–Douglas–Peucker, 반복형). 끝점은 항상 남긴다.
 * maxPoints를 넘으면 허용 오차를 1.5배씩 키워 다시.
 */
export function simplifyStroke(points: readonly Point[], epsilon: number, maxPoints: number): Point[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  let eps = Math.max(1e-9, epsilon);
  const keep = new Uint8Array(n);
  const stack = new Int32Array(2 * n);
  for (let attempt = 0; attempt < 40; attempt++) {
    keep.fill(0);
    keep[0] = 1;
    keep[n - 1] = 1;
    let sp = 0;
    stack[sp++] = 0;
    stack[sp++] = n - 1;
    const eps2 = eps * eps;
    while (sp > 0) {
      const b = stack[--sp];
      const a = stack[--sp];
      const ax = points[a].x;
      const ay = points[a].y;
      const dx = points[b].x - ax;
      const dy = points[b].y - ay;
      const len2 = dx * dx + dy * dy;
      let best = -1;
      let bestD = eps2;
      for (let i = a + 1; i < b; i++) {
        const px = points[i].x - ax;
        const py = points[i].y - ay;
        let d2: number;
        if (len2 < 1e-12) {
          d2 = px * px + py * py;
        } else {
          const cr = px * dy - py * dx;
          // 선분 밖 투영은 끝점 거리로
          const t = (px * dx + py * dy) / len2;
          if (t < 0) d2 = px * px + py * py;
          else if (t > 1) {
            const qx = points[i].x - points[b].x;
            const qy = points[i].y - points[b].y;
            d2 = qx * qx + qy * qy;
          } else d2 = (cr * cr) / len2;
        }
        if (d2 > bestD) {
          bestD = d2;
          best = i;
        }
      }
      if (best >= 0) {
        keep[best] = 1;
        stack[sp++] = a;
        stack[sp++] = best;
        stack[sp++] = best;
        stack[sp++] = b;
      }
    }
    let count = 0;
    for (let i = 0; i < n; i++) count += keep[i];
    if (count <= maxPoints) {
      const out: Point[] = [];
      for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: points[i].x, y: points[i].y });
      return out;
    }
    eps *= 1.5;
  }
  // 이론상 오지 않음: 균등 솎아내기
  const out: Point[] = [];
  const step = (n - 1) / (maxPoints - 1);
  for (let k = 0; k < maxPoints; k++) out.push(points[Math.round(k * step)]);
  return out;
}

function clampNorm(v: number): number {
  return Math.min(PROTOCOL_LIMITS.coordMax, Math.max(PROTOCOL_LIMITS.coordMin, v));
}

/** ref px → 보낼 norm 점 (양자화 + 허용 범위로 자름) */
function toWireNorm(p: Point, ref: Size): Point {
  const q = quantizePoint({ x: p.x / ref.width, y: p.y / ref.height });
  return { x: clampNorm(q.x), y: clampNorm(q.y) };
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

/** 다른 작업 크기의 frame 픽셀로 (회전 직후 등, 픽셀 중심 규약) */
function rescale(p: Point, from: Size, to: Size): Point {
  if (sameSize(from, to)) return p;
  return {
    x: ((p.x + 0.5) * to.width) / from.width - 0.5,
    y: ((p.y + 0.5) * to.height) / from.height - 0.5,
  };
}

// ───────────────────────── 엔지니어 ─────────────────────────

export interface EngineerSnapshot {
  /** 활성 앵커 (그리는 중인 선은 id "draft"인 stroke로 포함) */
  anchor: AnchorDescriptor | null;
  /** 엔지니어 자기 영상에서의 추적 (anchor.id와 같은 앵커일 때만) */
  update: TrackUpdate | null;
  /** 고객 화면에서의 상태 (고객이 알려온 것, 모르면 null) */
  customerState: TrackState | null;
  /** 기준 설정 결과. false면 무늬 부족 → UI는 정지 화면 폴백. 설정 중이면 null */
  trackable: boolean | null;
  /** setFrozen(true) 중인지 */
  frozen: boolean;
}

export interface PointerSample {
  pointerId: number;
  /** 영상 요소 기준 CSS px (탭·드래그 판정) */
  css: Point;
  /** 작업 해상도 frame px */
  frame: Point;
  /** ms */
  t: number;
}

export interface EngineerSessionOptions {
  video: HTMLVideoElement;
  link: DataLink;
  /** 추적 fps 상한 (기본 30) */
  fps?: number;
  deps?: {
    createTracker?: CreateTracker;
    capture?: (video: HTMLVideoElement) => CapturedReference | null;
    clock?: Clock;
  };
}

interface EngAnchor {
  id: string;
  gray: GrayImage;
  jpeg: Promise<Blob>;
  jpegSize: Size;
  refSize: Size;
  /** 요청 ROI (ref px) — 같은 앵커 판정과 추적기 핀 대리값 */
  roiPx: Rect;
  annotations: Annotation[];
  info: ReferenceInfo | null;
  /** 주석이 하나라도 확정됨 (= 고객에게 보낼 대상) */
  committed: boolean;
  /** 현재 링크로 전체 전송을 마침 */
  sent: boolean;
  /** 전송 준비 중 (JPEG 대기) */
  sending: boolean;
}

interface Gesture {
  pointerId: number;
  mode: "same" | "new";
  anchorId: string;
  startCss: Point;
  maxMove: number;
  dragging: boolean;
  /** ref px (앵커 기준) */
  refPts: Point[];
  prev: EngAnchor | null;
  prevCustomerState: TrackState | null;
  prevTrackable: boolean | null;
}

/** 빈 스냅샷 (useSyncExternalStore의 getServerSnapshot·세션 생성 전 기본값으로) */
export const EMPTY_ENGINEER_SNAPSHOT: EngineerSnapshot = Object.freeze({
  anchor: null,
  update: null,
  customerState: null,
  trackable: null,
  frozen: false,
});

export class EngineerAnchorSession {
  private readonly video: HTMLVideoElement;
  private readonly link: DataLink;
  private readonly tracker: TrackerLike;
  private readonly clock: Clock;
  private readonly capture: (video: HTMLVideoElement) => CapturedReference | null;
  private readonly store = new Store<EngineerSnapshot>(EMPTY_ENGINEER_SNAPSHOT);
  private readonly receiver: ProtocolReceiver;
  private readonly offs: (() => void)[] = [];

  private anchor: EngAnchor | null = null;
  private update: TrackUpdate | null = null;
  /** 마지막으로 H가 있던 갱신 (ref 좌표 변환용) */
  private lastGood: TrackUpdate | null = null;
  private lastGoodInv: Mat3 | null = null;
  private customerState: TrackState | null = null;
  private trackable: boolean | null = null;
  private frozen = false;
  private gesture: Gesture | null = null;
  private draft: Annotation | null = null;
  private draftTimer: unknown = null;
  private anchorView: AnchorDescriptor | null = null;
  private viewDirty = true;
  /** 가장 최근 tracker.setAnchor 호출 번호 — 대체된 호출의 결과(null)를 무시하기 위함 */
  private trackToken = 0;
  /** 링크는 열려 있는데 전송이 실패했을 때(큐 넘침 등) 다시 보내기 */
  private resendTimer: unknown = null;
  private resendAttempts = 0;
  private destroyed = false;

  constructor(opts: EngineerSessionOptions) {
    this.video = opts.video;
    this.link = opts.link;
    this.clock = opts.deps?.clock ?? defaultClock;
    this.capture = opts.deps?.capture ?? ((v) => captureReference(v));
    this.tracker = (opts.deps?.createTracker ?? defaultCreateTracker)(opts.video, {
      fps: opts.fps ?? 30,
      onUpdate: (u) => this.onTrackerUpdate(u),
    });
    this.receiver = new ProtocolReceiver(
      {
        onStatus: (anchorId, state) => {
          const a = this.anchor;
          if (!a || a.id !== anchorId || !a.committed) return;
          if (this.customerState === state) return;
          this.customerState = state;
          this.emit();
        },
      },
      { role: "engineer" },
    );
    this.offs.push(this.link.onMessage((d) => this.receiver.receive(d)));
    this.offs.push(this.link.onOpenChange((open) => this.onLinkOpen(open)));
  }

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  getSnapshot = (): EngineerSnapshot => this.store.get();

  /**
   * 정지 화면 모드. UI가 video.pause()로 화면을 멈춘 동안 true로 두면 추적 갱신을 무시하고
   * 마지막 자세(새 앵커면 H = I)를 유지한다 — 무늬가 부족한(trackable=false) 기준도 멈춘 화면 위에선 정확하다.
   */
  setFrozen(frozen: boolean): void {
    if (this.destroyed || this.frozen === frozen) return;
    this.frozen = frozen;
    this.emit();
  }

  /** 모든 주석 지우기 (고객 화면 포함) */
  clear(): void {
    if (this.destroyed) return;
    this.dropGesture(false);
    this.anchor = null;
    this.update = null;
    this.setLastGood(null);
    this.customerState = null;
    this.trackable = null;
    this.viewDirty = true;
    this.trackToken++;
    this.cancelResend();
    this.tracker.clearAnchor();
    if (this.link.isOpen()) this.link.send(encodeMessage({ t: "clear" }));
    this.emit();
  }

  /** 추적 갱신 최신값 (rAF 렌더 루프에서 React 재렌더 없이 읽기용) */
  latestUpdate(): TrackUpdate | null {
    return this.update;
  }

  /**
   * 포인터 입력 (저수준). attachPointerInput을 쓰면 직접 부를 일은 없다.
   * down은 프레임 밖(레터박스)이면 무시. 동시에 한 포인터만.
   */
  handlePointer(kind: "down" | "move" | "up" | "cancel", s: PointerSample): void {
    if (this.destroyed) return;
    try {
      switch (kind) {
        case "down":
          this.pointerDown(s);
          break;
        case "move":
          this.pointerMove(s);
          break;
        case "up":
          this.pointerUp(s);
          break;
        case "cancel":
          if (this.gesture && this.gesture.pointerId === s.pointerId) this.cancelGesture();
          break;
      }
    } catch (e) {
      console.warn("[anchor-session] 포인터 처리 오류:", e);
      this.dropGesture(true);
    }
  }

  /**
   * 요소(보통 영상을 감싼 컨테이너)에 포인터 리스너를 단다. touch-action: none 설정 포함.
   * fit은 <video>의 object-fit. 반환값을 부르면 떼어낸다.
   */
  attachPointerInput(el: HTMLElement, fit: ObjectFit = "contain"): () => void {
    const video = this.video;
    const sample = (ev: PointerEvent, pointerId = ev.pointerId): PointerSample | null => {
      const fs = this.tracker.frameSize();
      const m = mappingForVideo(video, fit);
      if (!fs || !m) return null;
      const r = video.getBoundingClientRect();
      const css = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      return { pointerId, css, frame: cssToFrame(m, css, fs), t: ev.timeStamp };
    };
    const down = (ev: PointerEvent) => {
      if (!ev.isPrimary || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      // 컨테이너 안의 버튼 등(지우기·종료)을 누른 것은 주석이 아니다
      const target = ev.target as Element | null;
      if (target && target !== el && typeof target.closest === "function" && target.closest(INTERACTIVE_SELECTOR)) return;
      const s = sample(ev);
      if (!s) return;
      this.handlePointer("down", s);
      if (this.gesture?.pointerId === ev.pointerId) {
        ev.preventDefault();
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          // 무시
        }
      }
    };
    const move = (ev: PointerEvent) => {
      if (!this.gesture || this.gesture.pointerId !== ev.pointerId) return;
      const list = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
      for (const e of list.length ? list : [ev]) {
        const s = sample(e, ev.pointerId);
        if (s) this.handlePointer("move", s);
      }
    };
    const up = (ev: PointerEvent) => {
      if (!this.gesture || this.gesture.pointerId !== ev.pointerId) return;
      const s = sample(ev);
      if (s) this.handlePointer("up", s);
      else this.cancelGesture();
    };
    const cancel = (ev: PointerEvent) => {
      if (this.gesture && this.gesture.pointerId === ev.pointerId) this.cancelGesture();
    };
    const prevTouch = el.style.touchAction;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("lostpointercapture", cancel);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("lostpointercapture", cancel);
      el.style.touchAction = prevTouch;
      this.cancelGesture();
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.dropGesture(false);
    this.destroyed = true;
    this.cancelResend();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.tracker.destroy();
    this.anchor = null;
    this.update = null;
    this.setLastGood(null);
    this.store.clear();
  }

  // ───────────────────────── 내부: 포인터 ─────────────────────────

  private pointerDown(s: PointerSample) {
    if (this.gesture) return; // 두 번째 손가락 무시
    const fs = this.tracker.frameSize();
    if (!fs || !insideFrame(s.frame, fs)) return;

    // 같은 앵커: 확정된 앵커를 지금 확실히(tracking) 추적 중이고, 누른 곳이 그 ROI(현재 H로 비춘 사각형) 안
    // (weak이면 자세가 불확실하므로 새 앵커 — 새 기준이 더 정확하다)
    let mode: "same" | "new" = "new";
    const a = this.anchor;
    const u = this.update;
    if (a && a.committed && u && u.anchorId === a.id && u.state === "tracking" && u.H) {
      const quad = warpRect(u.H, a.roiPx);
      if (quad && pointInPolygon(rescale(s.frame, fs, u.frameSize), quad)) {
        // 주석이 가득 찬 앵커 안을 누르면 무시 (새 앵커로 기존 주석을 통째로 지우지 않는다)
        if (a.annotations.length >= PROTOCOL_LIMITS.maxAnnotations) return;
        mode = "same";
      }
    }

    const g: Gesture = {
      pointerId: s.pointerId,
      mode,
      anchorId: "",
      startCss: s.css,
      maxMove: 0,
      dragging: false,
      refPts: [],
      prev: this.anchor,
      prevCustomerState: this.customerState,
      prevTrackable: this.trackable,
    };

    if (mode === "same") {
      g.anchorId = a!.id;
    } else {
      const cap = this.capture(this.video);
      if (!cap) return;
      const refSize = { width: cap.gray.width, height: cap.gray.height };
      // 캡처한 프레임 = 지금 보이는 프레임. 크기가 다르면(회전 직후) 맞춘다
      const p = rescale(s.frame, fs, refSize);
      const na: EngAnchor = {
        id: randomId("a"),
        gray: cap.gray,
        jpeg: cap.jpeg,
        jpegSize: cap.jpegSize,
        refSize,
        roiPx: roiFromTap(p, refSize.width, refSize.height),
        annotations: [],
        info: null,
        committed: false,
        sent: false,
        sending: false,
      };
      g.anchorId = na.id;
      this.activate(na, IDENTITY);
    }
    const r = this.frameToRef(s.frame);
    if (r) {
      g.refPts.push(r);
      // 누르는 즉시 보이게: 탭으로 끝나면 이 자리에 핀 (드래그가 되면 선 미리보기로 바뀐다)
      this.draft = { id: "draft", kind: "pin", p: toWireNorm(r, this.anchor!.refSize) };
      this.viewDirty = true;
    }
    this.gesture = g;
    this.emit();
  }

  private pointerMove(s: PointerSample) {
    const g = this.gesture;
    if (!g || g.pointerId !== s.pointerId) return;
    const d = Math.hypot(s.css.x - g.startCss.x, s.css.y - g.startCss.y);
    if (d > g.maxMove) g.maxMove = d;
    if (!g.dragging && g.maxMove >= TAP_SLOP_PX) g.dragging = true;
    const r = this.frameToRef(s.frame);
    if (r && g.refPts.length < MAX_RAW_POINTS) {
      const last = g.refPts[g.refPts.length - 1];
      if (!last || Math.abs(last.x - r.x) + Math.abs(last.y - r.y) > 0.25) g.refPts.push(r);
    }
    if (g.dragging) this.scheduleDraft();
  }

  private pointerUp(s: PointerSample) {
    const g = this.gesture;
    if (!g || g.pointerId !== s.pointerId) return;
    this.pointerMove(s);
    this.gesture = null;
    this.clearDraft();
    const a = this.anchor;
    if (!a || a.id !== g.anchorId || g.refPts.length === 0) {
      if (g.mode === "new") this.restorePrevious(g);
      this.emit();
      return;
    }
    const ref = a.refSize;
    let ann: Annotation;
    let strokeRef: Point[] | null = null;
    if (g.dragging && g.refPts.length >= 2) {
      strokeRef = simplifyStroke(g.refPts, SIMPLIFY_EPSILON, PROTOCOL_LIMITS.maxStrokePoints);
      const pts: Point[] = [];
      for (const p of strokeRef) {
        const q = toWireNorm(p, ref);
        const last = pts[pts.length - 1];
        if (!last || last.x !== q.x || last.y !== q.y) pts.push(q);
      }
      ann = pts.length >= 2 ? { id: randomId("s"), kind: "stroke", points: pts } : { id: randomId("p"), kind: "pin", p: pts[0] };
    } else {
      // 탭(또는 제자리 길게 누름) → 누른 곳에 핀
      ann = { id: randomId("p"), kind: "pin", p: toWireNorm(g.refPts[0], ref) };
    }

    if (g.mode === "new") {
      if (ann.kind === "stroke" && strokeRef) {
        // ROI를 선 전체로 다시 잡는다 (추적기 핀 대리값 = 선의 중심)
        a.roiPx = roiFromStroke(strokeRef, ref.width, ref.height);
        const lg = this.lastGood;
        const H0 = lg && lg.anchorId === a.id && lg.H ? lg.H : IDENTITY;
        this.startTracking(a, H0);
      }
      a.annotations = [ann];
      a.committed = true;
      this.viewDirty = true;
      this.emit();
      void this.sendAnchor(a);
    } else {
      if (a.annotations.length >= PROTOCOL_LIMITS.maxAnnotations) {
        this.emit();
        return;
      }
      a.annotations = [...a.annotations, ann];
      this.viewDirty = true;
      this.emit();
      this.sendAnn(a, ann);
    }
  }

  private cancelGesture() {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.clearDraft();
    if (g.mode === "new") this.restorePrevious(g);
    this.emit();
  }

  /** 제스처를 조용히 버림. restore면 확정 안 된 새 앵커 대신 이전 앵커로 (예외 처리용) */
  private dropGesture(restore: boolean) {
    const g = this.gesture;
    this.gesture = null;
    this.clearDraft();
    if (restore && g && g.mode === "new" && !this.destroyed) this.restorePrevious(g);
  }

  /** 확정 안 된 새 앵커를 버리고 이전 앵커로 (고객은 이전 앵커를 그대로 보고 있다) */
  private restorePrevious(g: Gesture) {
    const cur = this.anchor;
    if (!cur || cur.id !== g.anchorId || cur.committed) return;
    const prev = g.prev;
    this.anchor = prev;
    this.update = null;
    this.setLastGood(null);
    this.viewDirty = true;
    this.customerState = g.prevCustomerState;
    this.trackable = g.prevTrackable;
    const token = ++this.trackToken;
    if (prev) {
      // 자세를 모르므로 탐색 모드로 다시 찾는다
      void this.tracker.setAnchor({ id: prev.id, ref: prev.gray, roi: prev.roiPx }).then((info) => {
        if (this.destroyed || this.anchor !== prev || token !== this.trackToken || !info) return;
        prev.info = info;
        this.trackable = info.trackable;
        this.emit();
      });
    } else {
      this.tracker.clearAnchor();
    }
  }

  private scheduleDraft() {
    if (this.draftTimer !== null) return;
    this.draftTimer = this.clock.setTimeout(() => {
      this.draftTimer = null;
      this.refreshDraft();
    }, DRAFT_EMIT_MS);
  }

  private refreshDraft() {
    const g = this.gesture;
    const a = this.anchor;
    if (!g || !g.dragging || !a || a.id !== g.anchorId || g.refPts.length < 2) return;
    const step = Math.max(1, Math.ceil(g.refPts.length / PROTOCOL_LIMITS.maxStrokePoints));
    const pts: Point[] = [];
    for (let i = 0; i < g.refPts.length; i += step) pts.push(toWireNorm(g.refPts[i], a.refSize));
    const last = g.refPts[g.refPts.length - 1];
    pts.push(toWireNorm(last, a.refSize));
    this.draft = { id: "draft", kind: "stroke", points: pts };
    this.viewDirty = true;
    this.emit();
  }

  private clearDraft() {
    if (this.draftTimer !== null) {
      this.clock.clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    if (this.draft) {
      this.draft = null;
      this.viewDirty = true;
    }
  }

  /** frame px → 현재 앵커의 ref px (마지막 유효 H의 역변환) */
  private frameToRef(p: Point): Point | null {
    const a = this.anchor;
    const lg = this.lastGood;
    const inv = this.lastGoodInv;
    if (!a || !lg || lg.anchorId !== a.id || !inv) return null;
    const fs = this.tracker.frameSize();
    const q = fs ? rescale(p, fs, lg.frameSize) : p;
    const r = applyH(inv, q);
    return r && Number.isFinite(r.x) && Number.isFinite(r.y) ? r : null;
  }

  // ───────────────────────── 내부: 앵커·추적 ─────────────────────────

  private setLastGood(u: TrackUpdate | null) {
    this.lastGood = u;
    this.lastGoodInv = u && u.H ? invert3(u.H) : null;
  }

  /** 새 앵커를 활성화하고 H0 자세로 추적 시작. 즉시 보이도록 합성 갱신(H0)을 먼저 낸다 */
  private activate(a: EngAnchor, H0: Mat3) {
    this.cancelResend();
    this.anchor = a;
    this.customerState = null;
    this.trackable = null;
    this.viewDirty = true;
    const synthetic: TrackUpdate = {
      anchorId: a.id,
      state: "tracking",
      H: H0.slice(),
      confidence: 1,
      refSize: { ...a.refSize },
      frameSize: { ...a.refSize },
      processMs: 0,
    };
    this.update = synthetic;
    this.setLastGood(synthetic);
    this.startTracking(a, H0);
  }

  private startTracking(a: EngAnchor, H0: Mat3) {
    const token = ++this.trackToken;
    void this.tracker.setAnchor({ id: a.id, ref: a.gray, roi: a.roiPx, initialH: H0 }).then((info) => {
      if (this.destroyed || this.anchor !== a || token !== this.trackToken) return;
      a.info = info;
      this.trackable = info ? info.trackable : false;
      this.emit();
    });
  }

  private onTrackerUpdate(u: TrackUpdate) {
    if (this.destroyed || this.frozen) return;
    const a = this.anchor;
    if (!a || u.anchorId !== a.id) return;
    this.update = u;
    if (u.H) this.setLastGood(u);
    this.emit();
  }

  private descriptorOf(a: EngAnchor): AnchorDescriptor {
    const { width, height } = a.refSize;
    return {
      id: a.id,
      refWidth: width,
      refHeight: height,
      roi: {
        x: quantizeNorm(a.roiPx.x / width),
        y: quantizeNorm(a.roiPx.y / height),
        width: quantizeNorm(a.roiPx.width / width),
        height: quantizeNorm(a.roiPx.height / height),
      },
      annotations: a.annotations.slice(),
    };
  }

  // ───────────────────────── 내부: 전송 ─────────────────────────

  private async sendAnchor(a: EngAnchor): Promise<void> {
    if (a.sending || !a.committed) return;
    if (!this.link.isOpen()) {
      a.sent = false; // 열리면 onLinkOpen에서 다시
      return;
    }
    a.sending = true;
    try {
      const blob = await a.jpeg;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (this.destroyed || this.anchor !== a || !this.link.isOpen()) return;
      const msgs = encodeAnchorTransfer(this.descriptorOf(a), {
        bytes,
        width: a.jpegSize.width,
        height: a.jpegSize.height,
      });
      let ok = true;
      for (const m of msgs) {
        if (!this.link.send(m)) {
          ok = false;
          break;
        }
      }
      a.sent = ok;
      if (ok) this.resendAttempts = 0;
      else {
        console.warn("[anchor-session] 앵커 전송 실패 — 다시 보냄");
        this.scheduleResend(a);
      }
    } catch (e) {
      console.warn("[anchor-session] 기준 이미지 준비 실패:", e);
      a.sent = false;
    } finally {
      a.sending = false;
    }
  }

  private sendAnn(a: EngAnchor, ann: Annotation) {
    // 전송 전(JPEG 대기 중)이면 앵커 헤더에 함께 실린다
    if (!a.sent) return;
    if (!this.link.isOpen() || !this.link.send(encodeMessage({ t: "ann", anchorId: a.id, ann }))) {
      a.sent = false; // 전체 재전송 (닫혀 있으면 다음 열림 때)
      this.scheduleResend(a);
    }
  }

  /** 링크가 열린 채로 전송이 실패한 경우 잠시 뒤 전체 재전송 (최대 3회, 성공하면 초기화) */
  private scheduleResend(a: EngAnchor) {
    if (this.resendTimer !== null || this.resendAttempts >= 3 || !this.link.isOpen()) return;
    this.resendAttempts++;
    this.resendTimer = this.clock.setTimeout(() => {
      this.resendTimer = null;
      if (!this.destroyed && this.anchor === a && !a.sent && this.link.isOpen()) void this.sendAnchor(a);
    }, 1000);
  }

  private cancelResend() {
    if (this.resendTimer !== null) this.clock.clearTimeout(this.resendTimer);
    this.resendTimer = null;
    this.resendAttempts = 0;
  }

  private onLinkOpen(open: boolean) {
    if (this.destroyed) return;
    const a = this.anchor;
    if (!open) {
      if (a) a.sent = false;
      if (this.customerState !== null) {
        this.customerState = null;
        this.emit();
      }
      return;
    }
    // 새로 열림(재연결 포함): 고객 쪽 상태를 우리 것에 맞춘다
    this.cancelResend();
    if (a && a.committed) void this.sendAnchor(a);
    else this.link.send(encodeMessage({ t: "clear" }));
  }

  private emit() {
    if (this.destroyed) return;
    const a = this.anchor;
    if (this.viewDirty) {
      this.viewDirty = false;
      if (!a) this.anchorView = null;
      else {
        const d = this.descriptorOf(a);
        const g = this.gesture;
        if (this.draft && g && g.anchorId === a.id) d.annotations.push(this.draft);
        this.anchorView = d;
      }
    }
    const update = a && this.update && this.update.anchorId === a.id ? this.update : null;
    const prev = this.store.get();
    if (
      prev.anchor === this.anchorView &&
      prev.update === update &&
      prev.customerState === this.customerState &&
      prev.trackable === this.trackable &&
      prev.frozen === this.frozen
    ) {
      return;
    }
    this.store.set({
      anchor: this.anchorView,
      update,
      customerState: this.customerState,
      trackable: this.trackable,
      frozen: this.frozen,
    });
  }
}

// ───────────────────────── 고객 ─────────────────────────

export interface CustomerSnapshot {
  anchor: AnchorDescriptor | null;
  update: TrackUpdate | null;
  /** 기준 JPEG 객체 URL (카드 이미지). 앵커가 바뀌거나 지워지면 폐기된다 */
  cardUrl: string | null;
  /** searching/lost가 0.8초 이상 이어짐 → 상단 카드 "기사님이 표시한 곳을 비춰주세요" */
  showCard: boolean;
}

export interface CustomerSessionOptions {
  video: HTMLVideoElement;
  link: DataLink;
  /** 추적 fps 상한 (기본 20) */
  fps?: number;
  cardDelayMs?: number;
  deps?: {
    createTracker?: CreateTracker;
    decode?: (blob: Blob, size: Size) => Promise<GrayImage>;
    clock?: Clock;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };
}

interface CustAnchor {
  descriptor: AnchorDescriptor;
  byteLength: number;
  url: string | null;
  state: TrackState;
}

/** 빈 스냅샷 (useSyncExternalStore의 getServerSnapshot·세션 생성 전 기본값으로) */
export const EMPTY_CUSTOMER_SNAPSHOT: CustomerSnapshot = Object.freeze({
  anchor: null,
  update: null,
  cardUrl: null,
  showCard: false,
});

export class CustomerAnchorSession {
  private readonly link: DataLink;
  private readonly tracker: TrackerLike;
  private readonly clock: Clock;
  private readonly decode: (blob: Blob, size: Size) => Promise<GrayImage>;
  private readonly createUrl: (blob: Blob) => string | null;
  private readonly revokeUrl: (url: string) => void;
  private readonly cardDelayMs: number;
  private readonly store = new Store<CustomerSnapshot>(EMPTY_CUSTOMER_SNAPSHOT);
  private readonly receiver: ProtocolReceiver;
  private readonly offs: (() => void)[] = [];

  private current: CustAnchor | null = null;
  private update: TrackUpdate | null = null;
  private showCard = false;
  private cardTimer: unknown = null;
  private statusTimer: unknown = null;
  private lastStatusAt = Number.NEGATIVE_INFINITY;
  private lastSent: { anchorId: string; state: TrackState } | null = null;
  private gen = 0;
  private destroyed = false;

  constructor(opts: CustomerSessionOptions) {
    this.link = opts.link;
    this.clock = opts.deps?.clock ?? defaultClock;
    this.cardDelayMs = opts.cardDelayMs ?? CARD_DELAY_MS;
    this.decode = opts.deps?.decode ?? ((blob, size) => decodeReference(blob, size));
    this.createUrl =
      opts.deps?.createObjectURL ??
      ((blob) => (typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(blob) : null));
    this.revokeUrl =
      opts.deps?.revokeObjectURL ??
      ((url) => {
        if (typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(url);
      });
    this.tracker = (opts.deps?.createTracker ?? defaultCreateTracker)(opts.video, {
      fps: opts.fps ?? 20,
      onUpdate: (u) => this.onTrackerUpdate(u),
    });
    this.receiver = new ProtocolReceiver(
      {
        onAnchor: (r) => this.onAnchor(r),
        onAnn: (anchorId, ann) => this.onAnn(anchorId, ann),
        onClear: () => this.onClear(),
      },
      { role: "customer" },
    );
    this.offs.push(this.link.onMessage((d) => this.receiver.receive(d)));
    this.offs.push(
      this.link.onOpenChange((open) => {
        if (this.destroyed) return;
        if (open) {
          this.lastSent = null;
          this.sendStatus(true);
        } else {
          this.receiver.abortTransfer("link-closed");
        }
      }),
    );
  }

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  getSnapshot = (): CustomerSnapshot => this.store.get();

  latestUpdate(): TrackUpdate | null {
    return this.update;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gen++;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.tracker.destroy();
    this.clearTimers();
    if (this.current?.url) this.revokeUrl(this.current.url);
    this.current = null;
    this.update = null;
    this.store.clear();
  }

  // ───────────────────────── 내부 ─────────────────────────

  private onAnchor(r: ReceivedAnchor) {
    if (this.destroyed) return;
    const { anchor, img, bytes } = r;
    // 디코딩 전에 JPEG 헤더 크기를 확인 (선언과 다르거나 거대한 이미지 거부)
    const dims = readJpegSize(bytes);
    if (!dims || dims.width !== img.width || dims.height !== img.height) {
      console.warn("[anchor-session] 기준 이미지 형식 불일치 — 무시");
      return;
    }
    const cur = this.current;
    if (cur && cur.descriptor.id === anchor.id && cur.byteLength === bytes.length) {
      // 재연결로 같은 앵커가 다시 옴 → 추적은 그대로, 주석만 맞춘다
      cur.descriptor = { ...cur.descriptor, annotations: anchor.annotations };
      this.emit();
      return;
    }

    const gen = ++this.gen;
    if (cur?.url) this.revokeUrl(cur.url);
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
    const next: CustAnchor = {
      descriptor: anchor,
      byteLength: bytes.length,
      url: this.createUrl(blob),
      state: "searching",
    };
    this.current = next;
    this.update = null;
    this.tracker.clearAnchor();
    // 새 앵커: 카드 타이머를 처음부터 (0.8초 탐색 후 카드)
    if (this.cardTimer !== null) this.clock.clearTimeout(this.cardTimer);
    this.cardTimer = null;
    this.showCard = false;
    this.onState(next, "searching", true);
    this.emit();

    const size = { width: anchor.refWidth, height: anchor.refHeight };
    this.decode(blob, size)
      .then((gray) => {
        if (gen !== this.gen || this.destroyed) return;
        const roi = rectNormToPx(anchor.roi, size.width, size.height);
        // initialH 없음 → searching에서 ORB 탐색으로 찾는다
        return this.tracker.setAnchor({ id: anchor.id, ref: gray, roi }).then((info) => {
          if (gen !== this.gen || this.destroyed) return;
          if (!info) this.onState(next, "lost");
        });
      })
      .catch((e) => {
        console.warn("[anchor-session] 기준 이미지 디코딩 실패:", e);
        if (gen === this.gen && !this.destroyed) this.onState(next, "lost");
      });
  }

  private onAnn(anchorId: string, ann: Annotation) {
    const cur = this.current;
    if (!cur || cur.descriptor.id !== anchorId) return;
    if (cur.descriptor.annotations.some((a) => a.id === ann.id)) return;
    if (cur.descriptor.annotations.length >= PROTOCOL_LIMITS.maxAnnotations) return;
    cur.descriptor = { ...cur.descriptor, annotations: [...cur.descriptor.annotations, ann] };
    this.emit();
  }

  private onClear() {
    this.gen++;
    const cur = this.current;
    if (cur?.url) this.revokeUrl(cur.url);
    this.current = null;
    this.update = null;
    this.tracker.clearAnchor();
    this.clearTimers();
    this.showCard = false;
    this.emit();
  }

  private onTrackerUpdate(u: TrackUpdate) {
    if (this.destroyed) return;
    const cur = this.current;
    if (!cur || u.anchorId !== cur.descriptor.id) return;
    this.update = u;
    this.onState(cur, u.state);
    this.emit();
  }

  private onState(cur: CustAnchor, state: TrackState, force = false) {
    if (!force && cur.state === state) return;
    cur.state = state;
    if (state === "searching" || state === "lost") {
      if (!this.showCard && this.cardTimer === null) {
        this.cardTimer = this.clock.setTimeout(() => {
          this.cardTimer = null;
          if (this.current === cur && (cur.state === "searching" || cur.state === "lost")) {
            this.showCard = true;
            this.emit();
          }
        }, this.cardDelayMs);
      }
    } else {
      if (this.cardTimer !== null) {
        this.clock.clearTimeout(this.cardTimer);
        this.cardTimer = null;
      }
      this.showCard = false;
    }
    this.sendStatus(false);
    this.emit();
  }

  /** 상태를 엔지니어에게. 너무 잦으면 마지막 상태를 조금 뒤에 한 번 */
  private sendStatus(force: boolean) {
    const cur = this.current;
    if (!cur || this.destroyed) return;
    const id = cur.descriptor.id;
    if (!force && this.lastSent && this.lastSent.anchorId === id && this.lastSent.state === cur.state) return;
    const wait = this.lastStatusAt + STATUS_MIN_INTERVAL_MS - this.clock.now();
    if (!force && wait > 0) {
      if (this.statusTimer === null) {
        this.statusTimer = this.clock.setTimeout(() => {
          this.statusTimer = null;
          this.sendStatus(false);
        }, wait);
      }
      return;
    }
    if (!this.link.isOpen()) return;
    if (this.link.send(encodeMessage({ t: "status", anchorId: id, state: cur.state }))) {
      this.lastSent = { anchorId: id, state: cur.state };
      this.lastStatusAt = this.clock.now();
    }
  }

  private clearTimers() {
    if (this.cardTimer !== null) this.clock.clearTimeout(this.cardTimer);
    if (this.statusTimer !== null) this.clock.clearTimeout(this.statusTimer);
    this.cardTimer = null;
    this.statusTimer = null;
  }

  private emit() {
    if (this.destroyed) return;
    const cur = this.current;
    const anchor = cur ? cur.descriptor : null;
    const update = cur && this.update && this.update.anchorId === cur.descriptor.id ? this.update : null;
    const cardUrl = cur ? cur.url : null;
    const showCard = !!cur && this.showCard;
    const prev = this.store.get();
    if (prev.anchor === anchor && prev.update === update && prev.cardUrl === cardUrl && prev.showCard === showCard) return;
    this.store.set({ anchor, update, cardUrl, showCard });
  }
}
