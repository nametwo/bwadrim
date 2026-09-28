"use client";

import { useEffect, useRef, useState } from "react";
import {
  externalOpenUrl,
  IN_APP_LABEL,
  type InAppKind,
} from "@/lib/in-app-browser";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { Button } from "@/components/ui/button";
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon, MoreIcon } from "@/components/ui/icons";
import { CameraStart } from "./camera-start";
import { createTelemetry } from "@/lib/telemetry";
import { CallReport } from "@/lib/call-report";

// 인앱 브라우저로 열렸을 때 (JOIN-10, 피그마 C05). 카카오톡·라인은 자동으로 기본 브라우저로 넘기고,
// 나머지 앱은 직접 열도록 메뉴 그림으로 안내한다. 안드로이드 등에서 그 자리에서 되는 경우를 위해 '이대로 계속하기'를 둔다.
export function OpenInBrowser({
  kind,
  roomId,
  token,
  engineerName = null,
}: {
  kind: InAppKind;
  roomId: string;
  token: string;
  engineerName?: string | null;
}) {
  const [stay, setStay] = useState(false);
  const [copied, setCopied] = useState(false);
  const triedRef = useRef(false);
  const canOpen = kind === "kakaotalk" || kind === "line";
  const app = IN_APP_LABEL[kind];
  // 화면 요약 (DATA-07): 앱 안 브라우저에서 막혀 떠났는지, 자동 전환을 시도했는지
  const [report] = useState(
    () =>
      new CallReport(createTelemetry({ role: "customer", token }), {
        role: "customer",
        inapp: kind,
        redirect_tried: false,
      }),
  );
  useEffect(() => {
    report.setPhase("inapp_guide");
    return report.listen();
  }, [report]);

  function openExternal() {
    const target = externalOpenUrl(kind, window.location.href);
    report.inc("open_tap");
    if (target) window.location.href = target;
  }

  // 누를 것을 늘리지 않도록 처음 한 번은 자동으로 넘긴다
  useEffect(() => {
    if (triedRef.current || !canOpen) return;
    triedRef.current = true;
    const target = externalOpenUrl(kind, window.location.href);
    if (target) {
      report.set("redirect_tried", true);
      window.location.href = target;
    }
  }, [kind, canOpen, report]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 앱 안에서 복사가 막힐 수 있다 — 그림대로 메뉴에서 열면 된다
      report.inc("copy_fail");
    }
  }

  // '이대로 계속하기' — 이 화면 요약은 여기서 끝나고, 통화 화면이 자기 요약을 새로 쓴다
  if (stay) return <CameraStart roomId={roomId} token={token} engineerName={engineerName} />;

  const copyButton = (primary: boolean) => (
    <Button
      variant={primary ? "primary" : "ghost"}
      size={primary ? "xl" : "m"}
      block
      onClick={copy}
      icon={copied ? <CheckIcon className="size-5" /> : <CopyIcon className="size-5" />}
    >
      {copied ? "복사됐어요" : "링크 복사하기"}
    </Button>
  );

  return (
    <NoticeScreen
      tone="warning"
      icon={<ExternalIcon className="size-10" />}
      title={
        <>
          이 화면에서는
          <br />
          카메라가 안 켜져요
        </>
      }
      actions={
        <>
          {canOpen ? (
            <>
              <Button size="xl" block onClick={openExternal} icon={<ExternalIcon className="size-6" />}>
                다른 브라우저로 열기
              </Button>
              {copyButton(false)}
            </>
          ) : (
            copyButton(true)
          )}
          <button
            type="button"
            onClick={() => {
              // 이 안내 화면의 요약은 여기서 끝낸다 — 통화 화면이 자기 요약을 새로 쓴다
              report.set("exit", "stay");
              report.flush("stay", true);
              report.dispose();
              setStay(true);
            }}
            className="min-h-touch text-body-m text-text-secondary underline underline-offset-4"
          >
            이대로 계속하기
          </button>
        </>
      }
      footer={canOpen ? undefined : "복사한 링크를 사파리·크롬·삼성 인터넷 주소창에 붙여 넣어도 돼요."}
    >
      <p>
        {app} 안에서 열려서 그래요.
        <br />
        사파리나 크롬으로 열면 돼요.
      </p>
      {!canOpen && <MenuPicture />}
    </NoticeScreen>
  );
}

// 앱 안 브라우저 메뉴 그림 (피그마 C05): 오른쪽 위 ⋯ → '다른 브라우저로 열기'
function MenuPicture() {
  return (
    <div aria-hidden="true" className="mx-auto mt-5 w-full max-w-72 overflow-hidden rounded-2xl bg-bg-muted text-left text-body-s">
      <div className="flex items-center justify-between bg-bg-page px-3 py-2">
        <CloseIcon className="size-5 text-icon-secondary" />
        <span className="text-caption text-text-secondary">bwadrim</span>
        <span className="grid size-8 place-items-center rounded-full text-icon-brand ring-2 ring-primary">
          <MoreIcon className="size-5" />
        </span>
      </div>
      <div className="flex justify-end p-3">
        <div className="w-44 overflow-hidden rounded-xl bg-bg-page shadow-float">
          <p className="px-3 py-2 text-text-secondary">공유하기</p>
          <p className="bg-primary-tint px-3 py-2 font-bold text-text-brand">다른 브라우저로 열기</p>
          <p className="px-3 py-2 text-text-secondary">링크 복사</p>
        </div>
      </div>
    </div>
  );
}
