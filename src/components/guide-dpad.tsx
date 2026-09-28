"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  GUIDE_DIRS,
  GUIDE_KEEPALIVE_MS,
  type GuideCmd,
  type GuideMsg,
} from "@/lib/webrtc/guide";
import {
  DIR_ANGLE,
  RING_D,
  RING_R,
  glyphTransform,
  ringAccepts,
  ringCmdAt,
  wedgePath,
  zoomCmdAt,
} from "./guide-pad-geometry";
import s from "./guide.module.css";

// 엔지니어 방향 지시 (요구사항 CALL-15, 피그마 Components → Dpad).
// 둥근 방향 링(상하좌우 네 조각, 가운데 구멍 = 멈춤) + 아래 '− 멀리 | 가까이 +' 알약.
// 누르고 있는 동안만 고객 화면에 지시가 뜨고, 떼면 사라진다(= 멈춤).

const KEY_CMD: Record<string, GuideCmd> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Equal: "closer",
  NumpadAdd: "closer",
  Minus: "farther",
  NumpadSubtract: "farther",
};

const WEDGE = Object.fromEntries(GUIDE_DIRS.map((d) => [d, wedgePath(DIR_ANGLE[d])])) as Record<string, string>;
const GLYPH = Object.fromEntries(GUIDE_DIRS.map((d) => [d, glyphTransform(DIR_ANGLE[d])])) as Record<string, string>;

/** 아무것도 보내지 않고 뗐을 때 잠깐 보여 주는 쓰는 법 */
export const PAD_HINT = {
  ring: "방향을 누르고 있는 동안만 고객 화면에 보여요",
  zoom: "멀리·가까이 중 한쪽을 누르고 있어 주세요",
} as const;
const HINT_MS = 1800;

/** 누르는 동안 hold를 주기적으로 보내고, 떼면 release를 한 번 보낸다. */
function useGuideSender(send: (msg: GuideMsg) => void) {
  const [active, setActive] = useState<GuideCmd | null>(null);
  const sendRef = useRef(send);
  const currentRef = useRef<GuideCmd | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seq = useRef(0);
  const epoch = useRef("");

  useEffect(() => {
    sendRef.current = send;
  });

  // 채널이 닫혀 send가 던져도 방향 링 상태는 꼬이지 않게 한다. 고객 쪽은 1.5초 뒤 스스로 지운다
  const post = useCallback((m: GuideMsg) => {
    try {
      sendRef.current(m);
    } catch {
      // 전송 실패는 버린다
    }
  }, []);

  const hold = useCallback((cmd: GuideCmd) => {
    // 새로고침·재마운트 후에도 고객 쪽이 seq를 리셋할 수 있게 인스턴스마다 epoch를 바꾼다
    if (!epoch.current) epoch.current = Math.random().toString(36).slice(2, 10);
    if (timer.current !== null) clearInterval(timer.current);
    currentRef.current = cmd;
    setActive(cmd);
    const tick = () => post({ t: "guide", kind: "hold", cmd, epoch: epoch.current, seq: ++seq.current });
    timer.current = setInterval(tick, GUIDE_KEEPALIVE_MS);
    tick();
  }, [post]);

  const release = useCallback(() => {
    if (timer.current === null) return;
    clearInterval(timer.current);
    timer.current = null;
    currentRef.current = null;
    setActive(null);
    post({ t: "guide", kind: "release", epoch: epoch.current, seq: ++seq.current });
  }, [post]);

  useEffect(() => release, [release]);

  return { active, currentRef, hold, release };
}

// 방향키를 스스로 쓰지 않는 입력 요소. 여기에 포커스가 있어도 방향 지시 키보드는 동작한다
const NON_TEXT_INPUTS = new Set(["checkbox", "button", "submit", "reset", "image", "file", "color"]);

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}

function MinusGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12H19" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5V19M5 12H19" />
    </svg>
  );
}

type Zone = "ring" | "zoom";

