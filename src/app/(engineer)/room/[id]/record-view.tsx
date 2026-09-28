"use client";

import { useState } from "react";
import { Banner } from "@/components/ui/banner";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { CheckIcon, DownloadIcon } from "@/components/ui/icons";
import { formatDuration } from "@/lib/format";
import { savePhotos, type TakenPhoto } from "@/lib/photo-save";

// 결과 기록 (피그마 E11, ROOM-10). 원격 해결률의 원천이라 건너뛰기 없이 한 번에 고르게 한다.
// 이 화면의 할 일은 질문 하나라서 질문이 곧 화면 제목이다. 그 아래 두 답, 그다음 사진·통화 요약(참고).
// 두 답은 같은 모양 — 한쪽을 강조하면 지표가 기운다. 고른 뒤 '기록하고 끝내기'를 눌러야 저장되므로 잘못 고른 답은 바꿀 수 있다.
// 통화 중 찍은 사진(CALL-16)이 있으면 '폰에 저장할까요?'를 묻고, 저장하지 않고 끝내려 하면 한 번 더 묻는다
// (사진은 이 기기 메모리에만 있어 화면을 떠나면 사라진다).

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
  photos = [],
}: {
  createdLabel: string;
  byCustomer: boolean;
  summary: CallSummary;
  saving: boolean;
  saveError: boolean;
  onSubmit: (resolvedRemotely: boolean) => void;
  photos?: TakenPhoto[];
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const [photoState, setPhotoState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [askPhotos, setAskPhotos] = useState(false);
  const n = photos.length;

  // 반드시 버튼 탭 안에서 (공유 창은 사용자 제스처가 있어야 열린다)
  async function save() {
    setPhotoState("saving");
    const r = await savePhotos(photos);
    setPhotoState(r === "saved" ? "saved" : r === "cancelled" ? "idle" : "failed");
    return r === "saved";
  }

  function submit() {
    if (choice === null) return;
    if (n > 0 && photoState !== "saved") {
      setAskPhotos(true);
      return;
    }
    onSubmit(choice);
  }

  const rows: [string, string][] = [["만든 시각", createdLabel]];
  if (summary.talkSec !== null) rows.push(["통화 시간", formatDuration(summary.talkSec)]);
  rows.push(["방향 지시", `${summary.guide}번`], ["가리키기·그리기", `${summary.pointer + summary.draw}번`]);

  return (
    <main
      data-testid="eng-record"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(20px,env(safe-area-inset-top))]"
    >
      {byCustomer && (
        <Banner flat tone="info" role="status" sub="고객님이 링크를 다시 열면 통화로 돌아가요.">
          고객님이 통화를 끝냈어요
        </Banner>
      )}

      <section className="flex flex-col gap-3 pt-5" role="radiogroup" aria-labelledby="record-q">
        <div className="flex flex-col gap-2 pb-5">
          <h1 id="record-q" className="text-title-l">
            출장 없이
            <br />
            해결됐나요?
          </h1>
          <p className="text-body-m text-text-secondary">고른 답이 원격 해결률에 들어가요</p>
        </div>
        <Choice selected={choice === true} disabled={saving} onSelect={() => setChoice(true)}>
          네, 원격으로 해결했어요
        </Choice>
        <Choice selected={choice === false} disabled={saving} onSelect={() => setChoice(false)}>
          아니요, 방문이 필요해요
        </Choice>
      </section>

      {n > 0 && (
        <section data-testid="eng-photos" className="mt-8 flex flex-col gap-3 rounded-3xl bg-bg-subtle p-5">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-title-s">통화 중 찍은 사진 {n}장</h2>
            <p className="text-body-s text-text-secondary">
              {photoState === "saved" ? "폰에 저장했어요." : "저장 안 하면 이 화면을 나갈 때 지워져요."}
            </p>
          </div>
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {photos.map((p, i) => (
              <li key={p.id} className="flex-none">
                {/* eslint-disable-next-line @next/next/no-img-element -- 이 기기 메모리의 사진(blob:) */}
                <img src={p.url} alt={`찍은 사진 ${i + 1}`} className="size-20 rounded-2xl object-cover" />
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="l"
            block
            loading={photoState === "saving"}
            onClick={save}
            className="bg-bg-page"
            icon={photoState === "saved" ? <CheckIcon className="size-5" /> : <DownloadIcon className="size-5" />}
          >
            {photoState === "saving" ? "저장하는 중…" : photoState === "saved" ? "다시 저장하기" : `사진 ${n}장 폰에 저장`}
          </Button>
          {photoState === "failed" && (
            <p role="alert" className="text-body-s text-text-danger">
              저장하지 못했어요. 다시 눌러 주세요.
            </p>
          )}
        </section>
      )}

      <section className={`${n > 0 ? "mt-3" : "mt-8"} rounded-3xl bg-bg-subtle px-5 py-4`}>
        <h2 className="pb-2 text-label-m text-text-secondary">통화 요약</h2>
        <dl className="flex flex-col gap-2.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <dt className="text-body-m text-text-secondary">{k}</dt>
              <dd className="text-label-l text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <BottomCta>
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
          onClick={submit}
        >
          {saving ? "저장하는 중…" : "기록하고 끝내기"}
        </Button>
      </BottomCta>
      <Sheet
        open={askPhotos}
        onClose={() => setAskPhotos(false)}
        title={`찍은 사진 ${n}장을 저장할까요?`}
        description="저장 안 하면 사진은 지워져요."
        testId="eng-photo-sheet"
      >
        <Button
          size="xl"
          block
          loading={photoState === "saving"}
          icon={<DownloadIcon className="size-6" />}
          onClick={async () => {
            if ((await save()) && choice !== null) {
              setAskPhotos(false);
              onSubmit(choice);
            }
          }}
        >
          사진 저장하고 끝내기
        </Button>
        <Button
          variant="secondary"
          size="xl"
          block
          onClick={() => {
            setAskPhotos(false);
            if (choice !== null) onSubmit(choice);
          }}
        >
          저장 안 하고 끝내기
        </Button>
      </Sheet>
    </main>
  );
}

// 피그마 E11의 선택 칸: 회색 면, 고르면 흰 바탕 + 진한 테두리 + 채운 체크 (파랑은 '기록하고 끝내기'에만)
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
      className={`flex min-h-button-xl items-center gap-3 rounded-2xl px-5 text-left text-label-l transition-colors disabled:opacity-60 ${
        selected ? "bg-bg-page ring-2 ring-text-primary ring-inset" : "bg-bg-subtle active:bg-bg-muted"
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid size-6 flex-none place-items-center rounded-full ${
          selected ? "bg-text-primary text-on-primary" : "bg-bg-page ring-2 ring-border-strong ring-inset"
        }`}
      >
        {selected && <CheckIcon className="size-4" strokeWidth={2.6} />}
      </span>
      {children}
    </button>
  );
}
