"use client";

import { useEffect } from "react";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { Button } from "@/components/ui/button";
import { AlertIcon, RefreshIcon } from "@/components/ui/icons";

// 서버 오류 (BUG-13). 세션 만들기 실패 등
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <NoticeScreen
      tone="warning"
      icon={<AlertIcon className="size-10" />}
      title="잠시 문제가 생겼어요"
      actions={
        <Button size="xl" block onClick={() => retry()} icon={<RefreshIcon className="size-6" />}>
          다시 시도
        </Button>
      }
    >
      잠시 후 다시 시도해 주세요.
    </NoticeScreen>
  );
}
