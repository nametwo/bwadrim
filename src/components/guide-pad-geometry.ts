import type { GuideCmd, GuideDir } from "@/lib/webrtc/guide";

// 방향 링 + 가까이·멀리 알약의 모양과 누른 자리 판정 (요구사항 CALL-15, 피그마 Components → Dpad).
// 화면 그리기(guide-dpad.tsx)와 따로 두어 단위 테스트로 판정 규칙을 고정한다.

/** 링 지름(px). 알약 너비도 같다 — 한 덩어리로 보이게 */
export const RING_D = 160;
export const RING_R = RING_D / 2;
/** 가운데 구멍 반지름 — 엄지를 쉬는 '멈춤' 자리 */
export const HOLE_R = 27;
/** 조각 사이 틈(일정한 두께) */
export const GAP = 4;
/** 조각 모서리 둥글기. 채움과 같은 색 선(두께 2배)으로 둥글린다 */
export const CORNER = 3;
/** 방향 표시(꺾쇠) 중심이 놓이는 반지름 */
export const GLYPH_R = 54;
/** 꺾쇠 상자 크기(px, 24 기준 아이콘을 늘린다) */
export const GLYPH_BOX = 28;

/** 알약(가까이·멀리) 높이, 링과의 틈 */
export const PILL_H = 48;
export const PILL_GAP = 8;

// 판정 (디자인 px 기준)
/** 이만큼 바깥으로 나가야 방향이 켜진다 */
export const ARM_R = 30;
/** 켜진 뒤에는 이만큼 안쪽까지 들어와야 꺼진다 (구멍 가장자리에서 깜빡이지 않게) */
export const DISARM_R = 24;
/** 누르기 시작한 자리가 링 바깥 이 거리보다 멀면(네모 상자의 빈 모서리) 무시 */
export const PRESS_SLOP = 10;
/** 방향을 바꿀 때 대각선 근처 여유(도) */
export const ANGLE_HYST = 10;
/** 알약 가운데 경계에서 멀리↔가까이가 깜빡이지 않게 두는 여유(px) */
export const ZOOM_HYST = 6;
/** 알약 가운데 경계를 처음 누르면 이 폭 안에서는 아무것도 보내지 않는다 (아래 조각을 누르다 미끄러진 손가락) */
export const ZOOM_DEAD = 10;

export const DIR_ANGLE: Record<GuideDir, number> = { right: 0, down: 90, left: 180, up: -90 };

type Pt = { x: number; y: number };

const dir = (deg: number): Pt => {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
};
const f = (n: number) => Number(n.toFixed(2));

/**
 * 링 한 조각(φ 방향 중심, 90°)의 SVG 경로. 틈은 대각선과 나란한 일정한 두께다.
 * 모서리 둥글기만큼 안쪽으로 줄여 그리고, 같은 색 선(두께 2×CORNER, 둥근 이음)으로 다시 키운다.
 */
export function wedgePath(phi: number) {
  const ro = RING_R - CORNER;
  const ri = HOLE_R + CORNER;
  const h = GAP / 2 + CORNER;
  const d1 = dir(phi - 45);
  const n1 = dir(phi + 45);
  const d2 = dir(phi + 45);
  const n2 = dir(phi - 45);
  const at = (rho: number, d: Pt, n: Pt) => {
    const a = Math.sqrt(rho * rho - h * h);
    return `${f(a * d.x + h * n.x)} ${f(a * d.y + h * n.y)}`;
  };
  const i1 = at(ri, d1, n1);
  const o1 = at(ro, d1, n1);
  const o2 = at(ro, d2, n2);
  const i2 = at(ri, d2, n2);
  return `M${i1} L${o1} A${ro} ${ro} 0 0 1 ${o2} L${i2} A${ri} ${ri} 0 0 0 ${i1} Z`;
}

/** 오른쪽을 가리키는 꺾쇠(24 기준)를 φ 방향 조각 가운데로 옮기는 transform */
export function glyphTransform(phi: number) {
  const c = dir(phi);
  const k = GLYPH_BOX / 24;
  return `translate(${f(c.x * GLYPH_R)} ${f(c.y * GLYPH_R)}) rotate(${phi}) scale(${f(k)}) translate(-12 -12)`;
}

export function sectorOf(deg: number): GuideDir {
  const a = ((deg % 360) + 360) % 360;
  if (a >= 315 || a < 45) return "right";
  if (a < 135) return "down";
  if (a < 225) return "left";
  return "up";
}

export function angDiff(a: number, b: number) {
  const x = Math.abs((((a - b) % 360) + 360) % 360);
  return x > 180 ? 360 - x : x;
}

/** 링을 누르기 시작한 자리가 링 위인지 (네모 상자의 빈 모서리는 무시). p = 링 중심 기준 디자인 px */
export function ringAccepts(p: Pt) {
  return Math.hypot(p.x, p.y) <= RING_R + PRESS_SLOP;
}

/**
 * 링을 누르는 중인 손가락 위치 → 방향. 가운데 구멍이면 null(= 멈춤).
 * 누른 채로는 링 밖으로 나가도 각도로 판정한다(엄지가 넘쳐도 끊기지 않게). 링에서 시작한 누름은 가까이·멀리가 되지 않는다.
 */
export function ringCmdAt(p: Pt, current: GuideCmd | null): GuideDir | null {
  const held = current === "up" || current === "down" || current === "left" || current === "right" ? current : null;
  const d = Math.hypot(p.x, p.y);
  if (d < (held ? DISARM_R : ARM_R)) return null;
  const deg = (Math.atan2(p.y, p.x) * 180) / Math.PI;
  if (held && angDiff(deg, DIR_ANGLE[held]) <= 45 + ANGLE_HYST) return held;
  return sectorOf(deg);
}

/**
 * 알약을 누르는 중인 손가락의 가로 위치(x, 알약 왼쪽 기준 디자인 px, 너비 RING_D) → 멀리(왼쪽)/가까이(오른쪽).
 * armed=false면 아직 가운데 경계 근처에서 누르기 시작해 떠나지 않은 상태 — 경계 ±ZOOM_DEAD 안이면 null.
 * 한 번 켜진 뒤에는 ±ZOOM_HYST 여유로 지금 쪽을 유지한다. 세로 위치는 보지 않는다(알약에서 시작한 누름은 방향이 되지 않는다).
 */
export function zoomCmdAt(x: number, current: GuideCmd | null, armed: boolean): "closer" | "farther" | null {
  const mid = RING_D / 2;
  if (!armed && Math.abs(x - mid) < ZOOM_DEAD) return null;
  if (current === "farther" && x < mid + ZOOM_HYST) return "farther";
  if (current === "closer" && x > mid - ZOOM_HYST) return "closer";
  return x < mid ? "farther" : "closer";
}
