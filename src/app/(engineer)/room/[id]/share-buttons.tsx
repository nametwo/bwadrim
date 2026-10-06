"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ChatBubbleIcon, CheckIcon, CopyIcon, MessageIcon, ShareIcon } from "@/components/ui/icons";
import { kakaoKey, loadKakao, sendKakaoLink } from "@/lib/kakao-share";
import type { KakaoShareArgs } from "@/lib/kakao-webhook";

const noSubscribe = () => () => {};

export type SentVia = "sms" | "kakao" | "share" | "copy";

// 고객에게 보내는 문자 (ROOM-06). 무엇인지·무엇을 누를지·설치가 없다는 것을 먼저 말한다 — 모르는 링크로 보이지 않게
export function inviteMessage(joinUrl: string) {
  return `[봐드림] 원격 A/S 링크입니다.\n링크를 열고 '카메라 켜고 시작하기'를 누른 다음, 고장 난 곳을 비춰 주세요. 앱은 따로 안 깔아도 됩니다.\n${joinUrl}`;
}

// iPadOS 13+ 사파리는 맥처럼 보인다 — 맥인데 터치가 되면 아이패드
function isIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// 문자 앱이 있는 기기(폰·태블릿). PC는 sms: 링크를 눌러도 아무 일이 없어 문자 버튼을 숨긴다
function hasSmsApp() {
  return isIos() || /Android/i.test(navigator.userAgent);
}

/** 이 기기에서 쓸 수 있는 보내기 방법 (ROOM-05). SSR에선 모두 false, 클라이언트에서 기기에 맞춰 하이드레이션 */
export function useSendWays() {
  const sms = useSyncExternalStore(noSubscribe, hasSmsApp, () => false);
  const share = useSyncExternalStore(
    noSubscribe,
    () => !!navigator.share,
    () => false,
  );
  return { sms, share, kakao: !!kakaoKey };
}

type Way = "kakao" | "share" | "copy";

