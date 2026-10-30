"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { deleteAccount } from "./actions";

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" size="xl" block loading={pending} data-testid="delete-confirm">
      {pending ? "탈퇴하는 중…" : "탈퇴하기"}
    </Button>
  );
}

// 회원 탈퇴 (AUTH-11). 글자 버튼 → 확인 창 한 번 → 계정과 기록을 지운다
export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="m" block onClick={() => setOpen(true)} data-testid="delete-open">
        회원 탈퇴
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="탈퇴할까요?"
        description="상담 기록과 받는 분 이름표가 모두 지워져요. 되돌릴 수 없어요."
        testId="delete-sheet"
      >
        <form action={deleteAccount} className="flex flex-col">
          <ConfirmButton />
        </form>
        <Button variant="secondary" size="xl" block onClick={() => setOpen(false)}>
          취소
        </Button>
      </Sheet>
    </>
  );
}
