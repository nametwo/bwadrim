import type { CustomerSnapshot, EngineerSnapshot } from "@/lib/tracking/session";
import type { Annotation, TrackState, TrackUpdate } from "@/lib/tracking/types";

// 통화 화면의 순수 로직 (DOM·React 없음, 단위 테스트 대상):
//  - 엔지니어 상태칩 문구
//  - 엔지니어 스냅샷 흐름 → pointer_used 이벤트 (주석이 확정될 때마다 1건)
//  - 고객 스냅샷 흐름 → 앵커별 추적 결과 요약 (고객 pointer_used 이벤트의 props)
// 이벤트 이름은 CLAUDE.md에 고정된 것만 쓴다 (pointer_used·freeze_used). 세부는 props로.

/** 그리는 중인 선·핀의 임시 id (session.ts의 draft) */
const DRAFT_ID = "draft";

function committedOf(annotations: readonly Annotation[] | undefined): Annotation[] {
  return annotations ? annotations.filter((a) => a.id !== DRAFT_ID) : [];
}

// ───────────────────────── 엔지니어 상태칩 ─────────────────────────

export type ChipTone = "ok" | "wait" | "bad" | "guide";

export interface Chip {
  text: string;
  tone: ChipTone;
}

/**
 * 고객 화면 상태를 엔지니어에게 한 줄로. 확정된 주석이 없으면 null (칩 숨김).
 * 화살표 안내(고객 화면 밖)가 가장 우선 — 고객이 핀을 못 보고 있다는 뜻이다.
 * 무늬 부족(untrackable)으로 못 찾는 중이면 "사진 카드로 안내 중".
 */
export function engineerChip(
  s: Pick<EngineerSnapshot, "anchor" | "customerState" | "customerArrow"> &
    Partial<Pick<EngineerSnapshot, "customerReason" | "trackable">>,
): Chip | null {
  if (!s.anchor || committedOf(s.anchor.annotations).length === 0) return null;
  if (s.customerArrow) return { text: "고객 화면 밖 — 화살표 안내 중", tone: "guide" };
  // 무늬가 적어 고객 쪽도 못 찾는다 → 고객은 사진 카드를 보고 있다 ("찾는 중"이라고 하면 기다리게 된다)
  if (
    (s.customerState === "searching" || s.customerState === "lost") &&
    (s.customerReason === "untrackable" || s.trackable === false)
  ) {
    return { text: "고객에게 사진 카드로 안내 중", tone: "wait" };
  }
  switch (s.customerState) {
    case "tracking":
    case "weak":
      return { text: "고객 화면에 표시 중", tone: "ok" };
    case "searching":
      return { text: "고객 화면에서 찾는 중…", tone: "wait" };
    case "lost":
      return { text: "고객 화면에서 놓침", tone: "bad" };
    default:
      return { text: "고객에게 보내는 중…", tone: "wait" };
  }
}

// ───────────────────────── 엔지니어 안내 (토스트·다시 탭) ─────────────────────────

/**
 * 기준 설정 결과를 엔지니어에게 한 번 알리는 토스트 문구 (없으면 null).
 *  - trackable=false: 고객은 처음부터 사진 카드를 본다. pin_blank면 "표시한 곳 주변"이 문제라고 짚어 준다
 *    (조금 옆 무늬가 있는 곳을 다시 탭하면 고정될 수 있다)
 *  - ambiguous(추적 가능): 엔지니어 화면에선 붙어 있지만 고객 쪽은 반복 무늬라 스스로 못 찾아 사진 카드로 보인다
 */
export function referenceToast(
  s: Pick<EngineerSnapshot, "trackable" | "referenceReason">,
): string | null {
  if (s.trackable === false) {
    if (s.referenceReason === "pin_blank") return "표시한 곳 주변에 무늬가 적어요 — 고객에게 사진 카드로 보여줘요";
    return "무늬가 적어 고정이 어려워요 — 고객에게 사진 카드로 보여줘요";
  }
  if (s.trackable === true && s.referenceReason === "ambiguous") {
    return "같은 무늬가 반복돼 고객 화면에선 사진 카드로 보여줘요";
  }
  return null;
}

/**
 * 엔지니어 자기 화면에서 표시를 놓쳤고 이 기준으로는 다시 찾을 수 없음 (반복 무늬 등, reason untrackable)
 * → "다시 탭해 주세요". 정지 화면·무늬 부족(처음부터 추적 불가, 토스트로 안내)·그리는 중에는 아니다.
 */
