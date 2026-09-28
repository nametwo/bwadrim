import type { ReactNode } from "react";
import { AlertIcon, CheckIcon, ClockIcon, WifiIcon } from "./icons";

// 화면 위에 잠깐 뜨는 알림 — 피그마 Components → Banner(Tone=Info·Warning·Error·Success).
// 모서리 12, 그림자 Shadow/Float, 아이콘 22 + Label/M. 통화 화면에서는 영상 위쪽에 겹친다.

export type BannerTone = "info" | "warning" | "error" | "success";

const TONE: Record<BannerTone, { box: string; icon: string }> = {
  info: { box: "bg-bg-page", icon: "text-icon-brand" },
  warning: { box: "bg-warning-tint", icon: "text-warning" },
  error: { box: "bg-danger-tint", icon: "text-danger" },
  success: { box: "bg-success-tint", icon: "text-success" },
};

const DEFAULT_ICON: Record<BannerTone, ReactNode> = {
  info: <ClockIcon className="size-[22px]" />,
  warning: <WifiIcon className="size-[22px]" />,
  error: <AlertIcon className="size-[22px]" />,
  success: <CheckIcon className="size-[22px]" />,
};

export function Banner({
  tone = "info",
  icon,
  children,
  sub,
  role,
  testId,
}: {
  tone?: BannerTone;
  icon?: ReactNode;
  children: ReactNode;
  /** 두 번째 줄 (Body/S) */
  sub?: ReactNode;
  role?: "alert" | "status";
  testId?: string;
}) {
  const t = TONE[tone];
  return (
    <div
      role={role}
      data-testid={testId}
      className={`flex items-start gap-3 rounded-xl px-4 py-3 text-text-primary shadow-float ${t.box}`}
    >
      <span className={`mt-px flex-none ${t.icon}`}>{icon ?? DEFAULT_ICON[tone]}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-label-m">{children}</span>
        {sub && <span className="text-body-s text-text-secondary">{sub}</span>}
      </span>
    </div>
  );
}
