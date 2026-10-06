import { createHmac, timingSafeEqual } from "node:crypto";

// 카카오톡 공유 웹훅 (ROOM-15). 카카오가 전송에 성공한 채팅방마다 한 번씩 우리 서버로 알린다.
// 헤더 `Authorization: KakaoAK {대표 어드민 키}`, 본문은 CHAT_TYPE·HASH_CHAT_ID와
// 보낼 때 실은 serverCallbackArgs(`room`, `sig`). 받는 사람 이름·번호는 오지 않는다.
// https://developers.kakao.com/docs/ko/kakaotalk-share/callback

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LEN = 200;

export type ShareWebhook = {
  roomId: string;
  /** MemoChat(나와의 채팅)·DirectChat(1:1)·MultiChat(그룹)·OpenDirectChat·OpenMultiChat */
  chatType: string;
  /** 앱별 채팅방 참고용 해시. 보내는 사람·받는 사람 한 쌍마다 하나 (ROOM-15 실기기 확인) */
  hashChatId: string;
};

/** 보낼 때 같이 싣는 값 (serverCallbackArgs). 카카오가 웹훅에 그대로 돌려준다 */
export type KakaoShareArgs = { room: string; sig: string };

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 카카오가 보낸 요청인지: 대표 어드민 키를 비교한다. 키가 설정되지 않았으면 모두 거절 */
export function isFromKakao(authorization: string | null, adminKey: string | undefined): boolean {
  if (!adminKey || !authorization) return false;
  return same(authorization, `KakaoAK ${adminKey}`);
}

// 상담 id 서명. room 값은 보내는 쪽 브라우저가 정하므로, 고객 링크로 상담 id를 아는 사람이
// 자기 카톡으로 남의 상담에 엉뚱한 방을 붙이지 못하게 서버가 서명한 값만 믿는다 (ROOM-16)
function sign(roomId: string, adminKey: string) {
  return createHmac("sha256", adminKey).update(`kakao-share:${roomId}`).digest("base64url").slice(0, 22);
}

/** 상담 화면을 그릴 때 서버에서 만든다. 키가 없으면 null — 웹훅도 받지 않으므로 싣지 않는다 */
export function kakaoShareArgs(roomId: string, adminKey: string | undefined): KakaoShareArgs | null {
  return adminKey ? { room: roomId, sig: sign(roomId, adminKey) } : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_LEN ? v : null;
}

/** 본문(POST)이나 쿼리(GET)에서 기록할 값만 꺼낸다. 형식이 틀리거나 서명이 맞지 않으면 null */
export function parseShareWebhook(params: Record<string, unknown>, adminKey: string): ShareWebhook | null {
  const room = text(params.room)?.toLowerCase();
  const sig = text(params.sig);
  const chatType = text(params.CHAT_TYPE);
  const hashChatId = text(params.HASH_CHAT_ID);
  if (!room || !UUID.test(room) || !sig || !chatType || !hashChatId) return null;
  if (!same(sig, sign(room, adminKey))) return null;
  return { roomId: room, chatType, hashChatId };
}
