import { expect, test } from "@playwright/test";
import { FIXTURE, SUPABASE_URL, mockEvents, mockReset } from "./helpers";

// TURN 자격증명 발급 (NET-01·02, BUG-15):
//  - 유효한 링크 토큰이 있어야 한다. 형식이 다른 토큰은 400, 없는·만료된·끝난 상담은 404
//  - 한 상담에서 40번 내줬으면 그 뒤로는 STUN만 준다(turnError에 상한 안내). 발급 때마다 turn_issued를 남겨 그 개수로 센다
// 가짜 Supabase(e2e/mock-supabase.mjs)에는 Cloudflare 키가 없어 실제 발급은 '미설정'으로 끝난다 — 상한 판정만 본다.
// 상한에 걸리면 Cloudflare를 부르지 않으므로 '미설정'이 아니라 상한 문구가 와야 한다.
// 발급·기록 자체는 단위 테스트 src/app/api/turn/route.test.ts(Cloudflare·DB를 흉내)가 본다.
// 방 10·11번(a010·a011)은 이 파일 전용 — 다른 spec과 같은 방을 쓰면 두 워커가 서로의 기록을 지운다

test.describe.configure({ mode: "serial" });

const ROOM = FIXTURE.rooms[9];
const TURN = `/api/turn?t=${ROOM.join_token}`;
const LIMIT = 40;

type TurnBody = { iceServers: { urls: string | string[] }[]; turnError: string | null };

/** 이 상담에 turn_issued 기록을 n개 쌓아 둔다 (서비스 키로 직접 넣는다) */
async function seedIssued(n: number) {
  const rows = Array.from({ length: n }, () => ({ room_id: ROOM.id, actor: "system", name: "turn_issued", props: { ttl: 7200 } }));
  const r = await fetch(`${SUPABASE_URL}/rest/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: FIXTURE.serviceKey },
    body: JSON.stringify(rows),
  });
  expect(r.status).toBe(201);
}

async function issuedCount() {
  return (await mockEvents()).filter((e) => e.room_id === ROOM.id && e.name === "turn_issued").length;
}

async function patchRoom(patch: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/__patch-room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ROOM.id, ...patch }),
  });
  expect(r.ok).toBe(true);
}

test.beforeEach(async () => {
  await mockReset(ROOM.id);
});

test.afterAll(async () => {
  await mockReset(ROOM.id);
});

test("형식이 다른 토큰은 400, 없는·만료된·끝난 상담은 404 (NET-02)", async ({ request }) => {
  expect((await request.get("/api/turn?t=abc")).status()).toBe(400);
  expect((await request.get("/api/turn")).status()).toBe(400);

  // 형식은 맞지만 없는 상담
  expect((await request.get(`/api/turn?t=${"f".repeat(32)}`)).status()).toBe(404);
  await patchRoom({ expires_at: new Date(Date.now() - 60_000).toISOString() });
  expect((await request.get(TURN)).status()).toBe(404);
  await mockReset(ROOM.id);
  await patchRoom({ status: "ended" });
  expect((await request.get(TURN)).status()).toBe(404);
});

test("상한 아래면 발급을 시도한다 — 키가 없어 '미설정'으로 STUN만 (NET-01)", async ({ request }) => {
  await seedIssued(LIMIT - 1);
  const res = await request.get(TURN);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const body = (await res.json()) as TurnBody;
  expect(body.turnError).toContain("미설정");
  expect(body.iceServers).toHaveLength(1);
  expect(String(body.iceServers[0].urls)).toMatch(/^stun:/);
});

test(`${LIMIT}회가 쌓인 상담은 STUN만 주고 상한 문구를 돌려준다 · 기록은 더 쌓이지 않는다 (NET-02, BUG-15)`, async ({ request }) => {
  await seedIssued(LIMIT);
  const res = await request.get(TURN);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as TurnBody;
  expect(body.turnError).toContain(`발급 횟수 ${LIMIT}회`);
  expect(body.turnError).not.toContain("미설정");
  expect(body.iceServers).toHaveLength(1);
  expect(await issuedCount()).toBe(LIMIT);

  // 다른 상담은 영향을 받지 않는다
  const other = await request.get(`/api/turn?t=${FIXTURE.rooms[10].join_token}`);
  expect(((await other.json()) as TurnBody).turnError).toContain("미설정");

  // 응급 채널(가짜 웹훅)에 상한 알림 (OPS-09)
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(`${SUPABASE_URL}/__discord`)).json()) as { channel: string; content: string }[];
        return all.some((m) => m.channel === "urgent" && m.content.includes("TURN 발급 상한") && m.content.includes(`상담 ${ROOM.id.slice(0, 8)}`));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});
