import { isGuideDir, type GuideCmd } from "@/lib/webrtc/guide";
import { ArrowRightIcon } from "@/components/ui/icons";
import { GUIDE_TEXT } from "./guide-overlay";

// 엔지니어가 지금 고객 화면에 뜬 지시를 확인하는 알약 — 피그마 Components → GuidePill (CALL-15).
// 십자키를 누르는 동안 노랑 '고객 화면 → 오른쪽으로', 아니면 어두운 '고객 화면 지시 없음'(멈춘 화면이면 '멈춤').

const ARROW_ROTATE: Record<string, string> = { right: "", down: "rotate-90", left: "rotate-180", up: "-rotate-90" };

export function GuidePill({ cmd, frozen = false }: { cmd: GuideCmd | null; frozen?: boolean }) {
  const active = !!cmd && !frozen;
  return (
    <span
      data-testid="eng-guide-pill"
      data-cmd={active ? cmd : "none"}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-2 whitespace-nowrap shadow-float ${
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
