// 봐드림 로고: 파란 네모 안에 흰 '봐'와 노란 점. 앱 아이콘·src/app/icon.svg와 같은 그림이다.
// '봐'는 Pretendard Bold(OFL) 글자를 선으로 바꾼 것이라 폰 글꼴과 상관없이 같은 모양이다
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 108 108" aria-hidden="true" focusable="false" className={className}>
      <rect width="108" height="108" rx="26" className="fill-primary" />
      <path
        d="M39.41 35.55L33.06 35.55L33.06 56.83L41.59 56.83L41.59 64.04C37.50 64.12 33.62 64.12 30.21 64.14L31.08 69.42C38.95 69.42 49.36 69.37 59.01 67.64L58.55 62.92C55.20 63.38 51.62 63.66 48.04 63.84L48.04 56.83L56.52 56.83L56.52 35.55L50.02 35.55L50.02 41.34L39.41 41.34ZM39.41 51.75L39.41 46.27L50.02 46.27L50.02 51.75ZM67.49 31.89L60.99 31.89L60.99 78.11L67.49 78.11L67.49 55.76L73.79 55.76L73.79 50.38L67.49 50.38Z"
        className="fill-gray-0 stroke-gray-0"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="80" cy="30" r="7" className="fill-yellow-400" />
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
