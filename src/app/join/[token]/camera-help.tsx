"use client";

import { useState } from "react";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { Button } from "@/components/ui/button";
import { AlertIcon, CameraIcon, CopyIcon, PhoneIcon, RefreshIcon } from "@/components/ui/icons";

// 카메라를 켜지 못했을 때 (JOIN-05, 피그마 C04). 원인마다 할 일이 달라서 나눠 안내하고, 기기별 설정 경로를 짧게.
//  - blocked: '허용 안 함'을 눌렀거나 폰 설정에서 막힘 → 이 폰에서 권한을 켜는 방법(아이폰·안드로이드 따로)
//  - busy: 다른 앱이 카메라를 쓰는 중 → 그 앱을 닫기
//  - missing: 카메라가 없음 → 다른 폰으로
//  - unsupported: 카메라 기능이 없는 화면(오래된 브라우저·앱 안 화면) → 인터넷 앱으로 열기

export type CameraFailure = "blocked" | "busy" | "missing" | "unsupported";

/** getUserMedia 오류 이름 → 고객에게 안내할 원인 */
export function cameraFailureOf(errorName: string): CameraFailure {
  if (errorName === "NotReadableError" || errorName === "AbortError" || errorName === "TrackStartError") return "busy";
  if (errorName === "NotFoundError" || errorName === "OverconstrainedError" || errorName === "DevicesNotFoundError") {
    return "missing";
  }
  if (errorName === "unsupported") return "unsupported";
  return "blocked";
}

type Platform = "ios" | "android" | "other";

function platformOf(ua: string): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

const STEPS: Record<Platform, React.ReactNode[]> = {
  ios: [
    <>
      주소창 왼쪽의 <b>가가</b>(또는 메뉴) 버튼을 누르세요
    </>,
    <>
      <b>웹 사이트 설정</b>을 누르세요
    </>,
    <>
      <b>카메라</b>와 <b>마이크</b>를 <b>허용</b>으로 바꾸세요
    </>,
    <>
      아래 <b>다시 시도하기</b>를 누르세요
    </>,
  ],
  android: [
    <>
      주소창 왼쪽의 <b>자물쇠</b>(또는 조절) 모양을 누르세요
    </>,
    <>
      <b>권한</b>을 누르세요
    </>,
    <>
      <b>카메라</b>와 <b>마이크</b>를 켜세요
    </>,
    <>
      아래 <b>새로고침</b>을 누르세요
    </>,
  ],
  other: [
    <>
      주소창의 <b>카메라</b> 또는 <b>자물쇠</b> 모양을 누르세요
    </>,
    <>
      카메라와 마이크를 <b>허용</b>으로 바꾸세요
    </>,
    <>
      아래 <b>새로고침</b>을 누르세요
    </>,
  ],
};

export function CameraHelp({ failure, onRetry }: { failure: CameraFailure; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const platform = platformOf(navigator.userAgent);

  const retry = (
    <Button size="xl" block onClick={onRetry} icon={<RefreshIcon className="size-6" />}>
      다시 시도하기
    </Button>
  );
  const reload = (
    <Button
      size="l"
      variant="secondary"
      block
      onClick={() => window.location.reload()}
      icon={<RefreshIcon className="size-5" />}
    >
      새로고침
    </Button>
  );

  if (failure === "busy") {
    return (
      <NoticeScreen
        testId="cust-camera-help"
        tone="warning"
        icon={<CameraIcon className="size-10" />}
        title="다른 앱이 카메라를 쓰고 있어요"
        actions={retry}
      >
        카메라·영상통화 앱을 닫은 뒤
        <br />
        아래 버튼을 다시 눌러 주세요.
      </NoticeScreen>
    );
  }

  if (failure === "missing") {
    return (
      <NoticeScreen
        testId="cust-camera-help"
        tone="warning"
        icon={<PhoneIcon className="size-10" />}
        title="카메라를 찾지 못했어요"
        actions={retry}
      >
        카메라가 있는 폰에서
        <br />
        문자 속 링크를 열어 주세요.
      </NoticeScreen>
    );
  }

  if (failure === "unsupported") {
    return (
      <NoticeScreen
        testId="cust-camera-help"
        tone="warning"
        icon={<AlertIcon className="size-10" />}
        title="이 화면에서는 카메라를 켤 수 없어요"
        actions={
          <Button
            size="xl"
            block
            icon={<CopyIcon className="size-6" />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setCopied(true);
              } catch {
                // 복사가 막힌 화면 — 안내대로 인터넷 앱에서 문자 링크를 다시 누르면 된다
              }
            }}
          >
            {copied ? "복사됐어요" : "링크 복사"}
          </Button>
        }
        footer="복사한 링크를 사파리·크롬·삼성 인터넷 주소창에 붙여 넣어 주세요."
      >
        사파리나 크롬 같은 <b className="text-text-primary">인터넷 앱</b>으로
        <br />
        링크를 열어 주세요.
      </NoticeScreen>
    );
  }

  return (
    <NoticeScreen
      testId="cust-camera-help"
      tone="danger"
      icon={<CameraIcon className="size-10" />}
      title="카메라가 꺼져 있어요"
      actions={
        <>
          {retry}
          {reload}
        </>
      }
    >
      <p>
        기사님이 화면을 보려면 카메라가 필요해요.
        <br />
        아래 순서대로 켜 주세요.
      </p>
      <ol className="mt-4 flex flex-col gap-3 rounded-3xl bg-bg-subtle p-4 text-left text-text-primary">
        {STEPS[platform].map((step, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden="true"
              className="grid size-7 flex-none place-items-center rounded-full bg-bg-page text-label-m text-text-secondary ring-1 ring-border"
            >
              {i + 1}
            </span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      {platform === "ios" && (
        <p className="mt-3 text-body-s">
          그래도 안 되면 폰의 <b>설정 → Safari → 카메라</b>를 <b>허용</b>으로 바꿔 주세요.
        </p>
      )}
    </NoticeScreen>
  );
}
