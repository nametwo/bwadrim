"use client";

import { useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";
import { formatDuration } from "@/lib/format";
import { AppBar } from "./call-ui";

// 결과 기록 (피그마 E11, ROOM-10). 원격 해결률의 원천이라 건너뛰기 없이 한 번에 고르게 한다.
// 두 답은 같은 모양 — 한쪽을 강조하면 지표가 기운다. 고른 뒤 '기록하고 끝내기'를 눌러야 저장되므로 잘못 고른 답은 바꿀 수 있다.

export type CallSummary = {
  /** 연결돼 있던 시간(초). 이 화면에서 연결된 적 없으면 null */
  talkSec: number | null;
  pointer: number;
  guide: number;
  draw: number;
};

export function RecordView({
  createdLabel,
  byCustomer,
  summary,
  saving,
  saveError,
  onSubmit,
}: {
  createdLabel: string;
  byCustomer: boolean;
  summary: CallSummary;
  saving: boolean;
  saveError: boolean;
  onSubmit: (resolvedRemotely: boolean) => void;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);

  const rows: [string, string][] = [["상담", `${createdLabel}에 만듦`]];
  if (summary.talkSec !== null) rows.push(["통화 시간", formatDuration(summary.talkSec)]);
  rows.push(["방향 지시", `${summary.guide}번`], ["가리키기·그리기", `${summary.pointer + summary.draw}번`]);

  return (
    <main
      data-testid="eng-record"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]"
    >
      <AppBar title="상담 기록" back={false} />
      {byCustomer && (
        <Banner tone="info" role="status" sub="고객님이 링크를 다시 열면 통화로 돌아가요.">
          고객님이 통화를 끝냈어요
        </Banner>
      )}

      <dl className="mt-3 flex flex-col gap-2 rounded-2xl bg-bg-subtle p-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <dt className="text-body-s text-text-secondary">{k}</dt>
            <dd className="text-label-m text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-6 flex flex-col gap-3" role="radiogroup" aria-labelledby="record-q">
        <div>
          <h2 id="record-q" className="text-title-m">
            출장 없이 해결됐나요?
          </h2>
          <p className="text-body-s text-text-secondary">이 기록이 원격 해결률이 돼요.</p>
        </div>
        <Choice selected={choice === true} disabled={saving} onSelect={() => setChoice(true)}>
          네, 원격으로 해결했어요
        </Choice>
        <Choice selected={choice === false} disabled={saving} onSelect={() => setChoice(false)}>
          아니요, 방문이 필요해요
        </Choice>
      </section>

      <div className="sticky bottom-0 -mx-5 mt-auto flex flex-col gap-2 bg-bg-page/95 px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur">
        {saveError && (
          <p role="alert" className="text-center text-body-m font-medium text-text-danger">
            저장에 실패했어요. 다시 눌러 주세요.
          </p>
        )}
        <Button
          size="xl"
          block
          disabled={choice === null}
          loading={saving}
          onClick={() => choice !== null && onSubmit(choice)}
        >
          {saving ? "저장하는 중…" : "기록하고 끝내기"}
        </Button>
      </div>
    </main>
  );
}

// 피그마 E11의 선택 칸: 고르면 진한 테두리 + 채운 체크
function Choice({
  selected,
  disabled,
  onSelect,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-button-l items-center gap-3 rounded-xl bg-bg-page px-4 text-left text-label-l transition-colors disabled:opacity-60 ${
        selected ? "ring-2 ring-text-primary" : "ring-1 ring-border-strong active:bg-bg-subtle"
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid size-6 flex-none place-items-center rounded-full ${
          selected ? "bg-text-primary text-on-primary" : "ring-2 ring-border-strong"
        }`}
      >
        {selected && <CheckIcon className="size-4" strokeWidth={2.6} />}
      </span>
      {children}
    </button>
  );
}
