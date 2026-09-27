"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GUIDE_LEASE_MS,
  GUIDE_MIN_SHOW_MS,
  GUIDE_STILL_MS,
  isGuideDir,
  type GuideCmd,
  type GuideMsg,
} from "@/lib/webrtc/guide";
import s from "./guide.module.css";

// 고객 화면 방향 지시 (요구사항 CALL-15). 엔지니어가 누르고 있는 동안만 보인다.

const GUIDE_TEXT: Record<GuideCmd, { main: string; sub: string }> = {
  left: { main: "왼쪽으로", sub: "휴대폰을 천천히 옮겨 주세요" },
  right: { main: "오른쪽으로", sub: "휴대폰을 천천히 옮겨 주세요" },
  up: { main: "위쪽으로", sub: "화살표 쪽으로 천천히 옮겨 주세요" },
  down: { main: "아래쪽으로", sub: "화살표 쪽으로 천천히 옮겨 주세요" },
  closer: { main: "가까이", sub: "휴대폰을 천천히 가까이 가져가 주세요" },
  farther: { main: "멀리", sub: "휴대폰을 천천히 뒤로 빼 주세요" },
};

const GUIDE_STILL_TEXT = { main: "그대로요", sub: "잠깐 멈춰 주세요" };

export type GuideView = { kind: "cmd"; cmd: GuideCmd; key: number } | { kind: "still"; key: number } | null;

type Options = {
  /** 손 뗀 뒤 "그대로요"를 잠깐 보여줄지 */
  stillHint?: boolean;
};

/** 고객 쪽. 받은 GuideMsg로 지금 보여줄 화면을 정한다. */
export function useGuideReceiver({ stillHint = false }: Options = {}) {
  const [view, setView] = useState<GuideView>(null);
  const st = useRef({ epoch: "", lastSeq: 0, cmd: null as GuideCmd | null, shownAt: 0, leaseUntil: 0, key: 0 });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stillRef = useRef(stillHint);

  useEffect(() => {
    stillRef.current = stillHint;
  });

  const clearHide = () => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const end = useCallback((showStill: boolean) => {
    const r = st.current;
    r.cmd = null;
    clearHide();
    if (!showStill) {
      setView(null);
      return;
    }
    setView({ kind: "still", key: ++r.key });
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setView(null);
    }, GUIDE_STILL_MS);
  }, []);

  // release가 유실되거나 연결이 끊기면 lease 만료로 지운다. 이때는 "그대로요"도 띄우지 않는다.
  useEffect(() => {
    const id = setInterval(() => {
      const r = st.current;
      if (r.cmd && performance.now() > r.leaseUntil) end(false);
    }, 200);
    return () => {
      clearInterval(id);
      clearHide();
    };
  }, [end]);

  const receive = useCallback(
    (msg: GuideMsg) => {
      const r = st.current;
      if (msg.epoch !== r.epoch) {
        r.epoch = msg.epoch;
        r.lastSeq = 0;
      }
      if (msg.seq <= r.lastSeq) return;
      r.lastSeq = msg.seq;
      const t = performance.now();

      if (msg.kind === "hold") {
        r.leaseUntil = t + GUIDE_LEASE_MS;
        // 떼고 '최소 1초' 대기 중에 다시 눌렀으면 새로 누른 것으로 보고 1초를 다시 보장한다
        const repress = hideTimer.current !== null;
        clearHide();
        if (r.cmd !== msg.cmd || repress) {
          r.cmd = msg.cmd;
          r.shownAt = t;
          setView({ kind: "cmd", cmd: msg.cmd, key: ++r.key });
        }
        return;
      }

      if (!r.cmd) return;
      // 톡 짧게 눌렀어도 최소 GUIDE_MIN_SHOW_MS는 보여준다
      const wait = Math.max(0, r.shownAt + GUIDE_MIN_SHOW_MS - t);
      clearHide();
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null;
        end(stillRef.current);
      }, wait);
    },
    [end],
  );

  /**
   * 고객 쪽 표시만 지운다(연결 종료, 카메라 전환 때).
   * 엔지니어가 계속 누르고 있으면 다음 hold로 다시 뜨므로, 프리즈 등에서 끄려면 엔지니어 GuideDpad에 disabled를 넘길 것.
   */
  const reset = useCallback(() => end(false), [end]);

  return { view, receive, reset };
}

/** 고객 화면 위에 겹치는 지시(화살표 또는 가까이/멀리 괄호) + 문구. 부모는 position: relative 여야 한다. */
export function GuideOverlay({ view }: { view: GuideView }) {
  const text = !view ? null : view.kind === "cmd" ? GUIDE_TEXT[view.cmd] : GUIDE_STILL_TEXT;
  return (
    <div className={s.overlay}>
      {/* 화면 낭독기용. 라이브 영역은 늘 DOM에 두고 글자만 바꿔야 새 지시가 읽힌다 */}
      <div className="sr-only" role="status" aria-live="polite">
        {text ? `${text.main}. ${text.sub}` : ""}
      </div>
      {view?.kind === "still" && <div className={s.frame} />}
      {view?.kind === "cmd" && isGuideDir(view.cmd) && (
        <div key={`a${view.key}`} className={s.arrow} data-dir={view.cmd}>
          <div className={s.rot}>
            <svg viewBox="-6 -6 132 112" aria-hidden="true">
              <polygon className={s.chev} points="0,6 24,6 56,50 24,94 0,94 32,50" />
              <polygon className={s.chev} points="32,6 56,6 88,50 56,94 32,94 64,50" />
              <polygon className={s.chev} points="64,6 88,6 120,50 88,94 64,94 96,50" />
            </svg>
          </div>
        </div>
      )}
      {view?.kind === "cmd" && !isGuideDir(view.cmd) && (
        <div key={`z${view.key}`} className={s.brackets} data-cmd={view.cmd} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
      )}
      {view && text && (
        <div
          key={`b${view.key}`}
          className={s.band}
          aria-hidden="true"
          data-testid="guide-band"
          data-cmd={view.kind === "cmd" ? view.cmd : "still"}
        >
          <div className={s.main}>{text.main}</div>
          <div className={s.sub}>{text.sub}</div>
        </div>
      )}
    </div>
  );
}
