"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { DataLink } from "@/lib/webrtc/data-link";
import {
  EMPTY_ENGINEER_SNAPSHOT,
  EngineerAnchorSession,
  type EngineerSnapshot,
} from "@/lib/tracking/session";
import { AnchorOverlay } from "@/components/anchor-overlay";
import { SessionHolder } from "./session-holder";
import { engineerChip, needsRetap, referenceToast, type ChipTone } from "./usage";

// 엔지니어 통화 화면의 AR 핀 층 (CALL-14). 영상 컨테이너 안에 영상과 같은 크기로 겹쳐 놓는다.
// 제스처 판정(짧게 탭 = 레이저 포인터 CALL-08, 길게 누름 = 핀)은 통화 패널이 하고, 핀은 apiRef.pinAt으로 꽂는다.
// 보이는 것: 물체에 붙은 핀(오버레이), 고객 화면 상태칩, 기준 설정 안내, '지우기'.

export interface EngineerAnchorApi {
  /** 화면 좌표에 핀. 영상 밖이거나 아직 영상 프레임이 없으면 false */
  pinAt(clientX: number, clientY: number): boolean;
  clear(): void;
}

const TONE_CLASS: Record<ChipTone, string> = {
  ok: "bg-success",
  wait: "bg-call-text-secondary",
  bad: "bg-danger",
  guide: "bg-danger",
};

function select(s: EngineerSnapshot) {
  return {
    anchor: s.anchor,
    customerState: s.customerState,
    customerArrow: s.customerArrow,
    customerReason: s.customerReason,
    trackable: s.trackable,
    referenceReason: s.referenceReason,
    frozen: s.frozen,
    update: s.update,
  };
}

export function EngineerAnchorLayer({
  video,
  link,
  apiRef,
  hidden,
}: {
  video: RefObject<HTMLVideoElement | null>;
  link: DataLink;
  apiRef: RefObject<EngineerAnchorApi | null>;
  /** CALL-09 정지 화면 중: 핀 층을 숨긴다 (추적은 계속) */
  hidden: boolean;
}) {
  const [holder] = useState(
    () => new SessionHolder<EngineerAnchorSession, EngineerSnapshot>(EMPTY_ENGINEER_SNAPSHOT),
  );
  const [view] = useState(() => holder.selector(select));
  const [getUpdate] = useState(() => () => holder.current()?.latestUpdate() ?? null);
  const snap = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot);
  const [toastFor, setToastFor] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const s = new EngineerAnchorSession({ video: v, link, fit: "contain" });
    holder.set(s);
    apiRef.current = {
      pinAt: (x, y) => s.pinAt(x, y, "contain"),
      clear: () => s.clear(),
    };
    return () => {
      apiRef.current = null;
      holder.set(null);
      s.destroy();
    };
  }, [holder, link, video, apiRef]);

  // 기준 설정 안내(무늬 부족·반복 무늬)는 핀마다 한 번, 4초
  const toast = referenceToast(snap);
  const anchorId = snap.anchor?.id ?? null;
  useEffect(() => {
    clearTimeout(toastTimer.current);
    if (!toast || !anchorId) return;
    toastTimer.current = setTimeout(() => setToastFor(anchorId), 4000);
    return () => clearTimeout(toastTimer.current);
  }, [toast, anchorId]);

  if (hidden) return null;

  const chip = engineerChip(snap);
  const showToast = toast && anchorId && toastFor !== anchorId;
  const retap = needsRetap(snap);

  return (
    <>
      <AnchorOverlay
        video={video}
        fit="contain"
        anchor={snap.anchor}
        update={null}
        getUpdate={getUpdate}
        className="anchor-overlay"
      />
      {(chip || showToast || retap) && (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-col items-start gap-1.5">
          {chip && (
            <span className="flex items-center gap-2 rounded-full bg-black-80 px-3 py-1.5 text-sm font-medium text-call-text">
              <span className={`h-2.5 w-2.5 rounded-full ${TONE_CLASS[chip.tone]}`} aria-hidden="true" />
              {chip.text}
            </span>
          )}
          {showToast && (
            <span className="rounded-xl bg-black-80 px-3 py-2 text-sm text-call-text">{toast}</span>
          )}
          {retap && (
            <span className="rounded-xl bg-black-80 px-3 py-2 text-sm text-call-text">
              표시를 놓쳤어요. 다시 길게 눌러 주세요
            </span>
          )}
        </div>
      )}
      {snap.anchor && (
        <button
          type="button"
          // 영상 위 제스처(탭·길게 누르기)로 번지지 않게
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => apiRef.current?.clear()}
          className="absolute top-2 right-2 h-11 rounded-full bg-black-80 px-4 text-sm font-semibold text-call-text active:bg-call-control-pressed"
        >
          핀 지우기
        </button>
      )}
    </>
  );
}
