import type { EventName } from "./events";

// 지표 이벤트 → 디스코드 글 (OPS-09). 순수 함수 — 서버·DB를 모른다.
// 일반 채널: 상담이 흘러가는 단계마다 한 줄(만듦·링크 엶·카메라 켬·카메라 못 켬·연결·연결 실패·끝남·카톡 전송).
// 도구 사용은 끝날 때 한 줄에 모으고, relay_used·turn_issued는 보내지 않는다(hasMessage).
// 응급 채널: 핵심 지표(README '지표')가 깨지는 신호 — 연결 실패, 카메라는 켰는데 연결 없이 끝남.
// TURN 발급 실패·상한, DB 기록 실패, 로그인 서버 장애는 이벤트가 아니라 그 자리(api/turn, actions)에서 바로 보낸다

export interface NotifyRoom {
  id: string;
  /** 엔지니어 표시 이름(OPS-03). 없으면 null */
  engineer: string | null;
  /** 받는 분 이름표(ROOM-16). 없으면 null */
  recipient: string | null;
}

export interface NotifyContext extends NotifyRoom {
  /** ended 때: 이 상담에서 고객이 카메라를 켠 적 있는지 */
  hadCamera?: boolean;
  /** ended 때: 통화 중 쓴 도구 이벤트 이름들 */
  tools?: string[];
}

export interface Urgent {
  /** 같은 일을 10분 안에 두 번 보내지 않게 하는 열쇠 */
  key: string;
  text: string;
}

export interface EventMessages {
  general?: string;
  urgent?: Urgent;
}

const TOOL_KO: Record<string, string> = {
  pointer_used: "가리키기",
  freeze_used: "화면 멈춤",
  anchor_used: "AR 핀",
  guide_used: "방향 지시",
  photo_taken: "사진",
};

// 고객 폰 브라우저 오류 이름 → 말. camera-help.tsx가 화면에서 가르는 것과 같은 묶음
const DENIED_KO: Record<string, string> = {
  NotAllowedError: "권한을 거부했거나 막혀 있음",
  NotReadableError: "다른 앱이 카메라를 쓰는 중",
  AbortError: "다른 앱이 카메라를 쓰는 중",
  TrackStartError: "다른 앱이 카메라를 쓰는 중",
  NotFoundError: "카메라 없음",
  DevicesNotFoundError: "카메라 없음",
  OverconstrainedError: "맞는 카메라 없음",
  unsupported: "카메라 기능이 없는 화면",
  unknown: "원인 모름",
};

// 앱 안 브라우저 종류(src/lib/in-app-browser.ts InAppKind) → 말
const INAPP_KO: Record<string, string> = {
  kakaotalk: "카카오톡 앱 안",
  line: "라인 앱 안",
  naver: "네이버 앱 안",
  instagram: "인스타그램 앱 안",
  facebook: "페이스북 앱 안",
  band: "밴드 앱 안",
  daum: "다음 앱 안",
  webview: "이름 모르는 앱의 웹뷰 안",
};

// 따로 보내지 않는 이벤트 — 끝날 때 한 줄에 모이거나(도구), 지표용일 뿐이다. 상담 정보를 찾는 수고도 하지 않는다
const SILENT = new Set(["pointer_used", "freeze_used", "anchor_used", "guide_used", "photo_taken", "relay_used", "turn_issued"]);

/** 이 이벤트가 디스코드 글이 되는지 */
export function hasMessage(name: string): boolean {
  return !SILENT.has(name);
}

const CHAT_KO: Record<string, string> = {
  DirectChat: "1:1",
  MultiChat: "그룹",
  MemoChat: "나와의 채팅",
  OpenDirectChat: "오픈채팅 1:1",
  OpenMultiChat: "오픈채팅 그룹",
};

/** 상담 id 앞 8자리 — 대시보드·Supabase에서 찾기 좋게 */
export function shortId(roomId: string): string {
  return roomId.slice(0, 8);
}

/** '상담 a1b2c3d4 · 김도현 → 역삼점' 꼴. 이름이 없으면 있는 것만 */
export function roomTag(room: NotifyRoom): string {
  const who = [room.engineer, room.recipient].filter((x): x is string => !!x).join(" → ");
  return `상담 ${shortId(room.id)}${who ? ` · ${who}` : ""}`;
}

