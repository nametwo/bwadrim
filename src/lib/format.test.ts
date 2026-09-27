import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatDuration,
  formatKstDateTime,
  formatKstDay,
  formatKstTime,
  kstMonthStartIso,
} from "./format";

// 2026-09-27 17:03 KST (일요일)
const NOW = new Date("2026-09-27T08:03:00Z");

describe("formatKstTime", () => {
  it("오전·오후와 12시를 한국식으로", () => {
    expect(formatKstTime(new Date("2026-09-27T08:03:00Z"))).toBe("오후 5:03");
    expect(formatKstTime(new Date("2026-09-26T15:00:00Z"))).toBe("오전 12:00"); // 한국 자정
    expect(formatKstTime(new Date("2026-09-27T03:30:00Z"))).toBe("오후 12:30"); // 한국 정오 반
    expect(formatKstTime(new Date("2026-09-27T00:05:00Z"))).toBe("오전 9:05");
  });
});

describe("formatKstDay", () => {
  it("오늘·어제·그 밖의 날(요일)", () => {
    expect(formatKstDay(new Date("2026-09-26T15:00:00Z"), NOW)).toBe("오늘"); // 27일 0시 KST
    expect(formatKstDay(new Date("2026-09-26T14:59:00Z"), NOW)).toBe("어제"); // 26일 23:59 KST
    expect(formatKstDay(new Date("2026-09-24T03:00:00Z"), NOW)).toBe("9월 24일 (목)");
    expect(formatKstDay(new Date("2025-12-30T03:00:00Z"), NOW)).toBe("2025년 12월 30일 (화)");
  });

  it("날짜와 시각", () => {
    expect(formatKstDateTime(new Date("2026-09-27T01:10:00Z"), NOW)).toBe("오늘 오전 10:10");
  });
});

describe("formatDuration · formatClock", () => {
  it("걸린 시간", () => {
    expect(formatDuration(42)).toBe("42초");
    expect(formatDuration(12 * 60 + 10)).toBe("12분");
    expect(formatDuration(65 * 60)).toBe("1시간 5분");
    expect(formatDuration(120 * 60)).toBe("2시간");
  });

  it("통화 시계", () => {
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(3 * 60 + 12)).toBe("3:12");
    expect(formatClock(3600 + 2 * 60 + 9)).toBe("1:02:09");
  });
});

describe("kstMonthStartIso", () => {
  it("한국 시간 1일 0시", () => {
    expect(kstMonthStartIso(NOW)).toBe("2026-08-31T15:00:00.000Z");
    // 한국은 이미 10월 1일인 순간
    expect(kstMonthStartIso(new Date("2026-09-30T16:00:00Z"))).toBe("2026-09-30T15:00:00.000Z");
  });
});
