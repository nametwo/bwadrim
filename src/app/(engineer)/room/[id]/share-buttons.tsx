"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ChatBubbleIcon, CheckIcon, CopyIcon, MessageIcon } from "@/components/ui/icons";

const noSubscribe = () => () => {};

// 고객에게 보내는 문자 (ROOM-06). 무엇인지·무엇을 누를지·설치가 없다는 것을 먼저 말한다 — 모르는 링크로 보이지 않게
export function inviteMessage(joinUrl: string) {
  return `[봐드림] 원격 A/S 링크예요.\n링크를 누르고 '카메라 켜기'를 눌러 고장 난 곳을 비춰 주세요. (앱 설치 없음)\n${joinUrl}`;
}

// 엔지니어 본인 폰의 문자/공유 시트를 연다.
// 본인 번호로 발송되므로 고객에게 아는 번호로 도착한다 — 별도 SMS API 불필요.
// primary: 문자 버튼을 파란(지금 누를 것) 버튼으로 둘지. 이미 보냈거나 다른 할 일이 있는 화면에서는 끈다
export function ShareButtons({
  joinUrl,
  primary = true,
  tone = "light",
}: {
  joinUrl: string;
  primary?: boolean;
  tone?: "light" | "dark";
}) {
  // SSR에선 false, 클라이언트에서 지원 여부로 하이드레이션
  const canShare = useSyncExternalStore(
    noSubscribe,
    () => !!navigator.share,
    () => false,
  );
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [opened, setOpened] = useState(false);

  const message = inviteMessage(joinUrl);

  function smsHref() {
    // iOS는 `sms:&body=`, Android는 `sms:?body=`
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    return `sms:${ios ? "&" : "?"}body=${encodeURIComponent(message)}`;
  }

  async function share() {
    try {
      await navigator.share({ text: message });
      setOpened(true);
    } catch {
      // 사용자가 공유 시트를 닫은 경우 — 무시
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied("ok");
    } catch {
      // clipboard 미지원 브라우저 — 아래 주소를 길게 눌러 직접 복사하도록 안내
      setCopied("fail");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  const dark = tone === "dark";
  const neutral = dark ? "call" : "secondary";

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant={primary ? "primary" : neutral}
        size="xl"
        block
        icon={<MessageIcon className="size-6" />}
        onClick={() => {
          setOpened(true);
          window.location.href = smsHref();
        }}
      >
        문자로 링크 보내기
      </Button>

      <div className={canShare ? "grid grid-cols-2 gap-3" : "flex flex-col"}>
        {canShare && (
          // 기기 공유 창(카카오톡·밴드 등)으로 같은 문구를 보낸다 (ROOM-07)
          <Button
            variant="kakao"
            size="l"
            icon={<ChatBubbleIcon className="size-5" />}
            onClick={share}
            className="whitespace-nowrap"
          >
            카톡 공유
          </Button>
        )}
        <Button
          variant={neutral}
          size="l"
          className="whitespace-nowrap"
          onClick={copy}
          icon={copied === "ok" ? <CheckIcon className="size-5" /> : <CopyIcon className="size-5" />}
        >
          {copied === "ok" ? "복사됐어요" : "링크 복사"}
        </Button>
      </div>

      <p
        className={`break-all rounded-xl px-3 py-2 text-body-s select-all ${
          dark ? "bg-call-control text-call-text-secondary" : "bg-bg-subtle text-text-secondary"
        }`}
      >
        {joinUrl}
      </p>
      <p role="status" className={`text-body-s ${dark ? "text-call-text-secondary" : "text-text-secondary"}`}>
        {copied === "fail"
          ? "복사가 안 돼요. 위 주소를 길게 눌러 복사해 주세요."
          : opened
            ? "보냈다면 고객님이 링크를 열 때까지 기다려 주세요."
            : "링크는 24시간 동안 쓸 수 있어요."}
      </p>
    </div>
  );
}