/** 브라우저 정보(User-Agent)를 한 단어로: 아이폰 사파리, 안드로이드 크롬, PC … */
export function describeDevice(ua: unknown): string {
  const s = typeof ua === "string" ? ua : "";
  if (!s) return "기기 모름";
  if (/iPad/i.test(s)) return "아이패드";
  if (/iPhone/i.test(s)) return /CriOS/i.test(s) ? "아이폰 크롬" : "아이폰 사파리";
  if (/Android/i.test(s)) return /SamsungBrowser/i.test(s) ? "안드로이드 삼성 인터넷" : "안드로이드 크롬";
  if (/Windows|Macintosh|Linux/i.test(s)) return "PC";
  return "기기 모름";
}

function minutes(sec: unknown): string {
  const n = typeof sec === "number" && Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const m = Math.round(n / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
}

/**
 * 이벤트 하나를 디스코드 글로. 보낼 것이 없으면 빈 객체.
 * 도구 사용(pointer_used 등)·relay_used·turn_issued는 따로 보내지 않는다 — 연결·끝남 글에 들어간다
 */
export function describeEvent(name: EventName | string, props: Record<string, unknown> | null | undefined, ctx: NotifyContext): EventMessages {
  const p = props ?? {};
  const tag = roomTag(ctx);
  switch (name) {
    case "room_created":
      return { general: `🆕 ${tag} | 새 상담을 만들었어요` };
    case "link_opened": {
      const inapp = typeof p.inapp === "string" ? ` · ${INAPP_KO[p.inapp] ?? `${p.inapp} 앱 안`}` : "";
      return { general: `🔗 ${tag} | 고객이 링크를 열었어요 (${describeDevice(p.ua)}${inapp})` };
    }
    case "camera_granted":
      return { general: `📷 ${tag} | 고객이 카메라를 켰어요${p.mic === false ? " (마이크 없이)" : ""}` };
    case "camera_denied": {
      const reason = typeof p.reason === "string" ? (DENIED_KO[p.reason] ?? p.reason) : "원인 모름";
      return { general: `🚫 ${tag} | 고객이 카메라를 못 켰어요 (${reason})` };
    }
    case "connected":
      return {
        general: `✅ ${tag} | 연결됐어요 (${p.relay === true ? "중계 서버 경유" : "직접 연결"}${p.turn === false ? ", TURN 없이" : ""})`,
      };
    case "connect_failed": {
      const mid = p.stage === "call";
      return {
        general: `❌ ${tag} | 연결에 실패했어요 (${mid ? "통화 중에 끊김" : "연결하던 중"})`,
        urgent: {
          key: `connect_failed:${ctx.id}:${mid ? "call" : "connecting"}`,
          text: `🚨 연결 실패 — ${tag}: ${mid ? "통화 중에 끊겼어요" : "연결하던 중에 실패했어요"}. 고객 화면엔 '다시 연결'이 떠 있어요. 되풀이되면 TURN 발급과 망 상태를 봐 주세요`,
        },
      };
    }
    case "kakao_sent": {
      const chat = typeof p.chat_type === "string" ? (CHAT_KO[p.chat_type] ?? p.chat_type) : "채팅방";
      return { general: `💬 ${tag} | 카톡 카드가 채팅방에 갔어요 (${chat})` };
    }
    case "ended": {
      const connected = p.connected === true;
      const tools = (ctx.tools ?? []).map((t) => TOOL_KO[t] ?? t);
      const how = connected ? `${minutes(p.duration_sec)} 걸림` : "연결 없이";
      const general = `⏹ ${tag} | 상담을 끝냈어요 · ${how}${tools.length ? ` · 쓴 도구: ${tools.join(", ")}` : ""}`;
      if (!connected && ctx.hadCamera) {
        return {
          general,
          urgent: {
            key: `ended-no-connect:${ctx.id}`,
            text: `🚨 연결 없이 끝남 — ${tag}: 카메라는 켜졌는데 연결이 안 된 채 상담이 닫혔어요. 연결 실패율에 들어가요 (기사님이 '고객 화면 열어 보기'로 켜 본 것일 수도)`,
          },
        };
      }
      return { general };
    }
    default:
      return {};
  }
}
