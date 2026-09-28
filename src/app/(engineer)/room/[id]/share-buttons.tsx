"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ChatBubbleIcon, CheckIcon, CopyIcon, MessageIcon } from "@/components/ui/icons";

const noSubscribe = () => () => {};

export type SentVia = "sms" | "share" | "copy";

// 고객에게 보내는 문자 (ROOM-06). 무엇인지·무엇을 누를지·설치가 없다는 것을 먼저 말한다 — 모르는 링크로 보이지 않게
export function inviteMessage(joinUrl: string) {
  return `[봐드림] 원격 A/S 링크예요.\n링크를 누르고 '카메라 켜고 시작하기'를 눌러 고장 난 곳을 비춰 주세요. (앱 설치 없음)\n${joinUrl}`;
}

// 엔지니어 본인 폰의 문자/공유 시트를 연다 (피그마 E03·E04).
// 본인 번호로 발송되므로 고객에게 아는 번호로 도착한다 — 별도 SMS API 불필요.
// resend: 이미 보낸 뒤(E04)에는 '지금 누를 것'이 없으므로 파란 버튼 대신 회색 '문자 다시 보내기',
// 카톡·복사는 글자 버튼으로 낮춰 화면 아래가 버튼 더미로 무거워지지 않게 한다
export function ShareButtons({
  joinUrl,
  resend = false,
  onSent,
}: {
  joinUrl: string;
  resend?: boolean;
  onSent?: (via: SentVia) => void;
}) {
  // SSR에선 false, 클라이언트에서 지원 여부로 하이드레이션
  const canShare = useSyncExternalStore(
    noSubscribe,
    () => !!navigator.share,
    () => false,
  );
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  const message = inviteMessage(joinUrl);

  function smsHref() {
    // iOS는 `sms:&body=`, Android는 `sms:?body=`
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    return `sms:${ios ? "&" : "?"}body=${encodeURIComponent(message)}`;
  }

  async function share() {
    try {
      await navigator.share({ text: message });
      onSent?.("share");
    } catch {
      // 사용자가 공유 시트를 닫은 경우 — 무시
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied("ok");
      onSent?.("copy");
      setTimeout(() => setCopied(null), 2500);
    } catch {
      // clipboard 미지원 브라우저 — 주소를 보여 주고 길게 눌러 직접 복사하도록 안내 (사라지지 않게 둔다)
      setCopied("fail");
    }
  }

  const small = resend || !canShare;
  const copyButton = (
    <Button
      variant={small ? "ghost" : "secondary"}
      size={small ? "m" : "l"}
      className="whitespace-nowrap"
      onClick={copy}
      icon={copied === "ok" ? <CheckIcon className="size-5" /> : <CopyIcon className="size-5" />}
    >
      {copied === "ok" ? "복사됐어요" : canShare ? "링크 복사" : "링크만 복사하기"}
    </Button>
  );

  return (
    <div className={`flex flex-col ${resend ? "gap-1" : "gap-2"}`}>
      <Button
        variant={resend ? "secondary" : "primary"}
        size={resend ? "l" : "xl"}
        block
        icon={<MessageIcon className="size-6" />}
        onClick={() => {
          onSent?.("sms");
          window.location.href = smsHref();
        }}
      >
        {resend ? "문자 다시 보내기" : "문자로 링크 보내기"}
      </Button>
      {canShare ? (
        <div className="grid grid-cols-2 gap-2">
          {/* 기기 공유 창(카카오톡·밴드 등)으로 같은 문구를 보낸다 (ROOM-07) */}
          <Button
            variant={resend ? "ghost" : "kakao"}
            size={resend ? "m" : "l"}
            icon={<ChatBubbleIcon className="size-5" />}
            onClick={share}
            className="whitespace-nowrap"
          >
            카톡 공유
          </Button>
          {copyButton}
        </div>
      ) : (
        copyButton
      )}
      {copied === "fail" && (
        <div role="status" className="flex flex-col gap-1 text-center text-body-s">
          <p className="text-text-danger">복사가 안 돼요. 아래 주소를 길게 눌러 복사해 주세요.</p>
          <p className="break-all text-text-secondary select-all">{joinUrl}</p>
        </div>
      )}
    </div>
  );
}
