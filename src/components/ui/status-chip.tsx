import type { ReactNode } from "react";

// 상태 칩 — 피그마 Components → StatusChip. 점 6px + Label/S, 알약 모양.
// 대기 중(주황) · 통화 중(파랑 옅게) · 종료(회색). 지금 화면에서는 종료(회색)만 쓴다(대시보드 끝난 상담, ROOM-04).
// 원격 해결(초록)·방문 필요(빨강) 톤은 결과를 묻지 않게 되면서(2026-10-03) 지웠다(NFR-08)

export type ChipTone = "waiting" | "call" | "ended";

const TONE: Record<ChipTone, { box: string; dot: string }> = {
  waiting: { box: "bg-warning-tint text-text-warning", dot: "bg-warning" },
  call: { box: "bg-primary-tint text-text-brand", dot: "bg-primary" },
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
