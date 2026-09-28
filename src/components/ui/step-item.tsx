import type { ReactNode } from "react";
import { AlertIcon, CheckIcon } from "./icons";

// 진행 단계 한 줄 — 피그마 Components → StepItem.
//  done: 초록 원 + 체크 · current: 주황 테두리 원 + 점, 굵은 글씨 · todo: 회색 원, 옅은 글씨
//  error: 빨강 원 + 느낌표 (코드에서 더한 상태 — 고객 카메라가 막혔을 때)

export type StepState = "done" | "current" | "todo" | "error";

export function StepItem({ state, children, detail }: { state: StepState; children: ReactNode; detail?: ReactNode }) {
  return (
    <li className="flex gap-3" data-state={state}>
      <span
        aria-hidden="true"
        className={`grid size-7 flex-none place-items-center rounded-full ${
          state === "done"
            ? "bg-success text-on-primary"
            : state === "current"
              ? "bg-warning-tint ring-2 ring-warning ring-inset"
              : state === "error"
                ? "bg-danger text-on-primary"
                : "bg-bg-muted ring-1 ring-border ring-inset"
        }`}
      >
        {state === "done" && <CheckIcon className="size-4" strokeWidth={2.6} />}
        {state === "current" && <span className="size-2.5 rounded-full bg-warning" />}
        {state === "error" && <AlertIcon className="size-4" />}
      </span>
      <span className="flex min-w-0 flex-col pt-0.5">
        <span
          className={
            state === "current" || state === "error"
              ? "text-label-l text-text-primary"
              : state === "done"
                ? "text-body-m text-text-primary"
                : "text-body-m text-text-tertiary"
          }
        >
          {children}
        </span>
        {detail && <span className="text-body-s text-text-secondary">{detail}</span>}
      </span>
    </li>
  );
}
