import type { ReactNode } from "react";

// 지표 카드 — 피그마 Components → StatCard. 흰 바탕, 모서리 24, 그림자 없음(회색 화면 위 흰 면으로 구분).
// 이름(Label/M, 회색) · 숫자(Title/L) · 한 줄 풀이(Body/S, 좋은 소식이면 초록). 숫자가 가장 먼저 눈에 들어오게
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
    <div className="flex min-w-0 flex-col gap-1 rounded-3xl bg-bg-page p-5">
      <span className="text-label-m text-text-secondary">{label}</span>
      <span className="text-title-l text-text-primary">{value}</span>
      {sub && (
        <span className={`text-body-s ${subTone === "success" ? "text-text-success" : "text-text-secondary"}`}>{sub}</span>
      )}
    </div>
  );
}
