import type { ReactNode } from "react";
import { BrandMark } from "./brand";

// 한 화면에 한 가지 안내 (고객 화면·오류 화면 공용). 큰 아이콘 → 제목 → 설명 → 버튼(아래쪽, 엄지 닿는 곳).
// 나이 든 사장님 기준: 제목 26px 이상, 설명 18px, 버튼 64px.

export type NoticeTone = "brand" | "success" | "warning" | "danger" | "neutral";

const TONE: Record<NoticeTone, string> = {
  brand: "bg-primary-tint text-icon-brand",
  success: "bg-success-tint text-text-success",
  warning: "bg-warning-tint text-text-warning",
  danger: "bg-danger-tint text-text-danger",
  neutral: "bg-bg-muted text-icon-secondary",
};

export function NoticeScreen({
  icon,
  tone = "brand",
  title,
  children,
  actions,
  footer,
  brand = true,
  testId,
}: {
  icon: ReactNode;
  tone?: NoticeTone;
  title: ReactNode;
  children?: ReactNode;
  /** 화면 아래 버튼들 */
  actions?: ReactNode;
  /** 버튼 아래 작은 안내 */
  footer?: ReactNode;
  /** 위쪽에 봐드림 표시 (어디서 온 화면인지 알게) */
  brand?: boolean;
  testId?: string;
}) {
  return (
    <main
      data-testid={testId}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pt-[max(20px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]"
    >
      {brand && (
        <div className="flex items-center gap-2 text-text-secondary">
          <BrandMark className="size-7" />
          <span className="text-label-l text-text-primary">봐드림</span>
          <span className="text-body-s">원격 A/S</span>
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
        <div className={`grid size-20 place-items-center rounded-full ${TONE[tone]}`}>{icon}</div>
        <h1 className="text-title-l text-text-primary">{title}</h1>
        {children && <div className="text-body-l text-text-secondary">{children}</div>}
      </div>
      {actions && <div className="flex flex-col gap-3">{actions}</div>}
      {footer && <div className="mt-4 text-center text-body-s text-text-secondary">{footer}</div>}
    </main>
  );
}
