import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 디스코드 보내기 (OPS-09): 웹훅이 없으면 조용히, 있으면 응답 뒤(after)에 POST, 응급은 10분에 한 번

const later: Array<() => unknown> = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => later.push(fn),
}));

const { notifyEnabled, notifyGeneral, notifyUrgent, resetNotifyForTests, sendDiscord, shouldSendUrgent } = await import("./notify");

const post = vi.fn(async () => ({ ok: true, status: 204 }));

async function flush() {
  for (const fn of later.splice(0)) await fn();
}

beforeEach(() => {
  later.length = 0;
  post.mockClear();
  resetNotifyForTests();
  vi.stubGlobal("fetch", post);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("웹훅이 없을 때", () => {
  it("아무것도 보내지 않고 상담 정보도 찾지 않는다", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_GENERAL", "");
    vi.stubEnv("DISCORD_WEBHOOK_URGENT", "");
    expect(notifyEnabled()).toBe(false);
    expect(await sendDiscord("general", "x")).toBe(false);
    notifyGeneral("x");
    notifyUrgent("k", "x");
    expect(later).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("웹훅이 있을 때", () => {
  beforeEach(() => {
    vi.stubEnv("DISCORD_WEBHOOK_GENERAL", "https://discord.com/api/webhooks/1/general");
    vi.stubEnv("DISCORD_WEBHOOK_URGENT", "https://discord.com/api/webhooks/1/urgent");
  });

  it("응답 뒤에 그 채널 주소로 content를 POST한다. 멘션은 풀지 않는다", async () => {
    expect(notifyEnabled()).toBe(true);
    notifyGeneral("🔗 상담 a1b2c3d4 | 고객이 링크를 열었어요");
    expect(post).not.toHaveBeenCalled();
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/1/general");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ content: "🔗 상담 a1b2c3d4 | 고객이 링크를 열었어요", allowed_mentions: { parse: [] } });
  });

  it("2000자 한도 안으로 자른다", async () => {
    await sendDiscord("urgent", "a".repeat(3000));
    const [, init] = post.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { content: string }).content).toHaveLength(1900);
  });

  it("디스코드가 거부하거나 닿지 않아도 던지지 않는다", async () => {
    post.mockResolvedValueOnce({ ok: false, status: 429 } as never);
    expect(await sendDiscord("general", "x")).toBe(false);
    post.mockRejectedValueOnce(new Error("timeout"));
    expect(await sendDiscord("general", "x")).toBe(false);
  });

  it("응급은 같은 열쇠를 10분 안에 두 번 보내지 않는다", async () => {
    notifyUrgent("turn:미설정", "🚨 1");
    notifyUrgent("turn:미설정", "🚨 2");
    notifyUrgent("turn:cloudflare 403", "🚨 3");
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
    const bodies = post.mock.calls.map((c) => (JSON.parse(String((c as unknown as [string, RequestInit])[1].body)) as { content: string }).content);
    expect(bodies).toEqual(["🚨 1", "🚨 3"]);
  });

  it("10분이 지나면 같은 열쇠도 다시 보낸다", () => {
    expect(shouldSendUrgent("k", 1_000_000)).toBe(true);
    expect(shouldSendUrgent("k", 1_000_000 + 9 * 60_000)).toBe(false);
    expect(shouldSendUrgent("k", 1_000_000 + 10 * 60_000)).toBe(true);
  });
});
