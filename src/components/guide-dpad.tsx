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
  isGuideDir,
  type GuideCmd,
  type GuideDir,
  type GuideMsg,
} from "@/lib/webrtc/guide";
import s from "./guide.module.css";

// 엔지니어 십자키 (요구사항 CALL-15).
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

/** 디자인 기준 크기(px). guide.module.css와 맞춘다 */
const SIZE = 196;
/** 가운데 원(가까이/멀리) 반지름 */
const HUB_R = 40;
/** 가운데 원에서 위/아래 판정 여유 */
const HUB_DEAD = 6;
/** 방향을 바꿀 때 경계 여유(도). 대각선 근처에서 깜빡이지 않게 */
const HYST = 10;

const DIR_ANG: Record<GuideDir, number> = { right: 0, down: 90, left: 180, up: -90 };

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

  // 채널이 닫혀 send가 던져도 십자키 상태는 꼬이지 않게 한다. 고객 쪽은 1.5초 뒤 스스로 지운다
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

// 방향키를 스스로 쓰지 않는 입력 요소. 여기에 포커스가 있어도 십자키 키보드는 동작한다
const NON_TEXT_INPUTS = new Set(["checkbox", "button", "submit", "reset", "image", "file", "color"]);

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}

function sectorOf(deg: number): GuideDir {
  const a = ((deg % 360) + 360) % 360;
  if (a >= 315 || a < 45) return "right";
  if (a < 135) return "down";
  if (a < 225) return "left";
  return "up";
}

function angDiff(a: number, b: number) {
  const x = Math.abs((((a - b) % 360) + 360) % 360);
  return x > 180 ? 360 - x : x;
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 12h14M12.5 5.5 19 12l-6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 십자키. 누르고 있는 동안만 고객 화면에 지시가 뜬다.
 * - 팔(상하좌우)에서 시작: 엄지 위치의 방향. 누른 채 굴려서 방향을 바꿀 수 있고, 가운데로 오면 꺼진다.
 * - 가운데 원에서 시작: 위쪽 반(+) 가까이, 아래쪽 반(−) 멀리. 누른 채 위아래로 밀어 바꿀 수 있다.
 * - PC: 방향키, = 가까이, - 멀리를 누르고 있는 동안.
 */
export function GuideDpad({
  onSend,
  keyboard = true,
  disabled = false,
  className,
}: {
  /**
   * 메시지를 상대에게 보낸다. 채널이 열려 있을 때만 보내는 함수를 넘길 것(방향 지시 전용 DataChannel).
   * 던진 예외는 무시한다. 프리즈 등으로 지시를 끄려면 disabled를 넘긴다(고객 쪽 reset만으로는 다시 뜬다).
   */
  onSend: (msg: GuideMsg) => void;
  keyboard?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { active, currentRef, hold, release } = useGuideSender(onSend);
  const pointerIdRef = useRef<number | null>(null);
  const keyCmdRef = useRef<GuideCmd | null>(null);
  const zoomMode = useRef(false);
  const usedCmd = useRef(false);
  const [hint, setHint] = useState(false);

  // 창이 가려지거나 포커스를 잃으면 keyup/pointerup이 안 올 수 있으니 바로 뗀 것으로 처리
  useEffect(() => {
    const stop = () => {
      pointerIdRef.current = null;
      keyCmdRef.current = null;
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
    zoomMode.current = false;
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

  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(false), 1800);
    return () => clearTimeout(id);
  }, [hint]);

  const local = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = SIZE / r.width;
    return { x: (e.clientX - r.left - r.width / 2) * k, y: (e.clientY - r.top - r.height / 2) * k };
  };

  const cmdAt = (p: { x: number; y: number }): GuideCmd | null => {
    if (zoomMode.current) {
      if (p.y < -HUB_DEAD) return "closer";
      if (p.y > HUB_DEAD) return "farther";
      return null;
    }
    if (Math.hypot(p.x, p.y) < HUB_R) return null;
    const deg = (Math.atan2(p.y, p.x) * 180) / Math.PI;
    const cur = currentRef.current;
    if (cur && isGuideDir(cur) && angDiff(deg, DIR_ANG[cur]) <= 45 + HYST) return cur;
    return sectorOf(deg);
  };

  const apply = (cmd: GuideCmd | null) => {
    if (cmd === currentRef.current) return;
    if (cmd) {
      usedCmd.current = true;
      hold(cmd);
    } else release();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || pointerIdRef.current !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 이미 떼어진 포인터면 캡처 없이 진행
    }
    pointerIdRef.current = e.pointerId;
    keyCmdRef.current = null;
    const p = local(e);
    zoomMode.current = Math.hypot(p.x, p.y) < HUB_R;
    usedCmd.current = false;
    setHint(false);
    apply(cmdAt(p));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.pointerId !== pointerIdRef.current) return;
    apply(cmdAt(local(e)));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pointerIdRef.current) return;
    pointerIdRef.current = null;
    // 가운데 한가운데를 톡 누르기만 했으면 쓰는 법을 잠깐 보여준다
    if (zoomMode.current && !usedCmd.current) setHint(true);
    zoomMode.current = false;
    release();
  };

  return (
    <div
      className={className ? `${s.dpad} ${className}` : s.dpad}
      role="group"
      aria-label="방향 지시 십자키: 누르고 있는 동안 고객 화면에 표시"
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onContextMenu={(e) => e.preventDefault()}
    >
      {GUIDE_DIRS.map((dir) => (
        <div key={dir} className={s.arm} data-dir={dir} data-active={active === dir || undefined}>
          <ArrowIcon />
        </div>
      ))}
      <div className={s.hub}>
        <div className={s.half} data-cmd="closer" data-active={active === "closer" || undefined}>
          <b>+</b>가까이
        </div>
        <div className={s.half} data-cmd="farther" data-active={active === "farther" || undefined}>
          <b>−</b>멀리
        </div>
      </div>
      {hint && <div className={s.hint}>가운데 위(+) 가까이 · 아래(−) 멀리</div>}
    </div>
  );
}
