// 봐드림 로고 — 피그마 Components → Logo와 같은 그림: 파란 네모 안의 흰 카메라. src/app/icon.svg와 같다.
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <g fill="none" className="stroke-gray-0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18.08 9.33H13.92L11.83 11.83H9.33C8.89 11.83 8.47 12.01 8.15 12.32C7.84 12.63 7.67 13.06 7.67 13.5V21C7.67 21.44 7.84 21.87 8.15 22.18C8.47 22.49 8.89 22.67 9.33 22.67H22.67C23.11 22.67 23.53 22.49 23.85 22.18C24.16 21.87 24.33 21.44 24.33 21V13.5C24.33 13.06 24.16 12.63 23.85 12.32C23.53 12.01 23.11 11.83 22.67 11.83H20.17L18.08 9.33Z" />
        <path d="M16 19.75C17.61 19.75 18.92 18.44 18.92 16.83C18.92 15.22 17.61 13.92 16 13.92C14.39 13.92 13.08 15.22 13.08 16.83C13.08 18.44 14.39 19.75 16 19.75Z" />
      </g>
    </svg>
  );
}

/** 로고 + 이름. size: 머리말(s) · 첫 화면(l). tone: 어두운 통화 화면이면 dark */
export function Brand({ size = "s", tone = "light" }: { size?: "s" | "l"; tone?: "light" | "dark" }) {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark className={size === "l" ? "size-11" : "size-8"} />
      <span
        className={`${size === "l" ? "text-title-l font-black" : "text-title-s font-extrabold"} ${
          tone === "dark" ? "text-call-text" : "text-text-primary"
        }`}
      >
        봐드림
      </span>
    </span>
  );
}
