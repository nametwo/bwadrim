import { describe, expect, it } from "vitest";
import { describeDevice, describeEvent, hasMessage, roomTag, shortId } from "./notify-events";

// 디스코드 글 만들기 (OPS-09). 어떤 이벤트가 어느 채널로 어떤 글이 되는지

const ROOM = { id: "3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b", engineer: "김도현", recipient: "역삼점" };

describe("roomTag", () => {
  it("상담 앞 8자리와 기사님 → 받는 분", () => {
    expect(shortId(ROOM.id)).toBe("3f2b9c1e");
    expect(roomTag(ROOM)).toBe("상담 3f2b9c1e · 김도현 → 역삼점");
    expect(roomTag({ ...ROOM, recipient: null })).toBe("상담 3f2b9c1e · 김도현");
    expect(roomTag({ ...ROOM, engineer: null })).toBe("상담 3f2b9c1e · 역삼점");
    expect(roomTag({ ...ROOM, engineer: null, recipient: null })).toBe("상담 3f2b9c1e");
  });
});

describe("describeDevice", () => {
  it("브라우저 정보를 한 단어로", () => {
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe("아이폰 사파리");
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) CriOS/129.0 Mobile/15E148 Safari/604.1")).toBe("아이폰 크롬");
    expect(describeDevice("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15")).toBe("아이패드");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; SM-S921N) Chrome/129.0.0.0 Mobile Safari/537.36")).toBe("안드로이드 크롬");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; SM-S921N) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36")).toBe("안드로이드 삼성 인터넷");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36")).toBe("PC");
    expect(describeDevice("")).toBe("기기 모름");
    expect(describeDevice(undefined)).toBe("기기 모름");
  });
});

