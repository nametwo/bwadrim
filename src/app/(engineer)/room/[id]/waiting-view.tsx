"use client";

import type { ReactNode } from "react";
import { BottomCta } from "@/components/ui/bottom-cta";
import { StepItem, type StepState } from "@/components/ui/step-item";
import { ChevronLeftIcon, MessageIcon, MicIcon, MicOffIcon } from "@/components/ui/icons";
import { AppBar, AppBarAction } from "./call-ui";
import { inviteMessage, ShareButtons, type SentVia } from "./share-buttons";
import type { JoinProgress } from "./actions";

// 고객 부르기 (피그마 E03 새 A/S 시작 → E04 고객 기다리는 중, ROOM-05·13).
//  - 아직 안 보냈으면(E03): 큰 제목 '고객님께 링크를 보내 주세요' + 고객이 받을 문자 그림, 아래 파란 '문자로 링크 보내기'
//  - 보냈거나 고객이 링크를 열었으면(E04): 큰 제목이 지금 기다리는 단계 그 자체다('고객님이 카메라를 켜기를 기다리고 있어요').
//    아래 진행 상황 카드가 링크 열림 → 카메라 허용 → 연결을 실시간으로 보여 준다. 누를 것이 없으니 파란 버튼 없이 '문자 다시 보내기'
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

