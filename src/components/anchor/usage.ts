import type { EngineerSnapshot } from "@/lib/tracking/session";
import type { Annotation, TrackUpdate } from "@/lib/tracking/types";

// AR 핀(CALL-14) 통화 화면의 순수 로직 (DOM·React 없음, 단위 테스트 대상):
//  - engineerChip: 엔지니어 상태칩 문구
//  - referenceToast: 기준 설정 결과 안내 (무늬 부족·반복 무늬)
//  - needsRetap: 엔지니어 화면에서 놓쳐 다시 길게 눌러야 하는가
//  - customerUntrackable: 고객 쪽이 스스로 못 찾아 사진 카드를 바로 보일지
// 지표 이벤트는 여기서 만들지 않는다. AR 핀 기록은 anchor_used(DATA-01)로 화면당 한 번(통화 패널),
// 고객 기록은 DATA-04의 네 가지(camera_granted·camera_denied·connected·relay_used)뿐이다.
// 이벤트 이름을 늘리려면 CLAUDE.md·src/lib/events.ts·DATA-01을 같이 고칠 것.

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
  if (s.customerArrow) return { text: "고객 화면 밖이라 화살표로 안내 중", tone: "guide" };
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
 * 기준 설정 결과를 엔지니어에게 한 번 알리는 토스트 문구 (없으면 null). "무엇이 문제 — 고객에게 어떻게" 두 조각.
 *  - trackable=false: 고객은 처음부터 사진 카드를 본다. pin_blank면 "표시한 곳 주변"이 문제라고 짚어 준다
 *    (조금 옆 무늬가 있는 곳을 다시 탭하면 고정될 수 있다)
 *  - ambiguous(추적 가능): 엔지니어 화면에선 붙어 있지만 고객 쪽은 반복 무늬라 스스로 못 찾아 사진 카드로 보인다
 */
export function referenceToast(
  s: Pick<EngineerSnapshot, "trackable" | "referenceReason">,
): string | null {
  if (s.trackable === false) {
    if (s.referenceReason === "pin_blank") return "표시한 곳 주변에 무늬가 적어서 사진 카드로 보여 줄게요";
    return "무늬가 적어서 붙이기 어려워요. 사진 카드로 보여 줄게요";
  }
  if (s.trackable === true && s.referenceReason === "ambiguous") {
    return "비슷한 무늬가 많아서 사진 카드로 보여 줄게요";
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
