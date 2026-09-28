"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error";
import { redactText } from "@/lib/redact";

declare global {
  interface Window {
    __bwHydrated?: boolean;
  }
}

// 모든 화면에서 잡히지 않은 JS 오류를 보고한다 (client_error, DATA-01).
// 붙은 순간 __bwHydrated를 켠다 — 고객 링크 화면의 감시 스크립트(hydration-watchdog)가 10초 안에 이 표시가 없으면
// 'JS가 안 돈다'(no_hydration)로 보고한다.
export function ClientErrorReporter() {
  useEffect(() => {
    window.__bwHydrated = true;
    const onError = (e: ErrorEvent) => {
      reportClientError("error", e.error ?? e.message, {
        file: e.filename ? `${redactText(e.filename, 200)}:${e.lineno}:${e.colno}` : undefined,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => reportClientError("rejection", e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
