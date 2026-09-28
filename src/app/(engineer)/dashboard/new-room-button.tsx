"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import { requestMicAhead } from "@/lib/webrtc/mic-ahead";

// 처리 중엔 잠가서 여러 번 눌러도 세션이 하나만 생기게 한다 (BUG-11).
// 누르는 탭 안에서 마이크를 미리 요청해 두면 세션 화면이 뜨자마자 통화 대기를 시작한다 (CALL-01)
export function NewRoomButton() {
  const { pending } = useFormStatus();
  return (
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
  );
}
