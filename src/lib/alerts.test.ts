import { describe, expect, it } from "vitest";
import { discordPayload } from "./alerts";
import { escapeMd } from "./alert-rules";

describe("discordPayload", () => {
  it("멘션을 막고, 토큰을 지우고, 디스코드 한도 안으로 자른다", () => {
    const p = discordPayload("alert", {
      title: "t".repeat(400),
      lines: [`/join/${"a".repeat(32)} 실패`],
      fields: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: "x".repeat(2000) })),
    });
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const e = p.embeds[0];
    expect(e.title!.length).toBeLessThanOrEqual(256);
    expect(e.description).toBe("/join/[token] 실패");
    expect(e.fields).toHaveLength(25);
    expect(e.fields![0].value.length).toBeLessThanOrEqual(1024);
    expect(e.color).toBe(0xef4444);
  });
  it("운영이 아니면 제목 앞에 환경을 붙인다", () => {
    const p = discordPayload("info", { title: "하루 요약" });
    expect(p.embeds[0].title).toMatch(/^\[(test|development)\] 하루 요약$/);
  });
});

describe("escapeMd", () => {
  it("폰에서 온 글자의 마크다운·링크·멘션을 막는다", () => {
    const out = escapeMd("[눌러](https://evil.test) **굵게** @everyone");
    expect(out).not.toContain("](");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/@everyone/);
  });
});
