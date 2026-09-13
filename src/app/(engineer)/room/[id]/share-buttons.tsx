"use client";

import { useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

// 엔지니어 본인 폰의 문자/공유 시트를 연다.
// 본인 번호로 발송되므로 고객에게 아는 번호로 도착한다 — 별도 SMS API 불필요.
export function ShareButtons({ joinUrl }: { joinUrl: string }) {
  // SSR에선 false, 클라이언트에서 지원 여부로 하이드레이션
  const canShare = useSyncExternalStore(
    noSubscribe,
    () => !!navigator.share,
    () => false,
  );
  const [copied, setCopied] = useState(false);

  const message = `[봐드림] 아래 링크를 눌러 폰 카메라로 비춰주세요.\n${joinUrl}`;

  function smsHref() {
    // iOS는 `sms:&body=`, Android는 `sms:?body=`
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    return `sms:${ios ? "&" : "?"}body=${encodeURIComponent(message)}`;
  }

  async function share() {
    try {
      await navigator.share({ text: message });
    } catch {
      // 사용자가 공유 시트를 닫은 경우 — 무시
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard 미지원 브라우저 — URL이 화면에 보이므로 수동 복사 가능
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          window.location.href = smsHref();
        }}
        className="flex h-14 items-center justify-center rounded-xl bg-green-600 text-lg font-semibold text-white active:opacity-80"
      >
        문자로 보내기
      </a>

      {canShare && (
        <button
          type="button"
          onClick={share}
          className="h-14 rounded-xl bg-yellow-400 text-lg font-semibold text-gray-900 active:opacity-80"
        >
          카톡 등으로 공유
        </button>
      )}

      <button
        type="button"
        onClick={copy}
        className="h-14 rounded-xl border border-gray-300 text-lg font-medium text-gray-700 active:bg-gray-50"
      >
        {copied ? "복사됐어요 ✓" : "링크 복사"}
      </button>
    </div>
  );
}
