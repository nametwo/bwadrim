"use client";

import { useState } from "react";
import { Banner } from "@/components/ui/banner";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Button } from "@/components/ui/button";
import { AlertIcon, CheckIcon, DownloadIcon, PhoneOffIcon } from "@/components/ui/icons";
import { savePhotos, type TakenPhoto } from "@/lib/photo-save";

// 찍은 사진 저장 (CALL-16, ROOM-10). 상담을 닫은 뒤, 통화 중 찍은 사진이 있을 때만 뜬다.
// 사진은 이 기기 메모리에만 있어서(서버에 올리지 않는다) 이 화면을 떠나면 사라진다.
// 할 일이 질문 하나라 질문이 곧 제목이다. 저장하면 바로 떠나고, '저장 안 하고 나가기'도 한 번 더 묻지 않는다.
export function PhotoSaveView({
  photos,
  byCustomer,
  relogin,
  onLeave,
}: {
  photos: TakenPhoto[];
  /** 고객이 먼저 통화를 끝냈다 — 맨 위에 알린다 */
  byCustomer: boolean;
  /** 로그인이 풀려 상담을 닫지 못했다 — 사진부터 챙기고 다시 로그인한다 */
  relogin: boolean;
  /** 이 화면을 떠난다 (상담 목록 또는 다시 로그인) */
  onLeave: () => void;
}) {
  const [saveState, setSaveState] = useState<"idle" | "saving" | "failed">("idle");
  const n = photos.length;

  // 반드시 버튼 탭 안에서 (공유 창은 사용자 제스처가 있어야 열린다). 공유 창을 그냥 닫으면 그대로 둔다
  async function save() {
    setSaveState("saving");
    const r = await savePhotos(photos);
    if (r === "saved") {
      onLeave();
      return;
    }
    setSaveState(r === "failed" ? "failed" : "idle");
  }

  // 띠 아이콘: 기본(시계·와이파이)은 '기다리는 중'·'연결 불안정'으로 읽혀서 내용에 맞춰 바꾼다
  return (
    <main
      data-testid="eng-photo-save"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(20px,env(safe-area-inset-top))]"
    >
      {relogin ? (
        <Banner flat tone="warning" role="alert" icon={<AlertIcon className="size-[22px]" />} sub="사진을 저장하고 다시 로그인해 주세요.">
          로그인이 풀려서 상담을 끝내지 못했어요
        </Banner>
      ) : (
        byCustomer && (
          <Banner flat tone="info" role="status" icon={<PhoneOffIcon className="size-[22px]" />} sub="상담도 같이 끝났어요.">
            고객님이 통화를 끝냈어요
          </Banner>
        )
      )}

      <section className="flex flex-col gap-2 pt-5">
        <h1 className="text-title-l">
          찍은 사진 {n}장을
          <br />
          저장할까요?
        </h1>
        <p className="text-body-m text-text-secondary">저장 안 하면 이 화면을 나갈 때 지워져요.</p>
      </section>

      <ul data-testid="eng-photos" className="mt-8 grid grid-cols-3 gap-2">
        {photos.map((p, i) => (
          <li key={p.id}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 이 기기 메모리의 사진(blob:) */}
            <img src={p.url} alt={`찍은 사진 ${i + 1}`} className="aspect-square w-full rounded-2xl bg-bg-subtle object-cover" />
          </li>
        ))}
      </ul>

      <BottomCta>
        {saveState === "failed" && (
          <p role="alert" className="text-center text-body-m font-medium text-text-danger">
            저장하지 못했어요. 다시 눌러 주세요.
          </p>
        )}
        <Button
          size="xl"
          block
          loading={saveState === "saving"}
          onClick={save}
          icon={<DownloadIcon className="size-6" />}
        >
          {saveState === "saving" ? "저장하는 중…" : `사진 ${n}장 저장하기`}
        </Button>
        <Button variant="ghost" size="l" block onClick={onLeave}>
          저장 안 하고 나가기
        </Button>
      </BottomCta>
    </main>
  );
}

// 상담을 닫지 못한 화면(ROOM-10)에서 사진부터 챙기는 회색 버튼. 저장은 인터넷 없이도 된다(공유 창·다운로드).
// 저장한 뒤 상담이 닫히면 사진 저장 화면을 건너뛴다. 사진 저장 화면과 같은 저장 방식(savePhotos)
export function SavePhotosFirst({
  photos,
  saved,
  onSaved,
}: {
  photos: TakenPhoto[];
  saved: boolean;
  onSaved: () => void;
}) {
  const [saveState, setSaveState] = useState<"idle" | "saving" | "failed">("idle");
  const n = photos.length;

  // 반드시 버튼 탭 안에서 (공유 창은 사용자 제스처가 있어야 열린다)
  async function save() {
    setSaveState("saving");
    const r = await savePhotos(photos);
    setSaveState(r === "failed" ? "failed" : "idle");
    if (r === "saved") onSaved();
  }

  return (
    <>
      {saveState === "failed" && (
        <p role="alert" className="text-center text-body-m font-medium text-text-danger">
          사진을 저장하지 못했어요. 다시 눌러 주세요.
        </p>
      )}
      <Button
        data-testid="eng-photo-save-first"
        variant="secondary"
        size="xl"
        block
        disabled={saved}
        loading={saveState === "saving"}
        onClick={save}
        icon={saved ? <CheckIcon className="size-6" /> : <DownloadIcon className="size-6" />}
      >
        {saveState === "saving" ? "저장하는 중…" : saved ? `사진 ${n}장을 저장했어요` : `사진 ${n}장 먼저 저장하기`}
      </Button>
    </>
  );
}
