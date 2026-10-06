import { describe, expect, it } from "vitest";
import { cleanLabel, LABEL_MAX } from "./recipient-label";

describe("cleanLabel (ROOM-16)", () => {
  it("앞뒤·겹친 공백을 줄인다", () => {
    expect(cleanLabel("  김   사장님 ")).toBe("김 사장님");
    expect(cleanLabel("역삼점\n카드")).toBe("역삼점 카드");
  });

  it("비었거나 글자가 아니면 null", () => {
    expect(cleanLabel("")).toBeNull();
    expect(cleanLabel("   ")).toBeNull();
    expect(cleanLabel(null)).toBeNull();
    expect(cleanLabel(3)).toBeNull();
  });

  it("30자까지 자른다 (이모지·한글도 한 글자씩)", () => {
    expect(cleanLabel("가".repeat(40))).toBe("가".repeat(LABEL_MAX));
    expect(Array.from(cleanLabel("😀".repeat(31))!)).toHaveLength(LABEL_MAX);
  });
});
