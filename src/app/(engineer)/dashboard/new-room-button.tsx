"use client";

import { useFormStatus } from "react-dom";

// 처리 중엔 잠가서 여러 번 눌러도 세션이 하나만 생기게 한다 (BUG-11)
export function NewRoomButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-16 w-full rounded-2xl bg-black text-xl font-semibold text-white active:opacity-80 disabled:opacity-50"
    >
      {pending ? "만드는 중…" : "+ 새 원격 A/S 시작"}
    </button>
  );
}
