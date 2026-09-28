"use client";

import { useSyncExternalStore } from "react";
import { BrandMark } from "@/components/ui/brand";
import { Button } from "@/components/ui/button";
import { EngineerCard } from "@/components/ui/engineer-card";
import { ArrowRightIcon, CameraIcon, HandTapIcon } from "@/components/ui/icons";

const noSubscribe = () => () => {};

// 고객 시작 화면 (JOIN-02, 피그마 C01·C02). 문자로 링크를 받은 사장님이 처음 보는 화면:
//  - 어디서 온 링크인지(봐드림), 누가 기다리는지(기사님 카드) — 모르는 링크는 누르지 않는다
//  - 할 일 세 단계. 사람들이 가장 많이 멈추는 '허용' 창은 그림으로 미리 보여 주고, 화살표 안내도 미리 한 줄
//  - 누를 것은 아래쪽 파란 버튼 하나(64px)
// 버튼을 누른 뒤(starting) 권한 창이 떠 있는 동안은 화면을 어둡게 하고 노란 화살표로 '허용'을 가리킨다(C02).
// 권한 창 위치: 아이폰은 가운데, 안드로이드는 아래쪽.
export function StartScreen({
  starting,
  onStart,
  engineerName,
}: {
  starting: boolean;
  onStart: () => void;
  engineerName: string | null;
}) {
  const android = useSyncExternalStore(
    noSubscribe,
    () => /Android/i.test(navigator.userAgent),
    () => false,
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(16px,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2 py-2">
        <BrandMark className="size-7" />
        <span className="text-label-l text-text-primary">봐드림</span>
      </header>

      <section className="flex flex-1 flex-col gap-6 pt-5 pb-4">
        <h1 className="text-display-l text-text-primary">
          고장 난 곳을
          <br />
          폰 카메라로 보여 주세요
        </h1>

        {engineerName && (
          <div className="flex flex-col gap-2">
            <p className="text-caption text-text-secondary">기다리고 있는 기사님</p>
            <EngineerCard name={engineerName} />
          </div>
        )}

        <ol className="flex flex-col gap-4">
          <Step n={1}>아래 버튼을 누르면 카메라가 켜져요</Step>
          <Step n={2} extra={<AllowPreview />}>
            창이 뜨면 <b className="text-text-brand">&lsquo;허용&rsquo;</b>을 눌러 주세요
          </Step>
          <Step n={3}>
            화살표가 나오면
            <br />
            그쪽으로 폰을 천천히 옮겨 주세요
          </Step>
        </ol>
      </section>

      <div className="sticky bottom-0 -mx-5 flex flex-col gap-2 bg-bg-page/95 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur">
        <Button size="xl" block onClick={onStart} loading={starting} icon={<CameraIcon className="size-6" />}>
          {starting ? "카메라 켜는 중…" : "카메라 켜고 시작하기"}
        </Button>
        <p className="text-center text-body-s text-text-secondary">앱 설치 없이 바로 연결돼요 · 영상은 저장하지 않아요</p>
      </div>

      {starting && <AllowOverlay android={android} />}
    </main>
  );
}

function Step({ n, extra, children }: { n: number; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="grid size-7 flex-none place-items-center rounded-full bg-bg-muted text-label-m text-text-secondary"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <p className="text-body-l text-text-primary">{children}</p>
        {extra}
      </div>
    </li>
  );
}

// 폰마다 권한 창 모양은 다르지만 '허용'이라는 글자는 같다 — 그 글자를 찾으라고 그림으로 보여 준다
function AllowPreview() {
  return (
    <div aria-hidden="true" className="w-full max-w-64 overflow-hidden rounded-xl bg-bg-page text-body-s shadow-card ring-1 ring-border">
      <p className="px-3 pt-2.5 pb-2 text-center text-text-secondary">카메라와 마이크에 접근하려고 합니다</p>
      <div className="grid grid-cols-2 border-t border-border text-center">
        <span className="py-2 text-text-tertiary">허용 안 함</span>
        <span className="relative border-l border-border py-2 font-bold text-text-brand">
          허용
          <HandTapIcon className="absolute top-3 right-3 size-6 text-text-primary" />
        </span>
      </div>
    </div>
  );
}

// 권한 창이 떠 있는 동안 (피그마 C02): 어둡게 하고, 창이 뜨는 쪽으로 노란 화살표 + '허용'을 눌러 주세요
function AllowOverlay({ android }: { android: boolean }) {
  return (
    <div
      role="status"
      aria-live="assertive"
      // 이미 허용해 둔 폰은 창 없이 바로 켜진다 — 잠깐 번쩍이지 않게 조금 늦게 나타난다
      className={`fixed inset-0 z-40 flex animate-[fade-in_0.2s_ease-out_0.4s_both] flex-col items-center bg-black-50 px-6 ${
        android ? "justify-end pb-[42svh]" : "justify-start pt-[62svh]"
      }`}
    >
      <div className={`flex flex-col items-center gap-2 ${android ? "flex-col-reverse" : ""}`}>
        <ArrowRightIcon
          className={`size-10 text-guide-signal drop-shadow-[0_2px_6px_rgb(0_0_0/0.6)] ${android ? "rotate-90" : "-rotate-90"}`}
          strokeWidth={3}
        />
        <p className="text-center text-title-l text-gray-0 drop-shadow-[0_2px_6px_rgb(0_0_0/0.6)]">
          <span className="text-guide-signal">&lsquo;허용&rsquo;</span>을 눌러 주세요
        </p>
      </div>
    </div>
  );
}
