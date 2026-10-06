import { describe, expect, it } from "vitest";
import { isFromKakao, parseShareWebhook } from "./kakao-webhook";

const ROOM = "3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b";

describe("isFromKakao", () => {
  it("대표 어드민 키가 맞으면 통과", () => {
    expect(isFromKakao("KakaoAK secret-key", "secret-key")).toBe(true);
  });

  it("키가 다르거나 형식이 다르면 거절", () => {
    expect(isFromKakao("KakaoAK wrong-key!", "secret-key")).toBe(false);
    expect(isFromKakao("Bearer secret-key", "secret-key")).toBe(false);
    expect(isFromKakao("secret-key", "secret-key")).toBe(false);
    expect(isFromKakao(null, "secret-key")).toBe(false);
  });

  it("서버에 키가 없으면 누구도 통과하지 못한다", () => {
    expect(isFromKakao("KakaoAK ", "")).toBe(false);
    expect(isFromKakao("KakaoAK undefined", undefined)).toBe(false);
  });
});

describe("parseShareWebhook", () => {
  it("상담 id·채팅방 종류·해시를 꺼낸다", () => {
    expect(
      parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "abc123", room: ROOM, TEMPLATE_ID: 1 }),
    ).toEqual({ roomId: ROOM, chatType: "DirectChat", hashChatId: "abc123" });
  });

  it("상담 id는 소문자로 맞춘다", () => {
    expect(parseShareWebhook({ CHAT_TYPE: "MemoChat", HASH_CHAT_ID: "h", room: ROOM.toUpperCase() })?.roomId).toBe(ROOM);
  });

  it("빠지거나 형식이 틀리면 null", () => {
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h" })).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: "not-a-uuid" })).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", room: ROOM })).toBeNull();
    expect(parseShareWebhook({ HASH_CHAT_ID: "h", room: ROOM })).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: 123, room: ROOM })).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "x".repeat(201), room: ROOM })).toBeNull();
  });
});
