import type { ReactNode } from "react";

// 통화 화면 원형 버튼 — 피그마 Components → CallControl(60px 원 + 아래 Caption 글자).
//  default: 어두운 원 · active: 흰 원(켜짐 — 손전등 켜짐 등) · danger: 빨간 원(통화 종료) · disabled: 흐림

export type CallControlState = "default" | "active" | "danger";

const CIRCLE: Record<CallControlState, string> = {
  default: "bg-call-control text-call-icon group-active:bg-call-control-pressed",
  active: "bg-bg-page text-icon",
  danger: "bg-danger text-icon-on-primary group-active:bg-danger-pressed",
};

export function CallControl({
  icon,
  label,
  onClick,
  state = "default",
  disabled,
  pressed,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  state?: CallControlState;
  disabled?: boolean;
  /** 켜고 끄는 버튼이면 지금 켜졌는지 (화면 낭독기용) */
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
      className="group flex w-[72px] flex-none flex-col items-center gap-2 disabled:pointer-events-none disabled:opacity-40"
    >
      <span
        className={`grid size-[60px] place-items-center rounded-full transition-transform group-active:scale-95 [&>svg]:size-[26px] ${CIRCLE[state]}`}
      >
        {icon}
      </span>
      <span className="text-caption leading-tight text-call-text">{label}</span>
    </button>
  );
}
