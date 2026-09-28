"use client";

import { useEffect } from "react";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { Button } from "@/components/ui/button";
import { AlertIcon, RefreshIcon } from "@/components/ui/icons";
import { reportClientError } from "@/lib/client-error";

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
    // 고객·엔지니어 상담 화면이면 client_error로 남는다 (DATA-01). digest = 서버 로그에서 같은 오류를 찾는 열쇠
    reportClientError("render", error, { digest: error.digest });
  }, [error]);

  return (
    <NoticeScreen
      tone="warning"
      icon={<AlertIcon className="size-10" />}
      title="잠깐 문제가 생겼어요"
      actions={
        <Button size="xl" block onClick={() => retry()} icon={<RefreshIcon className="size-6" />}>
          다시 시도
        </Button>
      }
    >
      조금 있다가 다시 눌러 주세요.
    </NoticeScreen>
  );
}