// 고객에게 링크 보내기 (ROOM-05~08·14). 이 기기에서 할 수 있는 것만 띄운다:
//  - 문자로 링크 보내기: 폰에서만. 엔지니어 본인 번호로 가므로 고객에게 아는 번호로 도착한다 (별도 SMS API 불필요)
//  - 카톡 보내기: 카카오 키가 있을 때. 카톡 친구 선택 창을 바로 연다
//  - 공유하기: 기기 공유 창이 있는 브라우저. 카톡 말고 다른 앱(밴드·라인 등)으로도 보낸다
//  - 링크 복사: 늘
// 크게 하나(폰은 문자, 그 밖에 복사만 남으면 복사) + 나머지는 한 줄에 나란히(아이콘 위·글자 아래).
// 문자가 없는 PC에서는 그 한 줄이 곧 누를 것이다(파랑 없음).
// resend: 이미 보낸 뒤(E04)에는 '지금 누를 것'이 없으므로 파란 버튼 대신 회색 '문자 다시 보내기',
// 나머지는 글자 버튼으로 낮춰 화면 아래가 버튼 더미로 무거워지지 않게 한다
export function ShareButtons({
  joinUrl,
  kakaoArgs,
  resend = false,
  onSent,
}: {
  joinUrl: string;
  /** 카톡 전송 웹훅용 서명된 상담 id (ROOM-15·16). 서버에 카카오 어드민 키가 없으면 null */
  kakaoArgs: KakaoShareArgs | null;
  resend?: boolean;
  onSent?: (via: SentVia) => void;
}) {
  const can = useSendWays();
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [kakaoFailed, setKakaoFailed] = useState(false);
  // SDK를 받는 동안은 카톡 버튼을 잠근다. 받기 전에 누르면 받은 뒤 늦게 열려 카톡이 막히는데도 '보냈어요'가 된다
  const [kakaoLoading, setKakaoLoading] = useState(() => !!kakaoKey && typeof window !== "undefined" && !window.Kakao);

  // 누르기 전에 SDK를 받아 둔다. 실패하면 누를 때 한 번 더 받는다
  useEffect(() => {
    if (!kakaoKey || window.Kakao) return;
    let alive = true;
    loadKakao()
      .catch(() => {})
      .finally(() => alive && setKakaoLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const message = inviteMessage(joinUrl);
  const smsLabel = resend ? "문자 다시 보내기" : "문자로 링크 보내기";

  // 한 가지로 보냈으면 다른 방법이 실패했던 안내는 지운다 (보낸 뒤 화면에도 이 버튼들이 그대로 이어진다)
  function sent(via: SentVia) {
    setKakaoFailed(false);
    setCopied((c) => (c === "fail" ? null : c));
    onSent?.(via);
  }

  function sendSms() {
    sent("sms");
    // iOS는 `sms:&body=`, Android는 `sms:?body=`
    window.location.href = `sms:${isIos() ? "&" : "?"}body=${encodeURIComponent(message)}`;
  }

  // 카카오링크(ROOM-14). 실패하면 알려만 준다 — 옆의 다른 버튼으로 보내면 된다
  async function sendKakao() {
    // 미리 받기에 실패했으면 다시 받는 동안 도는 표시
    if (!window.Kakao) setKakaoLoading(true);
    try {
      await sendKakaoLink(joinUrl, kakaoArgs);
      sent("kakao");
    } catch {
      setKakaoFailed(true);
    } finally {
      setKakaoLoading(false);
    }
  }

  async function share() {
    try {
      await navigator.share({ text: message });
      sent("share");
    } catch {
      // 사용자가 공유 창을 닫은 경우 — 무시
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied("ok");
      sent("copy");
      setTimeout(() => setCopied((c) => (c === "ok" ? null : c)), 2500);
    } catch {
      // clipboard 미지원 브라우저 — 주소를 보여 주고 직접 복사하도록 안내 (사라지지 않게 둔다)
      setCopied("fail");
    }
  }

  const ways: Way[] = [...(can.kakao ? (["kakao"] as const) : []), ...(can.share ? (["share"] as const) : []), "copy"];
  // 크게 보일 하나: 폰은 문자. 문자가 없고 복사만 남으면 복사
  const copyIsMain = !can.sms && ways.length === 1;
  const rest = copyIsMain ? [] : ways;

  const copyLabel = copied === "ok" ? "복사됐어요" : "링크 복사";
  const copyIcon = (cls: string) => (copied === "ok" ? <CheckIcon className={cls} /> : <CopyIcon className={cls} />);

  // 카톡이 안 될 때 대신 누를 버튼 이름 ('A'나 'B'로 / 'A', 'B'나 'C'로 — 이름이 모두 모음으로 끝난다)
  const others = [...(can.sms ? [smsLabel] : []), ...(can.share ? ["공유하기"] : []), "링크 복사"].map((n) => `'${n}'`);
  const otherWays = others.length === 1 ? others[0] : `${others.slice(0, -1).join(", ")}나 ${others.at(-1)}`;

  function wayButton(way: Way) {
    const size = resend ? "m" : "l";
    const icon = resend ? "size-5" : "size-[22px]";
    const common = { size, stack: true, className: "whitespace-nowrap" } as const;
    if (way === "kakao") {
      return (
        <Button
          key={way}
          {...common}
          variant={resend ? "ghost" : "kakao"}
          icon={<ChatBubbleIcon className={icon} />}
          loading={kakaoLoading}
          onClick={sendKakao}
          data-testid="share-kakao"
        >
          카톡 보내기
        </Button>
      );
    }
    if (way === "share") {
      return (
        <Button
          key={way}
          {...common}
          variant={resend ? "ghost" : "secondary"}
          icon={<ShareIcon className={icon} />}
          onClick={share}
          data-testid="share-sheet"
        >
          공유하기
        </Button>
      );
    }
    return (
      <Button key={way} {...common} variant={resend ? "ghost" : "secondary"} icon={copyIcon(icon)} onClick={copy} data-testid="share-copy">
        {copyLabel}
      </Button>
    );
  }

  return (
    <div className={`flex flex-col ${resend ? "gap-1" : "gap-2"}`}>
      {can.sms && (
        <Button
          variant={resend ? "secondary" : "primary"}
          size={resend ? "l" : "xl"}
          block
          icon={<MessageIcon className="size-6" />}
          onClick={sendSms}
          data-testid="share-sms"
        >
          {smsLabel}
        </Button>
      )}
      {copyIsMain && (
        <Button
          variant={resend ? "secondary" : "primary"}
          size={resend ? "l" : "xl"}
          block
          icon={copyIcon("size-6")}
          onClick={copy}
          data-testid="share-copy"
        >
          {copyLabel}
        </Button>
      )}
      {rest.length > 1 ? (
        <div className={`grid gap-2 ${rest.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>{rest.map(wayButton)}</div>
      ) : (
        // 문자 아래 복사 하나만 남으면 글자 버튼 하나
        rest.length === 1 && (
          <Button
            variant="ghost"
            size="m"
            className="self-center whitespace-nowrap"
            onClick={copy}
            icon={copyIcon("size-5")}
            data-testid="share-copy"
          >
            {copyLabel}
          </Button>
        )
      )}
      {kakaoFailed && (
        <div role="status" className="flex flex-col gap-1 text-center text-body-s" data-testid="share-kakao-fail">
          <p className="text-text-danger">카카오톡을 열지 못했어요</p>
          <p className="text-text-secondary">{otherWays}로 보내 주세요</p>
        </div>
      )}
      {copied === "fail" && (
        <div role="status" className="flex flex-col gap-1 text-center text-body-s" data-testid="share-copy-fail">
          <p className="text-text-danger">복사가 안 돼요</p>
          <p className="text-text-secondary">아래 주소를 직접 복사해 주세요</p>
          <p className="break-all text-text-primary select-all">{joinUrl}</p>
        </div>
      )}
    </div>
  );
}