type Tone = "wait" | "ok" | "error";

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

  const appBar = (
    <AppBar
      right={
        <AppBarAction onClick={onClose} disabled={closeDisabled}>
          {closeLabel}
        </AppBarAction>
      }
    />
  );

  const micNote =
    micOn === null ? null : (
      <span className={`inline-flex items-center gap-1 text-label-m ${micOn ? "text-text-success" : "text-text-warning"}`}>
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
        {appBar}
        <div className="flex flex-col gap-2 empty:hidden">{banners}</div>
        <section className="flex flex-col gap-2 pt-3">
          <h1 className="text-title-l">
            고객님께
            <br />
            링크를 보내 주세요
          </h1>
          <p className="text-body-m text-text-secondary">고객님이 카메라를 켜면 바로 연결돼요</p>
        </section>

        {/* 고객이 받을 문자 그대로 — 무엇을 보내는지 설명 대신 보여 준다 */}
        <figure className="mt-8 flex flex-col gap-3 rounded-3xl bg-bg-subtle p-4">
          <figcaption className="flex items-center gap-1.5 px-1 text-label-m text-text-secondary">
            <MessageIcon className="size-4" />
            고객님이 받을 문자
          </figcaption>
          <p className="rounded-2xl rounded-tl-md bg-bg-page px-4 py-3 text-body-m whitespace-pre-line text-text-primary select-all">
            {inviteMessage(joinUrl)}
          </p>
        </figure>
        <p className="mt-3 flex flex-wrap items-center gap-x-2 px-1 text-body-s text-text-secondary">
          {micNote}
          {micNote && <span aria-hidden="true">·</span>}
          링크는 24시간 동안 쓸 수 있어요
        </p>

        <BottomCta>
          <ShareButtons joinUrl={joinUrl} onSent={onSent} />
        </BottomCta>
        {sheets}
      </main>
    );
  }

  // E04 고객 기다리는 중 — 제목이 지금 단계를 말한다
  const cam = progress?.camera ?? null;
  const coming = peerPresent || cam === "granted";
  const head: { tone: Tone; title: ReactNode; sub: ReactNode } = failed
    ? { tone: "error", title: "연결에 실패했어요", sub: "고객님께 링크를 다시 열어 달라고 말씀해 주세요." }
    : cam === "denied"
      ? {
          tone: "error",
          title: (
            <>
              고객님 카메라가
              <br />
              막혀 있어요
            </>
          ),
          sub: deniedCoach(progress?.deniedReason ?? null),
        }
      : coming
        ? { tone: "ok", title: "곧 연결돼요", sub: "고객님이 카메라를 켰어요. 잠시만 기다려 주세요." }
        : linkOpened
          ? {
              tone: "wait",
              title: (
                <>
                  고객님이 카메라를
                  <br />
                  켜기를 기다리고 있어요
                </>
              ),
              sub: "고객님이 카메라를 켜면 바로 연결돼요",
            }
          : {
              tone: "wait",
              title: everConnected ? (
                <>
                  고객님을 다시
                  <br />
                  기다리고 있어요
                </>
              ) : (
                <>
                  고객님이 링크를 열기를
                  <br />
                  기다리고 있어요
                </>
              ),
              sub: `${createdLabel}에 만든 상담이에요`,
            };

  const steps: { state: StepState; label: string }[] = [
    { state: "done", label: sentVia ? SENT_TITLE[sentVia] : "링크를 보냈어요" },
    linkOpened
      ? { state: "done", label: "고객님이 링크를 열었어요" }
      : { state: "current", label: "고객님이 링크를 열기를 기다리는 중" },
    cam === "granted"
      ? { state: "done", label: "고객님이 카메라를 켰어요" }
      : cam === "denied"
        ? { state: "error", label: "고객님 카메라가 막혀 있어요" }
        : linkOpened
          ? { state: "current", label: "카메라 허용을 기다리는 중" }
          : { state: "todo", label: "카메라 허용" },
    coming ? { state: "current", label: "연결하는 중…" } : { state: "todo", label: "연결되면 바로 영상이 보여요" },
  ];

  return (
    <main
      data-testid="eng-waiting"
      data-sent="true"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))]"
    >
      {appBar}
      <div className="flex flex-col gap-2 empty:hidden">{banners}</div>

      <section className="flex flex-col items-start gap-2 pt-3" aria-live="polite">
        <StatusDot tone={head.tone} />
        <h1 className="mt-3 text-title-l" data-testid="eng-wait-title">
          {head.title}
        </h1>
        <p className={`text-body-m ${head.tone === "error" ? "text-text-danger" : "text-text-secondary"}`}>{head.sub}</p>
      </section>

      <section className="mt-8 flex flex-col gap-4 rounded-3xl bg-bg-subtle p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-label-m text-text-secondary">고객 진행 상황</h2>
          {micNote}
        </div>
        {/* 단계 사이를 잇는 세로선 (동그라미가 선 위를 덮는다) */}
        <ol
          className="relative flex flex-col gap-5 before:absolute before:top-3 before:bottom-3 before:left-[13px] before:w-0.5 before:bg-border"
          data-testid="eng-progress"
        >
          {steps.map((s, i) => (
            <StepItem key={i} state={s.state}>
              {s.label}
            </StepItem>
          ))}
        </ol>
      </section>

      <details className="group mt-3 rounded-3xl bg-bg-subtle px-5 text-body-m">
        <summary className="flex min-h-button-l cursor-pointer list-none items-center justify-between text-label-l">
          고객님께 이렇게 말씀해 주세요
          <ChevronLeftIcon className="size-5 -rotate-90 text-icon-secondary transition-transform group-open:rotate-90" />
        </summary>
        <p className="pb-4 text-text-secondary">
          &ldquo;문자로 보내 드린 링크를 누르시고, 파란색 <b className="text-text-primary">카메라 켜고 시작하기</b>를 누른 다음{" "}
          <b className="text-text-primary">허용</b>을 눌러 주세요. 그리고 고장 난 곳을 비춰 주세요.&rdquo;
        </p>
      </details>

      <BottomCta>
        <ShareButtons joinUrl={joinUrl} resend onSent={onSent} />
      </BottomCta>
      {sheets}
    </main>
  );
}

// 지금 상태를 한눈에: 기다리는 중(주황, 퍼지는 고리) · 곧 연결(초록) · 막힘·실패(빨강)
function StatusDot({ tone }: { tone: Tone }) {
  const [ring, dot] =
    tone === "error" ? ["bg-danger-tint", "bg-danger"] : tone === "ok" ? ["bg-success-tint", "bg-success"] : ["bg-warning-tint", "bg-warning"];
  return (
    <span aria-hidden="true" className={`relative grid size-14 place-items-center rounded-full ${ring}`}>
      {tone !== "error" && (
        <span className={`motion-decor absolute size-4 animate-[ripple_1.8s_ease-out_infinite] rounded-full ${dot}`} />
      )}
      <span className={`relative size-4 rounded-full ${dot}`} />
    </span>
  );
}
