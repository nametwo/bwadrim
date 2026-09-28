// 방향 지시 (요구사항 CALL-15).
// 엔지니어가 방향 링·가까이/멀리 알약을 누르고 있는 동안만 고객 화면에 지시가 뜬다.
// 손을 떼면 사라지고, 그게 곧 "멈추세요" 신호다.
// 연결 후 DataChannel(순서 보장)로 보낸다.

export type GuideDir = "left" | "right" | "up" | "down";
export type GuideCmd = GuideDir | "closer" | "farther";

export const GUIDE_DIRS: readonly GuideDir[] = ["up", "right", "down", "left"];
export const GUIDE_CMDS: readonly GuideCmd[] = [...GUIDE_DIRS, "closer", "farther"];

export function isGuideDir(cmd: GuideCmd): cmd is GuideDir {
  return (GUIDE_DIRS as readonly string[]).includes(cmd);
}

export type GuideMsg =
  // 누르는 중. 누르는 동안 GUIDE_KEEPALIVE_MS마다 다시 보내 고객 쪽 lease를 연장한다.
  | { t: "guide"; kind: "hold"; cmd: GuideCmd; epoch: string; seq: number }
  // 손 뗌.
  | { t: "guide"; kind: "release"; epoch: string; seq: number };

/** 누르는 동안 hold 재전송 간격 */
export const GUIDE_KEEPALIVE_MS = 400;
/** hold가 이 시간 동안 안 오면 고객 쪽에서 지운다 (release 유실·연결 끊김 대비) */
export const GUIDE_LEASE_MS = 1500;
/** 톡 짧게 눌러도 고객 화면엔 최소 이만큼 보인다 */
export const GUIDE_MIN_SHOW_MS = 1000;
/** 손 뗀 뒤 "그대로요"를 보여주는 시간 (옵션) */
export const GUIDE_STILL_MS = 1200;

export function isGuideMsg(v: unknown): v is GuideMsg {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m.t !== "guide" || typeof m.epoch !== "string" || typeof m.seq !== "number") return false;
  if (m.kind === "release") return true;
  return m.kind === "hold" && GUIDE_CMDS.includes(m.cmd as GuideCmd);
}
