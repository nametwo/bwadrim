"use client";

import type { ReactNode } from "react";
import { Banner } from "@/components/ui/banner";
import { StatusChip } from "@/components/ui/status-chip";
import { StepItem, type StepState } from "@/components/ui/step-item";
import { ChevronLeftIcon, MicIcon, MicOffIcon } from "@/components/ui/icons";
import { AppBar } from "./call-ui";
import { ShareButtons, type SentVia } from "./share-buttons";
import type { JoinProgress } from "./actions";

// 고객 부르기 (피그마 E03 새 A/S 시작 → E04 고객 기다리는 중, ROOM-05·13).
//  - 아직 안 보냈으면(E03): 파란 '문자로 링크 보내기' 하나
//  - 보냈거나 고객이 링크를 열었으면(E04): 고객 진행 상황(링크 열림 → 카메라 허용 → 연결)이 실시간으로 바뀐다.
//    지금 누를 것이 없으니 파란 버튼 없이 '문자 다시 보내기'
// 이 화면에 있는 동안 통화 대기는 이미 켜져 있다 — 고객이 카메라를 켜면 바로 통화 화면으로 바뀐다

const SENT_TITLE: Record<SentVia, string> = {
  sms: "문자를 보냈어요",
  share: "링크를 공유했어요",
  copy: "링크를 복사했어요",
};

// 카메라가 막혔을 때 엔지니어가 전화로 해 줄 말 (JOIN-05 원인별)
function deniedCoach(reason: string | null) {
  if (reason === "NotReadableError" || reason === "AbortError") {
    return "다른 앱이 카메라를 쓰고 있어요. 카메라·영상통화 앱을 닫고 다시 눌러 달라고 말씀해 주세요.";
  }
  if (reason === "NotFoundError" || reason === "OverconstrainedError") return "카메라를 찾지 못했어요. 다른 폰으로 링크를 열어 달라고 말씀해 주세요.";
  if (reason === "unsupported") return "인터넷 앱(사파리·크롬)으로 링크를 열어 달라고 말씀해 주세요.";
  return "고객님 화면에 켜는 방법이 나와 있어요. 그대로 따라 해 달라고 말씀해 주세요.";
}

