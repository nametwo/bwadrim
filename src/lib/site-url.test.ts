import { afterEach, describe, expect, it, vi } from "vitest";

// 서비스 주소 (OPS-07): 빌드 때 들어가는 NEXT_PUBLIC_SITE_URL을 'https://호스트' 꼴로만 받는다
async function load(value: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
  return (await import("./site-url")).SITE_URL;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SITE_URL", () => {
  it("https://호스트 꼴이면 그대로 쓰고, 앞뒤 공백과 끝 슬래시는 뗀다", async () => {
    expect(await load("https://bwadrim.com")).toBe("https://bwadrim.com");
    expect(await load("https://bwadrim.com/")).toBe("https://bwadrim.com");
    expect(await load(" https://bwadrim.com ")).toBe("https://bwadrim.com");
    expect(await load("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("안 정했으면 null이고 조용하다 — 로컬·미리보기는 요청 host를 쓴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await load("")).toBe(null);
    expect(warn).not.toHaveBeenCalled();
  });

  it("꼴이 다르면(스킴 없음, 경로 붙음) 없는 것으로 치고 서버 로그에 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await load("bwadrim.com")).toBe(null);
    expect(await load("https://bwadrim.com/join")).toBe(null);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("NEXT_PUBLIC_SITE_URL");
  });
});
