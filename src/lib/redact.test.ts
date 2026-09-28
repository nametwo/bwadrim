import { describe, expect, it } from "vitest";
import { redactProps, redactText } from "./redact";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("redactText", () => {
  it("링크 토큰(32자리 16진수)을 지운다", () => {
    expect(redactText(`https://x.app/join/${TOKEN}?a=1`)).toBe("https://x.app/join/[token]?a=1");
    expect(redactText(TOKEN.toUpperCase())).toBe("[token]");
  });
  it("상담 id(대시 있는 uuid)·pid(16자리)는 그대로", () => {
    const uuid = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    expect(redactText(uuid)).toBe(uuid);
    expect(redactText("0123456789abcdef")).toBe("0123456789abcdef");
  });
  it("길면 자른다", () => {
    expect(redactText("가".repeat(10), 4)).toBe("가가가가…");
  });
});

describe("redactProps", () => {
  it("안쪽 값·키까지 토큰을 지우고 JSON으로 못 보내는 값은 뺀다", () => {
    const out = redactProps({
      msg: `failed /join/${TOKEN}`,
      nested: { list: [TOKEN, 1, true, null], inf: Infinity },
      fn: () => 1,
      undef: undefined,
    });
    expect(out).toEqual({
      msg: "failed /join/[token]",
      nested: { list: ["[token]", 1, true, null], inf: null },
    });
  });
  it("너무 깊은 값은 null", () => {
    expect(redactProps({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: null } } } });
  });
});
