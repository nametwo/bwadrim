// 봐드림 로고: 파란 네모 안의 눈 — "화면으로 봐 드린다". src/app/icon.svg와 같은 그림.
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path d="M5.5 16c2.6-4.4 6.2-6.6 10.5-6.6s7.9 2.2 10.5 6.6c-2.6 4.4-6.2 6.6-10.5 6.6S8.1 20.4 5.5 16z" className="fill-gray-0" />
      <circle cx="16" cy="16" r="3.6" className="fill-primary" />
      <circle cx="17.3" cy="14.7" r="1.1" className="fill-gray-0" />
    </svg>
  );
}

/** 로고 + 이름. size: 머리말(s) · 첫 화면(l) */
export function Brand({ size = "s" }: { size?: "s" | "l" }) {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark className={size === "l" ? "size-11" : "size-8"} />
      <span className={size === "l" ? "text-title-l font-black" : "text-title-s font-extrabold"}>봐드림</span>
    </span>
  );
}
