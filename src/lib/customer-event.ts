import type { EventName } from "./events";
import { isJoinToken } from "./join-token";

// 고객(비로그인) 쪽 지표 이벤트 검사 (DATA-04). /api/events가 받은 본문에서
// 이벤트마다 정해 둔 부가정보만 골라 새 객체로 만든다. 모르는 키·형식이 다른 값은 버린다.
// 횟수 제한은 없다(BUG-15). 여기서는 events.props에 아무 값이나 쌓이지 않게만 한다

export type CustomerEventName = Extract<
  EventName,
  "camera_granted" | "camera_denied" | "connected" | "relay_used" | "connect_failed"
>;

export type CustomerEvent = {
  token: string;
  name: CustomerEventName;
  props: Record<string, string | boolean>;
};

// getUserMedia 오류 이름(NotAllowedError 등)이나 'unsupported'. 그 밖의 글자는 'unknown'으로 바꾼다
const DENIED_REASON = /^[A-Za-z]{1,40}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickProps(name: CustomerEventName, raw: Record<string, unknown>): CustomerEvent["props"] | null {
  switch (name) {
    case "camera_granted":
      if (typeof raw.mic !== "boolean") return null;
      return { mic: raw.mic };
    case "camera_denied":
      return {
        reason: typeof raw.reason === "string" && DENIED_REASON.test(raw.reason) ? raw.reason : "unknown",
      };
    case "connected":
      if (typeof raw.relay !== "boolean" || typeof raw.turn !== "boolean") return null;
      return { relay: raw.relay, turn: raw.turn };
    case "relay_used":
      return {};
    case "connect_failed":
      // 연결하던 중 실패(connecting) / 통화 중 끊김(call). 그 밖의 값은 connecting으로
      return { stage: raw.stage === "call" ? "call" : "connecting" };
  }
}

const NAMES: readonly string[] = ["camera_granted", "camera_denied", "connected", "relay_used", "connect_failed"];

function isCustomerEventName(value: unknown): value is CustomerEventName {
  return typeof value === "string" && NAMES.includes(value);
}

/** 고객 이벤트 본문을 검사한다. 받을 수 없는 본문이면 null */
export function parseCustomerEvent(body: unknown): CustomerEvent | null {
  if (!isObject(body)) return null;
  const { token, name } = body;
  if (!isJoinToken(token) || !isCustomerEventName(name)) return null;
  const raw = isObject(body.props) ? body.props : {};
  const props = pickProps(name, raw);
  if (!props) return null;
  return { token, name, props };
}
