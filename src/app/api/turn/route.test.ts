import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TURN 발급 (NET-01·02): Cloudflare와 DB를 흉내 내 '내주기 전에 세고, 내준 뒤 turn_issued를 남기는지'를 본다.
// e2e(e2e/turn.spec.ts)는 Cloudflare 키가 없어 상한 판정까지만 보고, 발급·기록은 여기서 본다

const logEvent = vi.fn(async () => {});
const ROOM = { id: "3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b", status: "waiting", expires_at: "" };
let issued: number | null = 0;
let countError: { message: string } | null = null;

vi.mock("@/lib/events", () => ({ logEvent: (...args: unknown[]) => logEvent(...(args as [])) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "rooms") {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: ROOM, error: null }) };
        return q;
      }
      // events: select('id', {count, head}).eq().eq() 를 await 하면 {count, error}
      const q = {
        select: () => q,
        eq: () => q,
        then: (resolve: (v: { count: number | null; error: typeof countError }) => void) => resolve({ count: issued, error: countError }),
      };
      return q;
    },
  }),
}));

const { GET } = await import("./route");

const TOKEN = "a".repeat(32);
const TURN_SERVER = { urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:53?transport=udp"] };
const cloudflare = vi.fn(async () => ({ ok: true, json: async () => ({ iceServers: [TURN_SERVER] }), text: async () => "" }));

async function get() {
  const res = await GET(new Request(`https://bwadrim.test/api/turn?t=${TOKEN}`));
  return { status: res.status, body: (await res.json()) as { iceServers: RTCIceServer[]; turnError: string | null } };
}

beforeEach(() => {
  ROOM.expires_at = new Date(Date.now() + 3 * 3600_000).toISOString();
  issued = 0;
  countError = null;
  logEvent.mockClear();
  cloudflare.mockClear();
  vi.stubGlobal("fetch", cloudflare);
  vi.stubEnv("CLOUDFLARE_TURN_KEY_ID", "key-id");
  vi.stubEnv("CLOUDFLARE_TURN_API_TOKEN", "api-token");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/turn", () => {
  it("상한 아래면 Cloudflare에서 받아 내주고 turn_issued를 남긴다 (53번 포트 URL은 뺀다)", async () => {
    issued = 39;
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.turnError).toBeNull();
    expect(cloudflare).toHaveBeenCalledTimes(1);
    expect(body.iceServers.map((s) => s.urls).flat()).toEqual(["stun:stun.l.google.com:19302", "turn:turn.example.com:3478?transport=udp"]);
    expect(logEvent).toHaveBeenCalledWith(ROOM.id, "system", "turn_issued", { ttl: 7200 });
  });

  it("유효시간은 상담 만료까지(최소 30분, 최대 2시간)", async () => {
    ROOM.expires_at = new Date(Date.now() + 45 * 60_000).toISOString();
    await get();
    const body = JSON.parse(String((cloudflare.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { ttl: number };
    expect(body.ttl).toBeGreaterThanOrEqual(44 * 60);
    expect(body.ttl).toBeLessThanOrEqual(45 * 60);
    expect(logEvent).toHaveBeenCalledWith(ROOM.id, "system", "turn_issued", { ttl: body.ttl });
  });

  it("40회가 쌓였으면 Cloudflare를 부르지 않고 STUN만, 기록도 남기지 않는다", async () => {
    issued = 40;
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.turnError).toContain("발급 횟수 40회");
    expect(body.iceServers).toHaveLength(1);
    expect(cloudflare).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("횟수를 세지 못하면 막지 않고 내준다 (통화가 먼저)", async () => {
    countError = { message: "db down" };
    const { body } = await get();
    expect(body.turnError).toBeNull();
    expect(cloudflare).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("Cloudflare 키가 없으면 '미설정'으로 STUN만, 기록 없음", async () => {
    vi.stubEnv("CLOUDFLARE_TURN_KEY_ID", "");
    const { body } = await get();
    expect(body.turnError).toContain("미설정");
    expect(cloudflare).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("Cloudflare가 오류를 주면 STUN만, 기록 없음", async () => {
    cloudflare.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}), text: async () => "forbidden" } as never);
    const { body } = await get();
    expect(body.turnError).toContain("cloudflare 403");
    expect(logEvent).not.toHaveBeenCalled();
  });
});