export function needsRetap(
  s: Pick<EngineerSnapshot, "anchor" | "update" | "trackable" | "frozen">,
): boolean {
  const a = s.anchor;
  const u = s.update;
  if (!a || !u || s.frozen || s.trackable !== true || u.anchorId !== a.id) return false;
  if (a.annotations.some((x) => x.id === DRAFT_ID) || committedOf(a.annotations).length === 0) return false;
  return (u.state === "lost" || u.state === "searching") && u.reason === "untrackable";
}

/** 고객 쪽: 이 기준으로는 스스로 찾을 수 없음 (무늬 부족·반복 무늬) → 사진 카드를 바로 보인다 */
export function customerUntrackable(u: Pick<TrackUpdate, "state" | "reason"> | null | undefined): boolean {
  return !!u && (u.state === "searching" || u.state === "lost") && u.reason === "untrackable";
}

// ───────────────────────── 엔지니어: pointer_used ─────────────────────────

export interface PointerUsedProps {
  kind: "pin" | "stroke";
  /** 새 기준(앵커)을 만든 주석인가 (false = 기존 앵커에 추가) */
  newAnchor: boolean;
  /** 기준 설정 결과 (무늬 부족이면 false). 1.5초 안에 안 나오면 null */
  trackable: boolean | null;
  /** 누르기 직전 고객 화면 상태 (새 앵커면 이전 앵커 기준, 모르면 null) */
  customerState: TrackState | null;
  /** 기준 설정 이유 (low_texture·pin_blank·ambiguous) */
  referenceReason: string | null;
  /** 이 통화에서 몇 번째 주석인가 (1부터) */
  seq: number;
}

/** trackable 결과를 기다리는 최대 시간 (ms) */
export const TRACKABLE_WAIT_MS = 1500;

interface PendingEvent {
  anchorId: string;
  since: number;
  props: PointerUsedProps;
}

/**
 * 엔지니어 세션 스냅샷을 차례로 넣으면 "주석 확정" 이벤트를 돌려준다.
 * - 새 앵커 id에 확정 주석이 생기면 newAnchor=true, 같은 앵커의 확정 주석 수가 늘면 newAnchor=false
 * - 그리는 중(draft)·취소(이전 앵커로 복귀)는 이벤트가 아니다
 * - trackable이 아직 null이면(기준 설정 중) 결과가 나오거나 1.5초가 지날 때까지 보류
 */
export class PointerUsageTracker {
  private anchorId: string | null = null;
  private count = 0;
  /** 그리는 중이 아닐 때의 고객 상태 (누르기 직전 값으로 쓴다) */
  private stableCustomerState: TrackState | null = null;
  private pending: PendingEvent | null = null;
  private seq = 0;

  /** 확정 주석 수 (이 통화 누적) */
  total(): number {
    return this.seq;
  }

  observe(s: EngineerSnapshot, now: number): PointerUsedProps[] {
    const out: PointerUsedProps[] = [];
    const a = s.anchor;

    // 보류 중인 이벤트: 같은 앵커의 trackable이 나왔거나, 앵커가 바뀌었거나, 시간이 지났으면 내보낸다
    if (this.pending) {
      const p = this.pending;
      if (a && a.id === p.anchorId && s.trackable !== null) {
        p.props.trackable = s.trackable;
        p.props.referenceReason = s.referenceReason ?? null;
        out.push(p.props);
        this.pending = null;
      } else if (!a || a.id !== p.anchorId || now - p.since >= TRACKABLE_WAIT_MS) {
        out.push(p.props);
        this.pending = null;
      }
    }

    const committed = committedOf(a?.annotations);
    const drafting = !!a && a.annotations.some((x) => x.id === DRAFT_ID);

    if (a && committed.length > 0) {
      let ev: PointerUsedProps | null = null;
      if (a.id !== this.anchorId) {
        ev = this.event(committed[committed.length - 1], true, s);
      } else if (committed.length > this.count) {
        ev = this.event(committed[committed.length - 1], false, s);
      }
      this.anchorId = a.id;
      this.count = committed.length;
      if (ev) {
        if (ev.trackable !== null) {
          out.push(ev);
        } else {
          if (this.pending) out.push(this.pending.props);
          this.pending = { anchorId: a.id, since: now, props: ev };
        }
      }
    } else if (!a) {
      // 지움
      this.anchorId = null;
      this.count = 0;
    }

    if (!drafting) this.stableCustomerState = a && committed.length > 0 ? s.customerState : null;
    return out;
  }

  /** 보류 중인 이벤트를 바로 내보낸다 (화면을 떠날 때) */
  flush(): PointerUsedProps[] {
    const p = this.pending;
    this.pending = null;
    return p ? [p.props] : [];
  }

