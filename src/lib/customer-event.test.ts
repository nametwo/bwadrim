import { describe, expect, it } from "vitest";
import { parseCustomerEvent } from "./customer-event";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("parseCustomerEvent", () => {
  it("고객 화면(camera-start.tsx postEvent)이 보내는 값은 모두 통과한다", () => {
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_granted", props: { mic: true } })).toEqual({
      token: TOKEN,
      name: "camera_granted",
      props: { mic: true },
    });
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_granted", props: { mic: false } })?.props).toEqual({
      mic: false,
    });
    for (const reason of ["NotAllowedError", "NotReadableError", "NotFoundError", "OverconstrainedError", "unsupported", "unknown"]) {
      expect(parseCustomerEvent({ token: TOKEN, name: "camera_denied", props: { reason } })?.props).toEqual({ reason });
    }
    expect(parseCustomerEvent({ token: TOKEN, name: "connected", props: { relay: true, turn: true } })?.props).toEqual({
      relay: true,
      turn: true,
    });
    expect(parseCustomerEvent({ token: TOKEN, name: "connected", props: { relay: false, turn: false } })?.props).toEqual({
      relay: false,
      turn: false,
    });
    // postEvent("relay_used")는 props 기본값 {}를 보낸다
    expect(parseCustomerEvent({ token: TOKEN, name: "relay_used", props: {} })).toEqual({
      token: TOKEN,
      name: "relay_used",
      props: {},
    });
  });

  it("본문이 객체가 아니면 null", () => {
    expect(parseCustomerEvent(null)).toBeNull();
    expect(parseCustomerEvent(undefined)).toBeNull();
    expect(parseCustomerEvent("camera_granted")).toBeNull();
    expect(parseCustomerEvent(42)).toBeNull();
    expect(parseCustomerEvent([TOKEN, "relay_used"])).toBeNull();
  });

  it("토큰 형식이 틀리면 null", () => {
    expect(parseCustomerEvent({ name: "relay_used", props: {} })).toBeNull();
    expect(parseCustomerEvent({ token: "abc123", name: "relay_used", props: {} })).toBeNull();
    expect(parseCustomerEvent({ token: TOKEN.toUpperCase(), name: "relay_used", props: {} })).toBeNull();
    expect(parseCustomerEvent({ token: 123, name: "relay_used", props: {} })).toBeNull();
  });

  it("고객이 남길 수 없는 이벤트 이름이면 null", () => {
    for (const name of ["room_created", "link_opened", "ended", "kakao_sent", "pointer_used", "", undefined, 1]) {
      expect(parseCustomerEvent({ token: TOKEN, name, props: {} })).toBeNull();
    }
  });

  it("모르는 키는 버리고 정해 둔 키만 새 객체로 남긴다", () => {
    const parsed = parseCustomerEvent({
      token: TOKEN,
      name: "connected",
      props: { relay: true, turn: false, junk: "x".repeat(1000), nested: { a: 1 } },
      extra: "무시",
    });
    expect(parsed).toEqual({ token: TOKEN, name: "connected", props: { relay: true, turn: false } });
    expect(parseCustomerEvent({ token: TOKEN, name: "relay_used", props: { anything: 1 } })?.props).toEqual({});
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_granted", props: { mic: true, reason: "x" } })?.props).toEqual({
      mic: true,
    });
  });

  it("정해 둔 키의 형식이 틀리면 null", () => {
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_granted", props: {} })).toBeNull();
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_granted", props: { mic: "true" } })).toBeNull();
    expect(parseCustomerEvent({ token: TOKEN, name: "connected", props: { relay: true } })).toBeNull();
    expect(parseCustomerEvent({ token: TOKEN, name: "connected", props: { relay: 1, turn: 0 } })).toBeNull();
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_granted" })).toBeNull();
  });

  it("카메라 거부 이유가 영문 이름 꼴이 아니면 'unknown'으로 바꾼다", () => {
    for (const reason of ["", "x".repeat(41), "Not Allowed", "<script>", "거부", 404, null, { a: 1 }]) {
      expect(parseCustomerEvent({ token: TOKEN, name: "camera_denied", props: { reason } })?.props).toEqual({
        reason: "unknown",
      });
    }
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_denied" })?.props).toEqual({ reason: "unknown" });
    expect(parseCustomerEvent({ token: TOKEN, name: "camera_denied", props: { reason: "x".repeat(40) } })?.props).toEqual({
      reason: "x".repeat(40),
    });
  });

  it("props가 객체가 아니면 빈 것으로 본다", () => {
    expect(parseCustomerEvent({ token: TOKEN, name: "relay_used", props: "big" })?.props).toEqual({});
    expect(parseCustomerEvent({ token: TOKEN, name: "relay_used" })?.props).toEqual({});
    expect(parseCustomerEvent({ token: TOKEN, name: "relay_used", props: [1, 2] })?.props).toEqual({});
    expect(parseCustomerEvent({ token: TOKEN, name: "connected", props: null })).toBeNull();
  });
});
