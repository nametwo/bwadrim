import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { Spinner } from "./icons";

// 버튼 — 피그마 Components → Button(Style × Size × State)과 같은 값.
//  - primary(파랑)는 "지금 누를 것" 한 화면에 하나. secondary(옅은 회색 바탕)·ghost는 중립색 보조 동작
//    테두리 없이 면으로 구분한다 — 테두리 상자가 여럿이면 화면이 서류처럼 딱딱해 보이고 위계가 흐려진다
//  - danger(빨강)는 종료·오류에만
//  - kakao(카톡 공유), call·call-danger·call-ghost(어두운 통화 화면)는 코드에서 더한 스타일 — 피그마에도 같은 이름
// 크기: M 48 · L 56 · XL 64 (누르는 영역 최소 48px). 모서리 M·L 12, XL 16. 아이콘 20·22·24
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
  // 카카오톡 공유만 예외로 노랑(카카오 색) — CLAUDE.md 디자인 토큰 예외
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

const ICON_SIZE: Record<ButtonSize, string> = { m: "size-5", l: "size-[22px]", xl: "size-6" };

export function buttonClass({
  variant = "primary",
  size = "l",
  block = false,
  loading = false,
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  className?: string;
} = {}) {
  return [
    "inline-flex select-none items-center justify-center text-center transition-[background-color,transform] duration-100 active:scale-[0.98] disabled:pointer-events-none",
    VARIANT[variant],
    loading ? "cursor-wait" : DISABLED[variant],
    SIZE[size],
    block ? "w-full" : "",
    className,
  ].join(" ");
}

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  /** 처리 중: 누를 수 없고, 아이콘 자리에 도는 표시 */
  loading?: boolean;
};

export function Button({
  variant,
  size = "l",
  block,
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
      className={buttonClass({ variant, size, block, loading, className })}
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
  icon,
  className,
  children,
  ...rest
}: Omit<Common, "loading"> & ComponentProps<typeof Link>) {
  return (
    <Link className={buttonClass({ variant, size, block, className })} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
