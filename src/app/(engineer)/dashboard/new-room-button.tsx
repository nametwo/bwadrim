"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { PlusIcon, Spinner } from "@/components/ui/icons";

// 처리 중엔 잠가서 여러 번 눌러도 세션이 하나만 생기게 한다 (BUG-11)
export function NewRoomButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="xl"
      block
      disabled={pending}
      className="disabled:opacity-100"
      icon={pending ? <Spinner className="size-6" /> : <PlusIcon className="size-7" />}
    >
      {pending ? "만드는 중…" : "새 A/S 시작"}
    </Button>
  );
}
