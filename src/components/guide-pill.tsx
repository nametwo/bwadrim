import { isGuideDir, type GuideCmd } from "@/lib/webrtc/guide";
import { ArrowRightIcon } from "@/components/ui/icons";
import { GUIDE_TEXT } from "./guide-overlay";

// 엔지니어가 지금 고객 화면에 뜬 지시를 확인하는 알약 — 피그마 Components → GuidePill (CALL-15).
// 방향 링·알약을 누르는 동안 노랑 '고객 화면 → 오른쪽으로', 아니면 어두운 '고객 화면 지시 없음'(멈춘 화면이면 '멈춤').
// 링을 톡 누르기만 했으면(아무것도 안 보냄) 잠깐 쓰는 법(hint)을 이 자리에 보여 준다.

const ARROW_ROTATE: Record<string, string> = { right: "", down: "rotate-90", left: "rotate-180", up: "-rotate-90" };

export function GuidePill({
  cmd,
  frozen = false,
  hint = null,
}: {
  cmd: GuideCmd | null;
  frozen?: boolean;
  hint?: string | null;
}) {
  const active = !!cmd && !frozen;
  if (!active && hint && !frozen) {
    return (
      <span
        data-testid="eng-guide-pill"
        data-cmd="none"
        role="status"
        className="inline-flex h-9 items-center rounded-full bg-call-control px-3 text-label-s whitespace-nowrap text-call-text shadow-float"
      >
        {hint}
      </span>
    );
  }
  return (
    <span
      data-testid="eng-guide-pill"
      data-cmd={active ? cmd : "none"}
      className={`inline-flex h-9 items-center gap-2 rounded-full px-3 whitespace-nowrap shadow-float ${
        active ? "bg-guide-signal text-guide-on-signal" : "bg-call-control text-call-text"
      }`}
    >
      <span className={`text-caption ${active ? "" : "text-call-text-secondary"}`}>고객 화면</span>
      {active && isGuideDir(cmd) && <ArrowRightIcon className={`size-4 ${ARROW_ROTATE[cmd]}`} strokeWidth={2.6} />}
      {active && !isGuideDir(cmd) && <b className="text-label-m leading-none">{cmd === "closer" ? "+" : "−"}</b>}
      <span className="text-label-m">{active ? GUIDE_TEXT[cmd].main : frozen ? "멈춤" : "지시 없음"}</span>
    </span>
  );
}
