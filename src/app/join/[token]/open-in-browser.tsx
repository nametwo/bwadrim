"use client";

import { useEffect, useRef, useState } from "react";
import {
  externalOpenUrl,
  IN_APP_LABEL,
  type InAppKind,
} from "@/lib/in-app-browser";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { Button } from "@/components/ui/button";
import { AlertIcon, CheckIcon, CopyIcon } from "@/components/ui/icons";
import { CameraStart } from "./camera-start";

// 인앱 브라우저로 열렸을 때 (JOIN-10). 카카오톡·라인은 자동으로 기본 브라우저로 넘기고,
// 나머지 앱은 직접 열도록 안내한다. 안드로이드 등에서 그 자리에서 되는 경우를 위해 '이대로 계속하기'를 둔다.
export function OpenInBrowser({
  kind,
  roomId,
  token,
}: {
  kind: InAppKind;
  roomId: string;
  token: string;
}) {
  const [stay, setStay] = useState(false);
  const [copied, setCopied] = useState(false);
  const triedRef = useRef(false);
  const canOpen = kind === "kakaotalk" || kind === "line";
  const app = IN_APP_LABEL[kind];

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
      // 앱 안에서 복사가 막힐 수 있다 — 아래 안내대로 메뉴에서 열면 된다
    }
  }

  if (stay) return <CameraStart roomId={roomId} token={token} />;

  const stayButton = (
    <Button variant="ghost" size="m" block onClick={() => setStay(true)} className="underline underline-offset-4">
      이대로 계속하기
    </Button>
  );

  if (canOpen) {
    return (
      <NoticeScreen
        tone="brand"
        icon={<AlertIcon className="size-10" />}
        title="인터넷 앱으로 여는 중이에요"
        actions={
          <>
            <Button size="xl" block onClick={openExternal}>
              인터넷 앱으로 열기
            </Button>
            {stayButton}
          </>
        }
      >
        {app} 안에서는 카메라가
        <br />
        켜지지 않을 수 있어요.
      </NoticeScreen>
    );
  }

  return (
    <NoticeScreen
      tone="warning"
      icon={<AlertIcon className="size-10" />}
      title="인터넷 앱으로 열어 주세요"
      actions={
        <>
          <Button
            size="xl"
            block
            onClick={copy}
            icon={copied ? <CheckIcon className="size-6" /> : <CopyIcon className="size-6" />}
          >
            {copied ? "복사됐어요" : "링크 복사"}
          </Button>
          {stayButton}
        </>
      }
      footer="복사한 링크를 사파리·크롬·삼성 인터넷 주소창에 붙여 넣어도 돼요."
    >
      <p>
        {app} 안에서는 카메라가 켜지지 않을 수 있어요.
      </p>
      <div className="mt-4 flex flex-col gap-3 rounded-3xl bg-bg-subtle p-4 text-left text-text-primary">
        <p className="flex gap-3">
          <StepNo n={1} />
          <span>
            화면 위나 아래의 <b className="inline-flex h-7 items-center rounded-md bg-bg-page px-2 align-middle text-title-s leading-none ring-1 ring-border">
              ⋯
            </b> 또는{" "}
            <b>공유</b> 버튼을 누르세요
          </span>
        </p>
        <p className="flex gap-3">
          <StepNo n={2} />
          <span>
            <b>다른 브라우저로 열기</b>(또는 외부 브라우저로 열기)를 누르세요
          </span>
        </p>
      </div>
    </NoticeScreen>
  );
}

function StepNo({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-7 flex-none place-items-center rounded-full bg-bg-page text-label-m text-text-secondary ring-1 ring-border"
    >
      {n}
    </span>
  );
}