  private event(ann: Annotation, newAnchor: boolean, s: EngineerSnapshot): PointerUsedProps {
    return {
      kind: ann.kind,
      newAnchor,
      trackable: s.trackable,
      customerState: this.stableCustomerState,
      referenceReason: s.trackable !== null ? (s.referenceReason ?? null) : null,
      seq: ++this.seq,
    };
  }
}

// ───────────────────────── 고객: 앵커별 추적 결과 ─────────────────────────

export type OutcomeEnd = "replaced" | "cleared" | "ended";

/** 고객 쪽 앵커 하나의 추적 결과 요약 (pointer_used, actor=customer의 props) */
export interface AnchorOutcome {
  side: "customer";
  /** 앵커를 받은 뒤 끝날 때까지 (ms) */
  anchor_ms: number;
  /** 받은 뒤 처음 화면에 표시(tracking/weak)될 때까지 (ms). 끝내 못 찾았으면 null */
  acquire_ms: number | null;
  /** 표시(tracking/weak)된 시간 (ms) */
  tracked_ms: number;
  /** tracked_ms / anchor_ms (0~1, 소수 셋째 자리) */
  tracked_fraction: number;
  /** 사진 카드가 떠 있던 시간 (ms) */
  card_ms: number;
  /** 화면 밖 화살표가 떠 있던 시간 (ms) */
  arrow_ms: number;
  /** 끝날 때의 주석 수 */
  annotations: number;
  end: OutcomeEnd;
}

interface OutcomeState {
  id: string;
  start: number;
  lastT: number;
  shown: boolean;
  card: boolean;
  arrow: boolean;
  tracked: number;
  cardMs: number;
  arrowMs: number;
  acquire: number | null;
  annotations: number;
}

function isShown(state: TrackState | undefined, hasH: boolean): boolean {
  return (state === "tracking" || state === "weak") && hasH;
}

/**
 * 고객 세션 스냅샷을 차례로 넣으면, 앵커가 바뀌거나 지워질 때 이전 앵커의 요약을 돌려준다.
 * 시간은 직전 관측 상태에 귀속한다 (스냅샷은 상태가 바뀔 때마다 오므로 구간 합이 정확하다).
 */
export class CustomerOutcomeTracker {
  private cur: OutcomeState | null = null;

  observe(s: CustomerSnapshot, now: number): AnchorOutcome | null {
    const id = s.anchor?.id ?? null;
    let done: AnchorOutcome | null = null;
    if (this.cur && this.cur.id !== id) {
      done = this.finish(now, id ? "replaced" : "cleared");
    }
    if (!id || !s.anchor) return done;
    if (!this.cur) {
      this.cur = {
        id,
        start: now,
        lastT: now,
        shown: false,
        card: false,
        arrow: false,
        tracked: 0,
        cardMs: 0,
        arrowMs: 0,
        acquire: null,
        annotations: 0,
      };
    }
    const c = this.cur;
    this.accumulate(c, now);
    c.shown = isShown(s.update?.state, !!s.update?.H);
    // 추적 불가 기준이면 화면은 카드를 바로 띄운다 (customer-call-view와 같은 규칙)
    c.card = s.showCard || (!!s.cardUrl && customerUntrackable(s.update));
    c.arrow = s.arrow;
    c.annotations = committedOf(s.anchor.annotations).length;
    if (c.shown && c.acquire === null) c.acquire = now - c.start;
    return done;
  }

  /** 지금 앵커를 끝내고 요약 (없으면 null) */
  finish(now: number, end: OutcomeEnd): AnchorOutcome | null {
    const c = this.cur;
    if (!c) return null;
    this.cur = null;
    this.accumulate(c, now);
    const total = Math.max(0, now - c.start);
    const round = (v: number) => Math.round(v);
    return {
      side: "customer",
      anchor_ms: round(total),
      acquire_ms: c.acquire === null ? null : round(c.acquire),
      tracked_ms: round(c.tracked),
      tracked_fraction: total > 0 ? Math.round((c.tracked / total) * 1000) / 1000 : 0,
      card_ms: round(c.cardMs),
      arrow_ms: round(c.arrowMs),
      annotations: c.annotations,
      end,
    };
  }

  private accumulate(c: OutcomeState, now: number) {
    const dt = Math.max(0, now - c.lastT);
    if (c.shown) c.tracked += dt;
    if (c.card) c.cardMs += dt;
    if (c.arrow) c.arrowMs += dt;
    c.lastT = now;
  }
}
