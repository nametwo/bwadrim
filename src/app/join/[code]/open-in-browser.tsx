"use client";

import { useEffect, useRef, useState } from "react";
import {
  externalOpenUrl,
  IN_APP_LABEL,
  type InAppKind,
} from "@/lib/in-app-browser";
import { CameraStart } from "./camera-start";

// 인앱 브라우저로 열렸을 때 (JOIN-10). 카카오톡·라인은 자동으로 기본 브라우저로 넘기고,
// 나머지 앱은 직접 열도록 안내한다. 안드로이드 등에서 그 자리에서 되는 경우를 위해 '이대로 계속하기'를 둔다.
export function OpenInBrowser({
  kind,
  roomId,
  code,
}: {
  kind: InAppKind;
  roomId: string;
  code: string;
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

  if (stay) return <CameraStart roomId={roomId} code={code} />;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-8 text-center">
      <h1 className="text-2xl font-bold">
        {canOpen ? "인터넷 앱으로 여는 중이에요" : "인터넷 앱으로 열어 주세요"}
      </h1>
      <p className="text-lg text-gray-600">
        {app} 안에서는 카메라가
        <br />
        켜지지 않을 수 있어요.
      </p>

      {canOpen ? (
        <button
          onClick={openExternal}
          className="h-16 w-full max-w-xs rounded-2xl bg-black text-xl font-bold text-white active:opacity-80"
        >
          인터넷 앱으로 열기
        </button>
      ) : (
        <>
          <p className="text-lg text-gray-700">
            화면 오른쪽 위나 아래의 <b>⋯</b> 또는 <b>공유</b> 버튼을 누르고
            <br />
            <b>&ldquo;다른 브라우저로 열기&rdquo;</b>를 눌러 주세요.
          </p>
          <button
            onClick={copy}
            className="h-16 w-full max-w-xs rounded-2xl bg-black text-xl font-bold text-white active:opacity-80"
          >
            {copied ? "복사됐어요 ✓" : "링크 복사"}
          </button>
          <p className="text-sm text-gray-400">
            복사한 링크를 사파리나 크롬 주소창에 붙여 넣어도 돼요.
          </p>
        </>
      )}

      <button
        onClick={() => setStay(true)}
        className="mt-4 px-4 py-2 text-base text-gray-500 underline"
      >
        이대로 계속하기
      </button>
    </main>
  );
}