describe("describeEvent — 일반 채널", () => {
  it("상담이 흘러가는 단계마다 한 줄", () => {
    expect(describeEvent("room_created", {}, ROOM)).toEqual({ general: "🆕 상담 3f2b9c1e · 김도현 → 역삼점 | 새 상담을 만들었어요" });
    expect(describeEvent("link_opened", { ua: "Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile", inapp: "kakaotalk" }, ROOM).general).toBe(
      "🔗 상담 3f2b9c1e · 김도현 → 역삼점 | 고객이 링크를 열었어요 (안드로이드 크롬 · 카카오톡 앱 안)",
    );
    expect(describeEvent("link_opened", { ua: "Mozilla/5.0 (iPhone) Safari", inapp: null }, ROOM).general).toContain("(아이폰 사파리)");
    expect(describeEvent("link_opened", { ua: "Mozilla/5.0 (Linux; Android 14) BAND/1.0", inapp: "band" }, ROOM).general).toContain("(안드로이드 크롬 · 밴드 앱 안)");
    expect(describeEvent("link_opened", { ua: "x", inapp: "webview" }, ROOM).general).toContain("(기기 모름 · 이름 모르는 앱의 웹뷰 안)");
    expect(describeEvent("link_opened", { ua: "x", inapp: "newapp" }, ROOM).general).toContain("newapp 앱 안");
    expect(describeEvent("camera_granted", { mic: true }, ROOM).general).toBe("📷 상담 3f2b9c1e · 김도현 → 역삼점 | 고객이 카메라를 켰어요");
    expect(describeEvent("camera_granted", { mic: false }, ROOM).general).toContain("(마이크 없이)");
    expect(describeEvent("camera_denied", { reason: "NotAllowedError" }, ROOM).general).toContain("고객이 카메라를 못 켰어요 (권한을 거부했거나 막혀 있음)");
    expect(describeEvent("camera_denied", { reason: "weird" }, ROOM).general).toContain("(weird)");
    expect(describeEvent("camera_denied", { reason: "unknown" }, ROOM).general).toContain("(원인 모름)");
    expect(describeEvent("camera_denied", { reason: "TrackStartError" }, ROOM).general).toContain("(다른 앱이 카메라를 쓰는 중)");
    expect(describeEvent("connected", { relay: false, turn: true }, ROOM).general).toContain("연결됐어요 (직접 연결)");
    expect(describeEvent("connected", { relay: true, turn: false }, ROOM).general).toContain("연결됐어요 (중계 서버 경유, TURN 없이)");
    expect(describeEvent("kakao_sent", { chat_type: "DirectChat" }, ROOM).general).toContain("카톡 카드가 채팅방에 갔어요 (1:1)");
  });

  it("끝남: 걸린 시간과 쓴 도구. 연결 없이 닫은 상담은 그렇게 적는다", () => {
    expect(describeEvent("ended", { duration_sec: 540, connected: true }, { ...ROOM, hadCamera: true, tools: ["pointer_used", "photo_taken"] })).toEqual({
      general: "⏹ 상담 3f2b9c1e · 김도현 → 역삼점 | 상담을 끝냈어요 · 9분 걸림 · 쓴 도구: 가리키기, 사진",
    });
    expect(describeEvent("ended", { duration_sec: 4000, connected: true }, { ...ROOM, tools: [] }).general).toContain("1시간 7분 걸림");
    expect(describeEvent("ended", { duration_sec: 120, connected: false }, { ...ROOM, hadCamera: false })).toEqual({
      general: "⏹ 상담 3f2b9c1e · 김도현 → 역삼점 | 상담을 끝냈어요 · 연결 없이",
    });
  });

  it("도구 사용·relay_used·turn_issued·모르는 이벤트는 따로 보내지 않는다", () => {
    for (const name of ["pointer_used", "freeze_used", "anchor_used", "guide_used", "photo_taken", "relay_used", "turn_issued", "whatever"]) {
      expect(describeEvent(name, {}, ROOM)).toEqual({});
    }
    // 글이 안 되는 이벤트는 상담 정보도 찾지 않게 미리 가른다
    for (const name of ["pointer_used", "relay_used", "turn_issued"]) expect(hasMessage(name)).toBe(false);
    for (const name of ["room_created", "link_opened", "camera_granted", "camera_denied", "connected", "connect_failed", "kakao_sent", "ended"]) expect(hasMessage(name)).toBe(true);
  });
});

describe("describeEvent — 응급 채널 (핵심 지표가 깨지는 신호)", () => {
  it("연결 실패는 일반에도 응급에도 간다. 같은 상담·같은 단계는 한 열쇠", () => {
    const m = describeEvent("connect_failed", { stage: "connecting" }, ROOM);
    expect(m.general).toBe("❌ 상담 3f2b9c1e · 김도현 → 역삼점 | 연결에 실패했어요 (연결하던 중)");
    expect(m.urgent?.key).toBe("connect_failed:3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b:connecting");
    expect(m.urgent?.text).toContain("🚨 연결 실패 — 상담 3f2b9c1e · 김도현 → 역삼점: 연결하던 중에 실패했어요");
    const mid = describeEvent("connect_failed", { stage: "call" }, ROOM);
    expect(mid.general).toContain("(통화 중에 끊김)");
    expect(mid.urgent?.text).toContain("통화 중에 끊겼어요");
    expect(mid.urgent?.key).toContain(":call");
  });

  it("카메라는 켰는데 연결 없이 끝난 상담은 응급", () => {
    const m = describeEvent("ended", { duration_sec: 300, connected: false }, { ...ROOM, hadCamera: true, tools: [] });
    expect(m.general).toContain("연결 없이");
    expect(m.urgent?.key).toBe("ended-no-connect:3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b");
    expect(m.urgent?.text).toContain("🚨 연결 없이 끝남");
    // 카메라를 켠 적 없으면(링크만 보내고 닫음) 응급이 아니다
    expect(describeEvent("ended", { duration_sec: 300, connected: false }, { ...ROOM, hadCamera: false }).urgent).toBeUndefined();
  });
});
