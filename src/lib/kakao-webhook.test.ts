import { describe, expect, it } from "vitest";
import { isFromKakao, kakaoShareArgs, parseShareWebhook } from "./kakao-webhook";

const ROOM = "3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = "secret-key";
const sig = kakaoShareArgs(ROOM, KEY)!.sig;

describe("isFromKakao", () => {
  it("대표 어드민 키가 맞으면 통과", () => {
    expect(isFromKakao("KakaoAK secret-key", KEY)).toBe(true);
  });

  it("키가 다르거나 형식이 다르면 거절", () => {
    expect(isFromKakao("KakaoAK wrong-key!", KEY)).toBe(false);
    expect(isFromKakao("Bearer secret-key", KEY)).toBe(false);
    expect(isFromKakao("secret-key", KEY)).toBe(false);
    expect(isFromKakao(null, KEY)).toBe(false);
  });

  it("서버에 키가 없으면 누구도 통과하지 못한다", () => {
    expect(isFromKakao("KakaoAK ", "")).toBe(false);
    expect(isFromKakao("KakaoAK undefined", undefined)).toBe(false);
  });
});

describe("kakaoShareArgs", () => {
  it("상담 id와 서명을 만든다. 키가 없으면 싣지 않는다", () => {
    expect(kakaoShareArgs(ROOM, KEY)).toEqual({ room: ROOM, sig: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(kakaoShareArgs(ROOM, undefined)).toBeNull();
    expect(kakaoShareArgs(ROOM, "")).toBeNull();
  });

  it("상담마다, 키마다 서명이 다르다", () => {
    expect(kakaoShareArgs(OTHER, KEY)!.sig).not.toBe(sig);
    expect(kakaoShareArgs(ROOM, "other-key")!.sig).not.toBe(sig);
  });
});

describe("parseShareWebhook", () => {
  it("상담 id·채팅방 종류·해시를 꺼낸다", () => {
    expect(
      parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "abc123", room: ROOM, sig, TEMPLATE_ID: 1 }, KEY),
    ).toEqual({ roomId: ROOM, chatType: "DirectChat", hashChatId: "abc123" });
  });

  it("상담 id는 소문자로 맞춘다", () => {
    expect(parseShareWebhook({ CHAT_TYPE: "MemoChat", HASH_CHAT_ID: "h", room: ROOM.toUpperCase(), sig }, KEY)?.roomId).toBe(ROOM);
  });

  it("서명이 없거나 다른 상담 것이면 null — 상담 id만 알아서는 남의 상담에 기록을 붙일 수 없다", () => {
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: ROOM }, KEY)).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: OTHER, sig }, KEY)).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: ROOM, sig: sig.slice(1) + "A" }, KEY)).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: ROOM, sig }, "other-key")).toBeNull();
  });

  it("빠지거나 형식이 틀리면 null", () => {
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", sig }, KEY)).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: "not-a-uuid", sig }, KEY)).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", room: ROOM, sig }, KEY)).toBeNull();
    expect(parseShareWebhook({ HASH_CHAT_ID: "h", room: ROOM, sig }, KEY)).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: 123, room: ROOM, sig }, KEY)).toBeNull();
    expect(parseShareWebhook({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "x".repeat(201), room: ROOM, sig }, KEY)).toBeNull();
  });
});
