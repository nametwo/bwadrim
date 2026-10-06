import { timingSafeEqual } from "node:crypto";

// 카카오톡 공유 웹훅 (ROOM-15). 카카오가 전송에 성공한 채팅방마다 한 번씩 우리 서버로 알린다.
// 헤더 `Authorization: KakaoAK {대표 어드민 키}`, 본문은 CHAT_TYPE·HASH_CHAT_ID와
// 보낼 때 실은 serverCallbackArgs(`room`). 받는 사람 이름·번호는 오지 않는다.
// https://developers.kakao.com/docs/ko/kakaotalk-share/callback

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LEN = 200;

export type ShareWebhook = {
  roomId: string;
  /** MemoChat(나와의 채팅)·DirectChat(1:1)·MultiChat(그룹)·OpenDirectChat·OpenMultiChat */
  chatType: string;
  /** 앱별 채팅방 참고용 해시. 같은 방인지 맞춰 보는 데만 쓴다 */
  hashChatId: string;
};

/** 카카오가 보낸 요청인지: 대표 어드민 키를 비교한다. 키가 설정되지 않았으면 모두 거절 */
export function isFromKakao(authorization: string | null, adminKey: string | undefined): boolean {
  if (!adminKey || !authorization) return false;
  const got = Buffer.from(authorization);
  const want = Buffer.from(`KakaoAK ${adminKey}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_LEN ? v : null;
}

/** 본문(POST)이나 쿼리(GET)에서 기록할 값만 꺼낸다. 형식이 틀리면 null */
export function parseShareWebhook(params: Record<string, unknown>): ShareWebhook | null {
  const room = text(params.room);
  const chatType = text(params.CHAT_TYPE);
  const hashChatId = text(params.HASH_CHAT_ID);
  if (!room || !UUID.test(room) || !chatType || !hashChatId) return null;
  return { roomId: room.toLowerCase(), chatType, hashChatId };
}
