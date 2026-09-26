// 통화 화면용 작은 선 아이콘 (의존성 없음). 글자와 함께 쓰는 보조 표시라 aria-hidden.

const base = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function EraseIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M7 21h10" />
      <path d="M5.5 14.5 14 6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11.5 18.5H9.5l-4-4Z" />
      <path d="m9 11 5 5" />
    </svg>
  );
}

export function PauseIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

export function PlayIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M7 5v14l12-7L7 5Z" />
    </svg>
  );
}

export function HangupIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M3 14.5c5-4.7 13-4.7 18 0l-2.2 2.6-3.3-1.4v-2.4a9.5 9.5 0 0 0-7 0v2.4l-3.3 1.4L3 14.5Z" />
    </svg>
  );
}

export function FlipIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9a8 8 0 0 1 14.3-3.3L20 8" />
      <path d="M20 3v5h-5" />
      <path d="M20 15a8 8 0 0 1-14.3 3.3L4 16" />
      <path d="M4 21v-5h5" />
    </svg>
  );
}

export function TapIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12 10.5V9a1.5 1.5 0 0 1 3 0v2" />
      <path d="M15 11a1.5 1.5 0 0 1 3 0v3.5a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.2L4.4 15.3a1.6 1.6 0 0 1 2.4-2.1L9 15V11" />
    </svg>
  );
}

export function MicOffIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M3 3l18 18" />
      <path d="M9 9v2a3 3 0 0 0 5 2.2" />
      <path d="M15 10V5a3 3 0 0 0-5.7-1.3" />
      <path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 10.6 6" />
      <path d="M12 18v3" />
    </svg>
  );
}
