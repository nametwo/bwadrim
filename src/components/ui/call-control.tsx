import type { ReactNode } from "react";

// 통화 화면 원형 버튼 — 피그마 Components → CallControl(60px 원 + 아래 Caption 글자).
//  default: 어두운 원 · active: 흰 원(켜짐 — 손전등 켜짐 등) · danger: 빨간 원(통화 종료) · disabled: 흐림
// size xl: 고객 화면(JOIN-06) — 누를 버튼 64px 원, 아이콘 28, 글자 Label/M

export type CallControlState = "default" | "active" | "danger";
export type CallControlSize = "m" | "xl";

const CIRCLE: Record<CallControlState, string> = {
  default: "bg-call-control text-call-icon group-active:bg-call-control-pressed",
  active: "bg-bg-page text-icon",
  danger: "bg-danger text-icon-on-primary group-active:bg-danger-pressed",
};

const SIZE: Record<CallControlSize, { box: string; circle: string; label: string }> = {
  m: { box: "w-[72px] gap-2", circle: "size-[60px] [&>svg]:size-[26px]", label: "text-caption" },
  xl: { box: "w-[76px] gap-1.5", circle: "size-button-xl [&>svg]:size-7", label: "text-label-m" },
};

export function CallControl({
  icon,
  label,
  onClick,
  state = "default",
  size = "m",
  disabled,
  pressed,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  state?: CallControlState;
  /** xl: 고객 화면용 큰 버튼 */
  size?: CallControlSize;
  disabled?: boolean;
  /** 켜고 끄는 버튼이면 지금 켜졌는지 (화면 낭독기용) */
  pressed?: boolean;
  testId?: string;
}) {
  const s = SIZE[size];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      data-testid={testId}
      className={`group flex flex-none flex-col items-center disabled:pointer-events-none disabled:opacity-40 ${s.box}`}
    >
      <span
        className={`grid place-items-center rounded-full transition-transform group-active:scale-95 ${s.circle} ${CIRCLE[state]}`}
      >
        {icon}
      </span>
      {/* 글자가 한 줄이든 두 줄이든 높이를 같게 — 도구가 바뀌어도(멈춤 등) 버튼 자리가 움직이지 않게 */}
      <span className={`min-h-[2.5em] text-center leading-tight text-call-text ${s.label}`}>{label}</span>
    </button>
  );
}
