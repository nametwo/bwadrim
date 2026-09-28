"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { CallQuality } from "@/lib/webrtc/call";
import { ChevronLeftIcon } from "@/components/ui/icons";

// 엔지니어 세션 화면 조각들 (피그마 E03~E11, P01).

export { CallTimer } from "@/components/ui/call-timer";

/** 통화 상단 오른쪽 알약 — 피그마 CallTopBar의 Quality=좋음·불안정 */
export function QualityPill({ quality, connecting }: { quality: CallQuality; connecting: boolean }) {
  const bad = quality === "unstable";
  return (
    <span
      data-testid="eng-quality"
      className="inline-flex flex-none items-center gap-1.5 rounded-full bg-call-control px-3 py-1.5 text-label-s text-call-text"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${connecting || bad ? "bg-warning" : "bg-success"}`} />
      {connecting ? "연결 중" : bad ? "불안정" : "연결 좋음"}
    </span>
  );
}

/** 밝은 화면 위쪽 바 — 피그마 AppBar: 뒤로가기, 오른쪽 동작. 화면 제목은 바가 아니라 본문 맨 위에 크게 쓴다(title 없이) */
export function AppBar({
  title,
  back = true,
  right,
}: {
  title?: ReactNode;
  back?: boolean;
  right?: ReactNode;
}) {
  return (
    <header className="flex min-h-14 items-center gap-1">
      {back && (
        <Link
          href="/dashboard"
          aria-label="상담 목록으로"
          className="-ml-2 grid size-touch place-items-center rounded-xl text-icon active:bg-bg-muted"
        >
          <ChevronLeftIcon className="size-6" />
        </Link>
      )}
      {title ? <h1 className="min-w-0 flex-1 truncate text-title-s">{title}</h1> : <span className="flex-1" />}
      {right}
    </header>
  );
}

/** 밝은 화면 위쪽 바 오른쪽의 작은 글자 버튼 ('상담 닫기' 등) */
export function AppBarAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="-mr-2 h-touch rounded-xl px-3 text-label-m text-text-secondary active:bg-bg-muted disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** PC 오른쪽 패널의 키보드 안내 — 피그마 P01 */
export function ShortcutsBox() {
  const rows: [string, string][] = [
    ["← → ↑ ↓", "누르는 동안 방향 지시"],
    ["=  /  -", "가까이 / 멀리"],
    ["F", "멈추고 그리기 / 라이브로"],
    ["클릭", "빨간 동그라미"],
    ["길게 클릭", "물체에 붙는 핀"],
  ];
  return (
    <div className="flex w-full flex-col gap-2 rounded-2xl bg-call-control/60 p-4">
      <p className="text-caption text-call-text-secondary">키보드·마우스</p>
      <dl className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-3">
            <dt className="min-w-[88px]">
              <kbd className="rounded-md bg-call-control px-2 py-1 font-sans text-caption text-call-text">{k}</kbd>
            </dt>
            <dd className="text-body-s text-call-text-secondary">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
