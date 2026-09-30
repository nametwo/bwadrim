import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { Spinner } from "./icons";

// 버튼 — 피그마 Components → Button(Style × Size × State)과 같은 값.
//  - primary(파랑)는 "지금 누를 것" 한 화면에 하나. secondary(옅은 회색 바탕)·ghost는 중립색 보조 동작
//    테두리 없이 면으로 구분한다 — 테두리 상자가 여럿이면 화면이 서류처럼 딱딱해 보이고 위계가 흐려진다
//  - danger(빨강)는 종료·오류에만
//  - kakao(카톡 보내기), call·call-danger·call-ghost(어두운 통화 화면)는 코드에서 더한 스타일 — 피그마에도 같은 이름
// 크기: M 48 · L 56 · XL 64 (누르는 영역 최소 48px). 모서리 M·L 12, XL 16. 아이콘 20·22·24
// stack: 아이콘 위·글자 아래. 두세 개를 한 줄에 나란히 둘 때(링크 보내기의 카톡 보내기·공유하기·링크 복사 —
//   폰에서는 파란 문자 버튼 아래 보조 줄, 문자가 없는 PC에서는 이 줄이 곧 누를 것).
//   높이는 한 단계 크게(M 56 · L·XL 64), 글자는 Label/M. 피그마 Button에는 아직 없다 — 코드가 기준
// 잠긴 상태(disabled)는 회색(bg-muted + text-tertiary). 처리 중(loading)은 색을 유지하고 도는 표시만 붙인다.

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "ghost"
  | "kakao"
  | "call"
  | "call-danger"
  | "call-ghost";

export type ButtonSize = "m" | "l" | "xl";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary active:bg-primary-pressed",
  secondary: "bg-bg-muted text-text-primary active:bg-border",
  danger: "bg-danger text-on-primary active:bg-danger-pressed",
  ghost: "text-text-primary active:bg-bg-muted",
  // 카톡 보내기(카카오링크, ROOM-14)만 예외로 노랑(카카오 색) — CLAUDE.md 디자인 토큰 예외
  kakao: "bg-yellow-400 text-gray-900 active:brightness-95",
  call: "bg-call-control text-call-text active:bg-call-control-pressed",
  "call-danger": "bg-danger text-on-primary active:bg-danger-pressed",
  "call-ghost": "text-call-text-secondary active:bg-call-control",
};

// 피그마 State=Disabled
const DISABLED: Record<ButtonVariant, string> = {
  primary: "disabled:bg-bg-muted disabled:text-text-tertiary",
  secondary: "disabled:text-text-tertiary",
  danger: "disabled:bg-bg-muted disabled:text-text-tertiary",
  ghost: "disabled:text-text-tertiary",
  kakao: "disabled:bg-bg-muted disabled:text-text-tertiary",
  call: "disabled:text-call-text-secondary disabled:opacity-60",
  "call-danger": "disabled:opacity-50",
  "call-ghost": "disabled:opacity-50",
};

const SIZE: Record<ButtonSize, string> = {
  m: "min-h-touch gap-2 rounded-xl px-4 text-label-m",
  l: "min-h-button-l gap-2 rounded-xl px-5 text-label-l",
  xl: "min-h-button-xl gap-2 rounded-2xl px-6 text-label-xl",
};

const STACK_SIZE: Record<ButtonSize, string> = {
  m: "min-h-button-l flex-col gap-1 rounded-xl px-2 py-1.5 text-label-m",
  l: "min-h-button-xl flex-col gap-1 rounded-2xl px-2 py-2 text-label-m",
  xl: "min-h-button-xl flex-col gap-1 rounded-2xl px-2 py-2 text-label-m",
};

const ICON_SIZE: Record<ButtonSize, string> = { m: "size-5", l: "size-[22px]", xl: "size-6" };

export function buttonClass({
  variant = "primary",
  size = "l",
  block = false,
  stack = false,
  loading = false,
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  stack?: boolean;
  loading?: boolean;
  className?: string;
} = {}) {
  return [
    "inline-flex select-none items-center justify-center text-center transition-[background-color,transform] duration-100 active:scale-[0.98] disabled:pointer-events-none",
    VARIANT[variant],
    loading ? "cursor-wait" : DISABLED[variant],
    (stack ? STACK_SIZE : SIZE)[size],
    block ? "w-full" : "",
    className,
  ].join(" ");
}

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** 아이콘 위·글자 아래 (보조 동작을 한 줄에 나란히) */
  stack?: boolean;
  icon?: ReactNode;
  /** 처리 중: 누를 수 없고, 아이콘 자리에 도는 표시 */
  loading?: boolean;
};

export function Button({
  variant,
  size = "l",
  block,
  stack,
  icon,
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, block, stack, loading, className })}
      {...rest}
    >
      {loading ? <Spinner className={ICON_SIZE[size]} /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  block,
  stack,
  icon,
  className,
  children,
  ...rest
}: Omit<Common, "loading"> & ComponentProps<typeof Link>) {
  return (
    <Link className={buttonClass({ variant, size, block, stack, className })} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
