import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

// 버튼 한 벌. 디자인 시스템 원칙:
//  - primary(파랑)는 "지금 누를 것" 한 화면에 하나
//  - danger(빨강)는 종료·오류에만. 그 밖의 보조 동작은 secondary·tonal(중립색)
//  - call-*는 어두운 통화 화면 위
// 크기: m 48 · l 56 · xl 64 (누르는 영역 최소 48px)

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "tonal"
  | "danger"
  | "ghost"
  | "kakao"
  | "call"
  | "call-danger"
  | "call-ghost";

export type ButtonSize = "m" | "l" | "xl";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary active:bg-primary-pressed shadow-card",
  secondary: "border border-border-strong bg-bg-page text-text-primary active:bg-bg-muted",
  tonal: "bg-bg-muted text-text-primary active:bg-gray-200",
  danger: "bg-danger text-on-primary active:bg-danger-pressed",
  ghost: "text-text-secondary active:bg-bg-muted",
  // 카카오톡 공유만 예외로 노랑(카카오 색) — CLAUDE.md 디자인 토큰 예외
  kakao: "bg-yellow-400 text-gray-900 active:brightness-95",
  call: "bg-call-control text-call-text active:bg-call-control-pressed",
  "call-danger": "bg-danger text-on-primary active:bg-danger-pressed",
  "call-ghost": "text-call-text-secondary active:bg-call-control",
};

const SIZE: Record<ButtonSize, string> = {
  m: "min-h-touch gap-2 rounded-xl px-4 text-label-m",
  l: "min-h-button-l gap-2 rounded-xl px-5 text-label-l",
  xl: "min-h-button-xl gap-2.5 rounded-2xl px-6 text-label-xl",
};

export function buttonClass({
  variant = "primary",
  size = "l",
  block = false,
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
} = {}) {
  return [
    "inline-flex select-none items-center justify-center text-center transition-[background-color,transform] duration-100 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
    VARIANT[variant],
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
};

export function Button({
  variant,
  size,
  block,
  icon,
  className,
  children,
  type = "button",
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={buttonClass({ variant, size, block, className })} {...rest}>
      {icon}
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
}: Common & ComponentProps<typeof Link>) {
  return (
    <Link className={buttonClass({ variant, size, block, className })} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