export function WaitingView({
  joinUrl,
  createdLabel,
  micOn,
  sentVia,
  onSent,
  progress,
  peerPresent,
  failed,
  everConnected,
  banners,
  onClose,
  closeLabel,
  closeDisabled,
  sheets,
}: {
  joinUrl: string;
  createdLabel: string;
  /** null = 아직 모름(마이크 권한 묻는 중) */
  micOn: boolean | null;
  sentVia: SentVia | null;
  onSent: (via: SentVia) => void;
  progress: JoinProgress | null;
  peerPresent: boolean;
  failed: boolean;
  everConnected: boolean;
  banners: ReactNode;
  onClose: () => void;
  closeLabel: string;
  closeDisabled?: boolean;
  sheets: ReactNode;
}) {
  const linkOpened = !!progress?.linkOpened;
  const sent = !!sentVia || linkOpened || everConnected || failed;

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      disabled={closeDisabled}
      className="-mr-2 h-touch rounded-xl px-3 text-label-m text-text-secondary active:bg-bg-muted disabled:opacity-40"
    >
      {closeLabel}
    </button>
  );

  const micChip =
    micOn === null ? null : (
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-label-s ${
          micOn ? "bg-success-tint text-text-success" : "bg-warning-tint text-text-warning"
        }`}
      >
        {micOn ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
        {micOn ? "마이크 켜짐" : "마이크 꺼짐(보기만)"}
      </span>
    );

  if (!sent) {
    // E03 새 A/S 시작
    return (
      <main
        data-testid="eng-waiting"
        data-sent="false"
        className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]"
      >
        <AppBar title="새 A/S 시작" right={closeButton} />
        <div className="flex flex-col gap-2">{banners}</div>
        <section className="flex flex-col gap-4 pt-4">
          <p className="text-body-l text-text-secondary">
            고객 휴대폰으로 링크를 보내요. 고객님은 링크만 누르면 되고, 앱 설치는 필요 없어요.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {micChip}
            <span className="text-body-s text-text-secondary">고객님이 카메라를 켜면 바로 연결돼요</span>
          </div>
          <p className="rounded-xl bg-bg-subtle px-4 py-3 text-body-s break-all text-text-secondary select-all">{joinUrl}</p>
          <p className="text-body-s text-text-secondary">링크는 24시간 동안 쓸 수 있어요.</p>
        </section>
        <div className="sticky bottom-0 -mx-5 mt-auto bg-bg-page/95 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur">
          <ShareButtons joinUrl={joinUrl} onSent={onSent} />
        </div>
        {sheets}
      </main>
    );
  }

  // E04 고객 기다리는 중
  const cam = progress?.camera ?? null;
  const steps: { state: StepState; label: string; detail?: string }[] = [
    { state: "done", label: sentVia ? SENT_TITLE[sentVia] : "링크를 보냈어요" },
    linkOpened
      ? { state: "done", label: "고객님이 링크를 열었어요" }
      : { state: "current", label: "고객님이 링크를 열기를 기다리는 중" },
    cam === "granted"
      ? { state: "done", label: "고객님이 카메라를 켰어요" }
      : cam === "denied"
        ? { state: "error", label: "고객님 카메라가 막혀 있어요", detail: deniedCoach(progress?.deniedReason ?? null) }
        : linkOpened
          ? { state: "current", label: "카메라 허용을 기다리는 중" }
          : { state: "todo", label: "카메라 허용" },
    peerPresent || cam === "granted"
      ? { state: "current", label: "연결하는 중…" }
      : { state: "todo", label: "연결되면 바로 영상이 보여요" },
  ];

  return (
    <main
      data-testid="eng-waiting"
      data-sent="true"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]"
    >
      <AppBar title={failed ? "연결 실패" : "고객 기다리는 중"} right={closeButton} />
      <div className="flex flex-col gap-2">
        {failed && (
          <Banner tone="error" role="alert" sub="고객님께 링크를 다시 열어 달라고 말씀해 주세요.">
            연결에 실패했어요
          </Banner>
        )}
        {banners}
      </div>

      <section className="mt-3 flex flex-col gap-2 rounded-2xl bg-bg-subtle p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="waiting">대기 중</StatusChip>
          {micChip}
        </div>
        <h2 className="text-title-m" data-testid="eng-wait-title">
          {everConnected && !failed ? "고객님을 다시 기다리고 있어요" : "고객님을 기다리고 있어요"}
        </h2>
        <p className="text-body-s text-text-secondary">{createdLabel}에 만든 상담 · 고객님이 카메라를 켜면 바로 연결돼요</p>
      </section>

      <section className="mt-6 flex flex-col gap-4" aria-live="polite">
        <h2 className="text-title-s">고객 진행 상황</h2>
        <ol className="flex flex-col gap-4" data-testid="eng-progress">
          {steps.map((s, i) => (
            <StepItem key={i} state={s.state} detail={s.detail}>
              {s.label}
            </StepItem>
          ))}
        </ol>
      </section>

      <details className="group mt-6 rounded-2xl bg-bg-subtle px-4 py-1 text-body-m">
        <summary className="flex min-h-touch cursor-pointer list-none items-center justify-between font-semibold">
          고객님께 이렇게 말씀해 주세요
          <ChevronLeftIcon className="size-5 -rotate-90 text-icon-secondary transition-transform group-open:rotate-90" />
        </summary>
        <p className="pb-3 text-text-secondary">
          &ldquo;문자로 보내 드린 링크를 누르시고, 파란색 <b className="text-text-primary">카메라 켜고 시작하기</b>를 누른 다음{" "}
          <b className="text-text-primary">허용</b>을 눌러 주세요. 그리고 고장 난 곳을 비춰 주세요.&rdquo;
        </p>
      </details>

      <div className="sticky bottom-0 -mx-5 mt-auto bg-bg-page/95 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur">
        <ShareButtons joinUrl={joinUrl} resend onSent={onSent} />
      </div>
      {sheets}
    </main>
  );
}
