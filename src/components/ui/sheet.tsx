"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

// 아래에서 올라오는 확인 창. 엄지가 닿는 화면 아래쪽에 답 버튼을 둔다.
// 연 직후 armMs 동안은 바깥(어두운 부분)을 눌러도 닫지 않는다 — 여는 버튼을 두 번 누른 두 번째 탭이
// 바로 창을 닫아 버리지 않게. 답 버튼의 같은 보호는 쓰는 쪽이 한다(엔지니어 종료 CONFIRM_ARM_MS).
export function Sheet({
  open,
  onClose,
  title,
  description,
  tone = "light",
  armMs = 600,
  children,
  testId,
}: {
  open: boolean;
  /** 없으면 바깥을 눌러도·Esc로도 닫히지 않는다(답을 꼭 받아야 할 때) */
  onClose?: () => void;
  title: ReactNode;
  description?: ReactNode;
  tone?: "light" | "dark";
  armMs?: number;
  children: ReactNode;
  testId?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef(0);
  // 부모가 다시 그려질 때마다(통화 중에는 자주) 새 함수가 와도 열린 시각·초점을 다시 잡지 않게 ref로 읽는다
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    openedAtRef.current = Date.now();
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const dark = tone === "dark";
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" data-testid={testId}>
      <div
        className="absolute inset-0 animate-[fade-in_0.15s_ease-out] bg-overlay-scrim"
        onClick={() => {
          if (Date.now() - openedAtRef.current > armMs) onCloseRef.current?.();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative mx-auto w-full max-w-lg animate-[sheet-up_0.2s_ease-out] rounded-t-3xl px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] shadow-sheet outline-none ${
          dark ? "bg-call-surface text-call-text" : "bg-bg-page text-text-primary"
        }`}
      >
        <div
          aria-hidden="true"
          className={`mx-auto mb-4 h-1.5 w-10 rounded-full ${dark ? "bg-call-border" : "bg-border"}`}
        />
        <h2 id={titleId} className="text-center text-title-m">
          {title}
        </h2>
        {description && (
          <p
            className={`mt-2 text-center text-body-m ${dark ? "text-call-text-secondary" : "text-text-secondary"}`}
          >
            {description}
          </p>
        )}
        <div className="mt-5 flex flex-col gap-3">{children}</div>
      </div>
    </div>
  );
}
