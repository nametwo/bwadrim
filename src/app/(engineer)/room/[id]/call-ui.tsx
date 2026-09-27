"use client";

import { useEffect, useState, type ReactNode } from "react";
import { formatClock } from "@/lib/format";

// 엔지니어 통화 화면(어두운 표면) 조각들 (CALL-04).

/** 연결된 뒤 흐른 시간 '통화 중 · 3:12'. 1초마다 자기만 다시 그린다(통화 화면 전체를 다시 그리지 않게) */
export function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatClock((now - since) / 1000)}</span>;
}

type ToolTone = "default" | "primary" | "danger" | "on";

const TOOL_TONE: Record<ToolTone, string> = {
  default: "bg-call-control text-call-text active:bg-call-control-pressed",
  primary: "bg-primary text-on-primary active:bg-primary-pressed",
  danger: "bg-danger text-on-primary active:bg-danger-pressed",
  // 손전등 켜짐 — CALL-11 예외 색(노랑)
  on: "bg-yellow-400 text-gray-900",
};

/** 십자키 양옆의 도구 버튼: 아이콘 위, 글자 아래. 한 손 엄지로 누르기 좋게 크게 */
export function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  tone = "default",
  pressed,
  testId,
}: {
  icon: ReactNode;
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: ToolTone;
  pressed?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      data-testid={testId}
      className={`flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 text-center text-label-m transition-transform active:scale-[0.97] disabled:opacity-40 ${TOOL_TONE[tone]}`}
    >
      {icon}
      <span className="leading-tight">{label}</span>
    </button>
  );
}

/** 통화 화면 위쪽의 알림 줄 (노랑=주의, 빨강=실패, 회색=안내) */
export function CallBanner({
  tone = "info",
  children,
  role,
}: {
  tone?: "info" | "warning" | "danger";
  children: ReactNode;
  role?: "alert" | "status";
}) {
  const cls =
    tone === "warning"
      ? "bg-warning-tint text-text-warning"
      : tone === "danger"
        ? "bg-danger-tint text-text-danger"
        : "bg-black-80 text-call-text";
  return (
    <p role={role} className={`rounded-xl px-3 py-2 text-body-s font-medium shadow-float ${cls}`}>
      {children}
    </p>
  );
}
