import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.fn();
const later: Array<() => unknown> = [];

vi.mock("@/lib/events", () => ({ logEvent: (...args: unknown[]) => logEvent(...args) }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => later.push(fn),
}));

const { POST, GET } = await import("./route");

const ROOM = "3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b";
const URL_ = "https://bwadrim.test/api/kakao/share-webhook";
const kakaoHeaders = {
  authorization: "KakaoAK admin-key",
  "content-type": "application/json",
  "x-kakao-resource-id": "res-1",
};

function post(body: unknown, headers: Record<string, string> = kakaoHeaders) {
  return POST(new Request(URL_, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}

async function flush() {
  for (const fn of later.splice(0)) await fn();
}

beforeEach(() => {
  vi.stubEnv("KAKAO_ADMIN_KEY", "admin-key");
  logEvent.mockClear();
  later.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("카카오톡 공유 웹훅 (ROOM-15)", () => {
  it("카카오 요청이면 200을 먼저 주고, 응답 뒤에 kakao_sent를 남긴다", async () => {
    const res = await post({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "hash-a", room: ROOM });
    expect(res.status).toBe(200);
    expect(logEvent).not.toHaveBeenCalled();
    await flush();
    expect(logEvent).toHaveBeenCalledWith(ROOM, "system", "kakao_sent", {
      chat_type: "DirectChat",
      hash_chat_id: "hash-a",
      resource_id: "res-1",
    });
  });

  it("어드민 키가 다르면 401, 기록 없음", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: ROOM }, { ...kakaoHeaders, authorization: "KakaoAK nope" });
    expect(res.status).toBe(401);
    expect(warn).toHaveBeenCalledWith("[kakao-webhook] 어드민 키 불일치");
    expect(String(warn.mock.calls)).not.toContain("nope");
    await flush();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("서버에 키가 없으면 모두 401", async () => {
    vi.stubEnv("KAKAO_ADMIN_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h", room: ROOM }, { ...kakaoHeaders, authorization: "KakaoAK " });
    expect(res.status).toBe(401);
  });

  it("카카오 요청인데 값이 이상하면 200만 주고 남기지 않는다 (웹훅이 꺼지지 않게)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post({ CHAT_TYPE: "DirectChat", HASH_CHAT_ID: "h" })).status).toBe(200);
    expect((await post("not json")).status).toBe(200);
    expect((await post([1, 2])).status).toBe(200);
    await flush();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("GET으로 등록한 경우 쿼리에서 읽는다", async () => {
    const q = new URLSearchParams({ CHAT_TYPE: "MemoChat", HASH_CHAT_ID: "hash-me", room: ROOM });
    const res = await GET(new Request(`${URL_}?${q}`, { headers: { authorization: "KakaoAK admin-key" } }));
    expect(res.status).toBe(200);
    await flush();
    expect(logEvent).toHaveBeenCalledWith(ROOM, "system", "kakao_sent", {
      chat_type: "MemoChat",
      hash_chat_id: "hash-me",
      resource_id: null,
    });
  });
});
