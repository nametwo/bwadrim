import type { ReactNode } from "react";
import { BottomCta } from "./bottom-cta";
import { BrandMark } from "./brand";

// 한 화면에 한 가지 안내 (고객 화면·오류 화면 공용). 큰 아이콘 → 제목 → 설명 한두 줄 → 버튼(아래쪽, 엄지 닿는 곳).
// 나이 든 사장님 기준: 제목 26px 이상, 설명 18px, 버튼 64px. 설명은 짧게 — 할 일 하나만 말한다.

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
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(12px,env(safe-area-inset-top))]"
    >
      {brand && (
        <header className="flex h-12 items-center gap-2">
          <BrandMark className="size-7" />
          <span className="text-label-l text-text-primary">봐드림</span>
          <span className="text-body-s text-text-secondary">원격 A/S</span>
        </header>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        {/* 아이콘 크기는 여기서 정한다 — 쓰는 쪽이 준 size-10은 덮어쓴다 */}
        <div className={`mb-3 grid size-24 place-items-center rounded-full [&>svg]:size-12 ${TONE[tone]}`}>{icon}</div>
        <h1 className="text-title-l text-text-primary">{title}</h1>
        {children && <div className="w-full text-body-l text-text-secondary">{children}</div>}
      </div>
      {actions || footer ? (
        <BottomCta>
          {actions}
          {footer && <p className="pt-1 text-center text-body-s text-text-secondary">{footer}</p>}
        </BottomCta>
      ) : (
        <div className="pb-[max(24px,env(safe-area-inset-bottom))]" />
      )}
    </main>
  );
}