/**
 * 방향 링 + 가까이·멀리 알약. 누르고 있는 동안만 고객 화면에 지시가 뜬다.
 * - 링: 누른 조각의 방향. 누른 채 엄지를 굴려 떼지 않고 방향을 바꾼다. 가운데 구멍으로 오면 꺼진다.
 * - 알약: 왼쪽 반 멀리, 오른쪽 반 가까이. 누른 채 옆으로 밀어 바꾼다.
 * - 링에서 시작한 누름은 방향만, 알약에서 시작한 누름은 가까이·멀리만 보낸다(둘 사이 틈은 무시).
 * - PC: 방향키, = 가까이, - 멀리를 누르고 있는 동안.
 */
export function GuideDpad({
  onSend,
  onHint,
  keyboard = true,
  disabled = false,
  className,
}: {
  /**
   * 메시지를 상대에게 보낸다. 채널이 열려 있을 때만 보내는 함수를 넘길 것(방향 지시 전용 DataChannel).
   * 던진 예외는 무시한다. 프리즈 등으로 지시를 끄려면 disabled를 넘긴다(고객 쪽 reset만으로는 다시 뜬다).
   */
  onSend: (msg: GuideMsg) => void;
  /**
   * 아무것도 보내지 않고 뗐을 때(가운데 구멍·알약 경계를 톡) 쓰는 법 문구를 1.8초 넘긴다. 끝나면 null.
   * 통화 화면은 '고객 화면' 알약 자리에 보여 준다. 넘기지 않으면 링 위에 작은 말풍선으로 띄운다.
   */
  onHint?: (text: string | null) => void;
  keyboard?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { active, currentRef, hold, release } = useGuideSender(onSend);
  const pointerIdRef = useRef<number | null>(null);
  const keyCmdRef = useRef<GuideCmd | null>(null);
  const zoneRef = useRef<Zone | null>(null);
  const zoomArmed = useRef(false);
  const usedCmd = useRef(false);
  const touchRef = useRef(false);
  const ringRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  const onHintRef = useRef(onHint);

  useEffect(() => {
    onHintRef.current = onHint;
  });

  // 창이 가려지거나 포커스를 잃으면 keyup/pointerup이 안 올 수 있으니 바로 뗀 것으로 처리
  useEffect(() => {
    const stop = () => {
      pointerIdRef.current = null;
      keyCmdRef.current = null;
      zoneRef.current = null;
      release();
    };
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [release]);

  useEffect(() => {
    if (!disabled) return;
    pointerIdRef.current = null;
    keyCmdRef.current = null;
    zoneRef.current = null;
    release();
  }, [disabled, release]);

  useEffect(() => {
    if (!keyboard || disabled) return;
    const onDown = (e: KeyboardEvent) => {
      // macOS는 Cmd를 누른 채 뗀 키의 keyup을 보내지 않는다
      if ((e.key === "Meta" || e.key === "Control" || e.key === "Alt") && keyCmdRef.current !== null) {
        keyCmdRef.current = null;
        release();
        return;
      }
      const cmd = KEY_CMD[e.code];
      if (!cmd || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat || pointerIdRef.current !== null) return;
      keyCmdRef.current = cmd;
      hold(cmd);
    };
    const onUp = (e: KeyboardEvent) => {
      const cmd = KEY_CMD[e.code];
      if (!cmd || keyCmdRef.current !== cmd) return;
      keyCmdRef.current = null;
      release();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      if (keyCmdRef.current !== null) {
        keyCmdRef.current = null;
        release();
      }
    };
  }, [keyboard, disabled, hold, release]);

  // 쓰는 법 문구: 1.8초 뒤 지운다. 받는 쪽(onHint)이 있으면 그쪽에 보여 준다
  useEffect(() => {
    onHintRef.current?.(hint);
    if (!hint) return;
    const id = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(id);
  }, [hint]);
  useEffect(() => () => onHintRef.current?.(null), []);

  /** 링 중심 기준 좌표(디자인 px) */
  const ringLocal = (e: ReactPointerEvent) => {
    const r = ringRef.current!.getBoundingClientRect();
    const k = RING_D / r.width;
    return { x: (e.clientX - r.left - r.width / 2) * k, y: (e.clientY - r.top - r.height / 2) * k };
  };

  /** 알약 왼쪽 기준 가로 위치(디자인 px) */
  const zoomX = (e: ReactPointerEvent) => {
    const r = zoomRef.current!.getBoundingClientRect();
    return (e.clientX - r.left) * (RING_D / r.width);
  };

  const cmdAt = (e: ReactPointerEvent): GuideCmd | null => {
    if (zoneRef.current === "ring") return ringCmdAt(ringLocal(e), currentRef.current);
    if (zoneRef.current === "zoom") {
      const cmd = zoomCmdAt(zoomX(e), currentRef.current, zoomArmed.current);
      if (cmd) zoomArmed.current = true;
      return cmd;
    }
    return null;
  };

  const apply = (cmd: GuideCmd | null) => {
    // 이미 보내고 있는 지시(방향키를 누른 채 같은 조각을 누름 등)도 '보낸 누름'으로 친다 — 쓰는 법이 뜨지 않게
    if (cmd) usedCmd.current = true;
    if (cmd === currentRef.current) return;
    if (cmd) {
      // 안드로이드는 손가락으로 누른 지시(방향·가까이·멀리)가 켜지거나 바뀔 때 짧게 떨려 화면을 안 보고도 알 수 있다 (아이폰은 무시)
      if (touchRef.current) navigator.vibrate?.(8);
      hold(cmd);
    } else release();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || pointerIdRef.current !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    const zone = (e.target as Element).closest?.("[data-zone]")?.getAttribute("data-zone") as Zone | null | undefined;
    if (zone !== "ring" && zone !== "zoom") return;
    if (zone === "ring" && !ringAccepts(ringLocal(e))) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 이미 떼어진 포인터면 캡처 없이 진행
    }
    pointerIdRef.current = e.pointerId;
    keyCmdRef.current = null;
    zoneRef.current = zone;
    zoomArmed.current = false;
    usedCmd.current = false;
    touchRef.current = e.pointerType === "touch";
    setHint(null);
    apply(cmdAt(e));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.pointerId !== pointerIdRef.current) return;
    apply(cmdAt(e));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pointerIdRef.current) return;
    pointerIdRef.current = null;
    // 아무것도 보내지 않고 뗐으면(가운데 구멍·알약 경계를 톡) 쓰는 법을 잠깐 보여준다
    if (!usedCmd.current && zoneRef.current) setHint(PAD_HINT[zoneRef.current]);
    zoneRef.current = null;
    release();
  };

  return (
    <div
      className={className ? `${s.pad} ${className}` : s.pad}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={ringRef}
        className={s.ring}
        data-zone="ring"
        role="group"
        aria-label="방향 링: 누르고 있는 동안 고객 화면에 표시"
      >
        <svg viewBox={`${-RING_R} ${-RING_R} ${RING_D} ${RING_D}`} aria-hidden="true">
          {GUIDE_DIRS.map((dir) => (
            <g key={dir} className={s.wedge} data-dir={dir} data-active={active === dir || undefined}>
              <path className={s.seg} d={WEDGE[dir]} />
              <path className={s.chev} transform={GLYPH[dir]} d="M9.5 6 15.5 12 9.5 18" />
            </g>
          ))}
        </svg>
        {hint && !onHint && <div className={s.hint}>{hint}</div>}
      </div>
      <div
        ref={zoomRef}
        className={s.zoom}
        data-zone="zoom"
        role="group"
        aria-label="가까이·멀리: 누르고 있는 동안 고객 화면에 표시"
      >
        <div className={s.half} data-cmd="farther" data-active={active === "farther" || undefined}>
          <MinusGlyph />
          멀리
        </div>
        <div className={s.half} data-cmd="closer" data-active={active === "closer" || undefined}>
          가까이
          <PlusGlyph />
        </div>
      </div>
    </div>
  );
}
