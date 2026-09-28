import type { ReactNode } from "react";

// 지표 카드 — 피그마 Components → StatCard. 흰 바탕, 모서리 16, 그림자 Shadow/Card.
// 이름(Label/S) · 큰 숫자(Display/L) · 한 줄 풀이(Label/S, 좋은 소식이면 초록)
export function StatCard({
  label,
  value,
  sub,
  subTone = "secondary",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  subTone?: "success" | "secondary";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl bg-bg-page px-5 py-4 shadow-card">
      <span className="text-label-s text-text-secondary">{label}</span>
      <span className="text-display-l text-text-primary">{value}</span>
      {sub && (
        <span className={`text-label-s ${subTone === "success" ? "text-text-success" : "text-text-secondary"}`}>{sub}</span>
      )}
    </div>
  );
}
