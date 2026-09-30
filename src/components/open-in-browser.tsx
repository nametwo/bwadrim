"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { externalOpenUrl, type InAppKind } from "@/lib/in-app-browser";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { Button } from "@/components/ui/button";
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon, MoreIcon } from "@/components/ui/icons";

// 인앱 브라우저로 열렸을 때 (고객 JOIN-10 피그마 C05, 엔지니어 AUTH-09). 카카오톡·라인은 자동으로 기본 브라우저로 넘기고,
// 나머지 앱은 직접 열도록 메뉴 그림으로 안내한다. 안드로이드 등에서 그 자리에서 되는 경우를 위해 '이대로 계속하기'를 둔다.
// 제목·설명은 쓰는 쪽이 정하고, '이대로 계속하기'를 누르면 children(원래 화면)을 보여 준다.
export function OpenInBrowser({
  kind,
  title,
  body,
  testId,
  children,
}: {
  kind: InAppKind;
  title: ReactNode;
  body: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const [stay, setStay] = useState(false);
  const [copied, setCopied] = useState(false);
  const triedRef = useRef(false);
  const canOpen = kind === "kakaotalk" || kind === "line";

  function openExternal() {
    const target = externalOpenUrl(kind, window.location.href);
    if (target) window.location.href = target;
  }

  // 누를 것을 늘리지 않도록 처음 한 번은 자동으로 넘긴다
  useEffect(() => {
    if (triedRef.current || !canOpen) return;
    triedRef.current = true;
    const target = externalOpenUrl(kind, window.location.href);
    if (target) window.location.href = target;
  }, [kind, canOpen]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 앱 안에서 복사가 막힐 수 있다 — 그림대로 메뉴에서 열면 된다
    }
  }

  if (stay) return children;

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
      title={title}
      testId={testId}
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
            onClick={() => setStay(true)}
            className="min-h-touch text-body-m text-text-secondary underline underline-offset-4"
          >
            이대로 계속하기
          </button>
        </>
      }
      footer={canOpen ? undefined : "복사한 링크를 사파리·크롬·삼성 인터넷 주소창에 붙여 넣어도 돼요."}
    >
      <p>{body}</p>
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
