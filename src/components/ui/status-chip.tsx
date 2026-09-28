import type { ReactNode } from "react";

// 상태 칩 — 피그마 Components → StatusChip. 점 6px + Label/S, 알약 모양.
// 대기 중(주황) · 통화 중(파랑 옅게) · 원격 해결(초록) · 방문 필요(빨강 옅게) · 종료(회색)

export type ChipTone = "waiting" | "call" | "resolved" | "visit" | "ended";

const TONE: Record<ChipTone, { box: string; dot: string }> = {
  waiting: { box: "bg-warning-tint text-text-warning", dot: "bg-warning" },
  call: { box: "bg-primary-tint text-text-brand", dot: "bg-primary" },
  resolved: { box: "bg-success-tint text-text-success", dot: "bg-success" },
  visit: { box: "bg-danger-tint text-text-danger", dot: "bg-danger" },
  ended: { box: "bg-bg-muted text-text-secondary", dot: "bg-icon-secondary" },
};

export function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span className={`inline-flex flex-none items-center gap-1 rounded-full px-3 py-1 text-label-s whitespace-nowrap ${t.box}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}
