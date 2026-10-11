"use client";

import { useState } from "react";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { Button } from "@/components/ui/button";
import { AlertIcon, CameraIcon, CopyIcon, PhoneIcon, RefreshIcon } from "@/components/ui/icons";
import { detectWebView } from "@/lib/in-app-browser";
import { iosBrowserApp, isIOSDevice } from "@/lib/install-guide";

// 카메라를 켜지 못했을 때 (JOIN-05, 피그마 C04). 원인마다 할 일이 달라서 나눠 안내하고, 기기별 설정 경로를 짧게.
//  - blocked: '허용 안 함'을 눌렀거나 폰 설정에서 막힘 → 이 폰에서 권한을 켜는 방법(아이폰·안드로이드 따로)
//  - busy: 다른 앱이 카메라를 쓰는 중 → 그 앱을 닫기
//  - missing: 카메라가 없음 → 다른 폰으로
//  - unsupported: 카메라 기능이 없는 화면(오래된 브라우저·앱 안 화면) → 인터넷 앱으로 열기.
//    이름을 모르는 앱의 웹뷰에서 막힘(blocked)이 나도 여기로: 웹뷰에는 주소창·권한 메뉴가 없어서 켜는 방법을 따라 할 수 없다 (JOIN-10)

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

// ios = 아이폰·아이패드 사파리, ios-app = 아이폰의 크롬 같은 다른 인터넷 앱(카메라 권한이 '설정 → 그 앱'에 있다)
type Platform = "ios" | "ios-app" | "android" | "other";

function platformOf(ua: string, maxTouchPoints: number): Platform {
  // 아이패드 사파리는 맥처럼 보여서 터치 여부로 가린다
  if (isIOSDevice(ua, maxTouchPoints)) return iosBrowserApp(ua) ? "ios-app" : "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/** 사파리가 아닌 아이폰 인터넷 앱: 폰 설정 앱에서 그 앱의 카메라·마이크를 켠다 */
function iosAppSteps(app: string): React.ReactNode[] {
  return [
    <>
      폰의 <b>설정</b> 앱을 여세요
    </>,
    <>
      <b>{app}</b> 항목을 누르세요
    </>,
    <>
      <b>카메라</b>와 <b>마이크</b>를 켜세요
    </>,
    <>
      이 화면으로 돌아와 아래 <b>다시 시도하기</b>를 누르세요
    </>,
  ];
}

const STEPS: Record<Exclude<Platform, "ios-app">, React.ReactNode[]> = {
  ios: [
    <>
      주소창 왼쪽의 <b>가가</b> 버튼이나 메뉴 버튼을 누르세요
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
      주소창 왼쪽의 <b>자물쇠</b>나 조절 모양을 누르세요
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

export function CameraHelp({ failure: reported, onRetry }: { failure: CameraFailure; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const ua = navigator.userAgent;
  const platform = platformOf(ua, navigator.maxTouchPoints);
  const failure: CameraFailure = reported === "blocked" && detectWebView(ua) ? "unsupported" : reported;
  const steps = platform === "ios-app" ? iosAppSteps(iosBrowserApp(ua) ?? "") : STEPS[platform];

  const retry = (
    <Button size="xl" block onClick={onRetry} icon={<RefreshIcon className="size-6" />}>
      다시 시도하기
    </Button>
  );
  const reload = (
    <Button
      size="xl"
      variant="secondary"
      block
      onClick={() => window.location.reload()}
      icon={<RefreshIcon className="size-6" />}
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
        카메라나 영상통화 앱을 닫고
        <br />
        ‘다시 시도하기’를 눌러 주세요.
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
        문자나 카톡으로 받으신 링크를 열어 주세요.
      </NoticeScreen>
    );
  }

  if (failure === "unsupported") {
    return (
      <NoticeScreen
        testId="cust-camera-help"
        tone="warning"
        icon={<AlertIcon className="size-10" />}
        title={
          <>
            이 화면에서는
            <br />
            카메라를 켤 수 없어요
          </>
        }
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
                // 복사가 막힌 화면 — 안내대로 인터넷 앱에서 문자·카톡 링크를 다시 누르면 된다
              }
            }}
          >
            {copied ? "복사됐어요" : "링크 복사"}
          </Button>
        }
        footer="복사한 링크를 사파리·크롬·삼성 인터넷 주소창에 붙여 넣어 주세요."
        footerSize="l"
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
      <p>아래 순서대로 켜 주세요.</p>
      <ol className="mt-6 flex flex-col gap-4 rounded-3xl bg-bg-subtle p-5 text-left text-text-primary">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden="true"
              className="grid size-8 flex-none place-items-center rounded-full bg-primary-tint text-label-l text-text-brand"
            >
              {i + 1}
            </span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      {/* 사파리만: 다른 인터넷 앱은 위 단계가 이미 설정 앱 경로다 */}
      {platform === "ios" && (
        <p className="mt-3 text-left text-body-l">
          그래도 안 되면 폰의 <b>설정 → Safari → 카메라</b>를 <b>허용</b>으로 바꿔 주세요.
        </p>
      )}
    </NoticeScreen>
  );
}
