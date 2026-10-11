import type { ReactNode } from "react";
import { AlertIcon, CheckIcon, ClockIcon, WifiIcon } from "./icons";

// 화면 위에 잠깐 뜨는 알림 — 피그마 Components → Banner(Tone=Info·Warning·Error·Success).
// 모서리 12, 그림자 Shadow/Float, 아이콘 22 + Label/M. 통화 화면에서는 영상 위쪽에 겹친다.
// size l: 고객 화면(본문 18px 이상, NFR-02) — 제목 Title/S, 두 번째 줄 Body/L, 아이콘 24.

export type BannerTone = "info" | "warning" | "error" | "success";
export type BannerSize = "m" | "l";

const TONE: Record<BannerTone, { box: string; icon: string }> = {
  info: { box: "bg-bg-page", icon: "text-icon-brand" },
  warning: { box: "bg-warning-tint", icon: "text-warning" },
  error: { box: "bg-danger-tint", icon: "text-danger" },
  success: { box: "bg-success-tint", icon: "text-success" },
};

const DEFAULT_ICON: Record<BannerTone, typeof ClockIcon> = {
  info: ClockIcon,
  warning: WifiIcon,
  error: AlertIcon,
  success: CheckIcon,
};

const SIZE: Record<BannerSize, { icon: string; title: string; sub: string }> = {
  m: { icon: "size-[22px]", title: "text-label-m", sub: "text-body-s" },
  l: { icon: "size-6", title: "text-title-s", sub: "text-body-l" },
};

export function Banner({
  tone = "info",
  icon,
  children,
  sub,
  role,
  flat = false,
  size = "m",
  testId,
}: {
  tone?: BannerTone;
  icon?: ReactNode;
  children: ReactNode;
  /** 두 번째 줄 (Body/S, size l이면 Body/L) */
  sub?: ReactNode;
  role?: "alert" | "status";
  /** 밝은 화면 안에 놓일 때: 그림자 없이 면으로만 (영상 위에 겹칠 때는 그림자가 있어야 보인다) */
  flat?: boolean;
  /** l: 고객 화면용 큰 글자 */
  size?: BannerSize;
  testId?: string;
}) {
  const t = TONE[tone];
  const s = SIZE[size];
  const box = flat ? (tone === "info" ? "bg-bg-subtle" : t.box) : `${t.box} shadow-float`;
  const DefaultIcon = DEFAULT_ICON[tone];
  return (
    <div
      role={role}
      data-testid={testId}
      className={`flex items-start gap-3 rounded-2xl px-4 py-3 text-text-primary ${box}`}
    >
      <span className={`mt-px flex-none ${t.icon}`}>{icon ?? <DefaultIcon className={s.icon} />}</span>
      <span className="flex min-w-0 flex-col">
        <span className={s.title}>{children}</span>
        {sub && <span className={`${s.sub} text-text-secondary`}>{sub}</span>}
      </span>
    </div>
  );
}
