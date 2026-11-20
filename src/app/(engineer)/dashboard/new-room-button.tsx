"use client";

import { createPortal, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import { PageSkeleton } from "@/components/page-skeleton";
import { requestMicAhead } from "@/lib/webrtc/mic-ahead";

// 처리 중엔 잠가서 여러 번 눌러도 세션이 하나만 생기게 한다 (BUG-11).
// 누르는 탭 안에서 마이크를 미리 요청해 두면 세션 화면이 뜨자마자 통화 대기를 시작한다 (CALL-01)
// 앱처럼 (NFR-12): 상담을 만드는 동안(1초 남짓) 버튼만 돌지 않고, 누르자마자 상담 화면 뼈대가 오른쪽에서 밀려 들어온다.
// 만들어지면 진짜 상담 화면이 같은 자리에 뜬다. 이번 달 상담을 다 썼으면 뼈대가 걷히고 목록의 안내가 보인다(ROOM-17)
export function NewRoomButton() {
  const { pending } = useFormStatus();
  return (
    <>
      <Button
        type="submit"
        size="xl"
        block
        loading={pending}
        onClick={() => requestMicAhead("new")}
        icon={<PlusIcon className="size-6" />}
      >
        {pending ? "만드는 중…" : "새 A/S 시작"}
      </Button>
      {pending &&
        createPortal(
          <div className="fixed inset-0 z-50 motion-safe:animate-[page-push_260ms_cubic-bezier(0.2,0,0,1)_both]">
            <PageSkeleton kind="page" back="icon" instant />
          </div>,
          document.body,
        )}
    </>
  );
}
