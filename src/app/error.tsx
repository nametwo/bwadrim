"use client";

import { useEffect } from "react";

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
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="text-2xl font-bold">잠시 문제가 생겼어요</h1>
      <p className="text-lg text-gray-600">잠시 후 다시 시도해 주세요.</p>
      <button
        onClick={() => retry()}
        className="mt-2 h-14 rounded-xl bg-black px-8 text-lg font-semibold text-white"
      >
        다시 시도
      </button>
    </main>
  );
}
