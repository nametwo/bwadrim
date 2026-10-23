import { expect, test, type Page } from "@playwright/test";
import { CLIPS, fakeCamera, mockReset, mockRoom } from "./helpers";
import { describeHub } from "./realtime-mock";
import { EXPIRED, connected, customerJoin, engineerReady, mock, useRig, type Rig } from "./screens/rig";

// 통화 시그널링이 흔들리거나 가짜 신호가 와도 통화가 버티는지 (CALL-05·07·12·13, ROOM-10):
//  ① 고객 폰의 시그널링 소켓만 잠깐 끊겼다 다시 붙으면(앱 전환·망 전환) 영상 연결은 그대로다.
//     엔지니어는 대기 화면으로 가지 않고, 고객은 '다시 연결'을 누를 일이 없다
//  ② 링크를 가진 제3자가 고객 채널(:c)에 진짜 고객 기기 id로 종료(bye)를 보내도 연결된 상담은 닫히지 않는다.
//     진짜 고객이 '통화 종료' → '끝내기'를 누르면 그대로 닫힌다
//  ③ 엔지니어 소켓만 잠깐 끊겼다 붙어도 고객은 8초 기다려 연결을 그대로 둔다(새 offer 없음, '기기가 바뀌었어요' 없음)
//  ④ 진짜 고객 기기 id로 다른 인증서의 offer가 오면 '고객 쪽 기기가 바뀌었어요'가 뜬다
//  ⑤ 한쪽 소켓이 유예(8초)보다 오래 끊겼다 같은 기기로 돌아오면 저절로 이어진다 — 고객이 오래 끊긴 경우는 엔지니어가
//     reoffer를 보내고, 엔지니어가 오래 끊긴 경우는 고객이 '기사님을 다시 기다리는 중…'에서 새로 청한다
//  ⑥ offer가 유실되면 고객이 10초 뒤 다시 청한다
// 준비는 화면 카탈로그와 같다(e2e/screens/rig.ts: 가짜 서버·가짜 카메라·실제 WebRTC 루프백).
// 다른 통화 테스트와 동시에 돌아도 방이 겹치지 않게, e2e에서 안 쓰는 만료 방(rooms[1])을 하루 살려 쓰고 끝나면 되돌린다.

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });
test.describe.configure({ mode: "serial" });

const ROOM = EXPIRED;
const C_LANE = `room:${ROOM.id}:c`;
const E_LANE = `room:${ROOM.id}:e`;
// 확인 창이 뜬 직후(0.6초)의 탭은 일부러 무시하므로 조금 기다렸다 누른다
const ARM_WAIT_MS = 700;
// call.ts PEER_GONE_GRACE_MS(8초)보다 조금 더
const PAST_GRACE_MS = 9_000;

test.beforeEach(async () => {
  await mockReset(ROOM.id);
  await mock("/__patch-room", { id: ROOM.id, expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() });
});

test.afterEach(async () => {
  await mockReset(ROOM.id);
});

async function start(rig: Rig) {
  const ep = await rig.engineer();
  const cp = await rig.customer();
  const logs: string[] = [];
  for (const [who, p] of [["eng", ep], ["cust", cp]] as const) p.on("pageerror", (e) => logs.push(`[${who}] ${e.message}`));
  await engineerReady(ep, ROOM.id);
  await customerJoin(cp, ROOM.join_token);
  await connected(ep, cp);
  await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
  return { ep, cp, logs };
}

// 지금 채널에 올라 있는 기기 id 하나 (고객 = :c, 엔지니어 = :e)
function deviceId(rig: Rig, lane: string): string {
  const metas = rig.hub.presence(lane);
  expect(metas).toHaveLength(1);
  const id = metas[0].id;
  expect(typeof id).toBe("string");
  return id as string;
}

function offers(rig: Rig) {
  return rig.hub.broadcasts.filter((b) => b.event === "offer" && b.topic.endsWith(":c")).length;
}

type Seen = { waiting: boolean; peerChanged: boolean };

// 엔지니어 화면을 지켜보다가 한 번이라도 대기 화면(eng-waiting)이나 '고객 쪽 기기가 바뀌었어요'가 떴는지 남긴다
async function watch(ep: Page) {
  await ep.evaluate(() => {
    const seen = { waiting: false, peerChanged: false };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const check = () => {
      if (document.querySelector('[data-testid="eng-waiting"]')) seen.waiting = true;
      if (document.body.innerText.includes("고객 쪽 기기가 바뀌었어요")) seen.peerChanged = true;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    check();
  });
}

function seen(ep: Page): Promise<Seen> {
  return ep.evaluate(() => (window as unknown as { __seen: Seen }).__seen);
}

function dumpOnFail(rig: Rig, logs: string[]) {
  if (test.info().status !== test.info().expectedStatus) console.log("hub:", describeHub(rig.hub), logs.join("\n"));
}

test("고객 폰의 시그널링 소켓만 잠깐 끊겨도 통화는 그대로 (엔지니어 대기 화면 없음, 고객 '다시 연결' 없이)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp, logs } = await start(rig);
    try {
      const customer = deviceId(rig, C_LANE);
      await watch(ep);

      // 고객 소켓만 닫는다. 엔지니어는 고객 presence가 사라진 것을 본다
      expect(rig.hub.disconnect((t) => t === C_LANE)).toBe(1);
      const droppedAt = Date.now();
      expect(rig.hub.presence(C_LANE)).toEqual([]);
      // realtime-js가 스스로 다시 붙어 같은 기기 id로 다시 올린다
      await expect.poll(() => rig.hub.presence(C_LANE).map((m) => m.id), { timeout: 15_000 }).toEqual([customer]);

      // 엔지니어 쪽 유예가 지나도록 기다려도 대기 화면·'기기가 바뀌었어요' 없이 같은 연결이 이어진다
      await ep.waitForTimeout(Math.max(0, droppedAt + PAST_GRACE_MS - Date.now()));
      expect(await seen(ep)).toEqual({ waiting: false, peerChanged: false });
      await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요");
      await expect(cp.getByRole("button", { name: /다시 연결/ })).toHaveCount(0);
      expect(offers(rig)).toBe(1); // 다시 협상하지 않았다
      expect(logs).toEqual([]);
    } finally {
      dumpOnFail(rig, logs);
    }
  });
});

test("고객 채널로 온 가짜 종료(bye)로는 연결된 상담이 닫히지 않고, 진짜 고객이 끝내면 닫힌다 (ROOM-10)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp, logs } = await start(rig);
    try {
      const customer = deviceId(rig, C_LANE);
      await watch(ep);

      // 링크를 가진 제3자: 고객 채널을 엿들어 알아낸 진짜 고객 기기 id로 종료를 보낸다
      rig.hub.inject(C_LANE, "bye", { from: customer, role: "customer" });
      await ep.waitForTimeout(6_000);
      await expect(ep.getByTestId("eng-customer-ended")).toHaveCount(0);
      await expect(ep.getByTestId("eng-closing")).toHaveCount(0);
      await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요");
      expect((await mockRoom(ROOM.id))?.status).not.toBe("ended");
      expect(await seen(ep)).toEqual({ waiting: false, peerChanged: false });

      // 진짜 고객이 끝내면 엔지니어 화면도 상담을 닫는다
      await cp.getByRole("button", { name: "통화 종료" }).click();
      const sheet = cp.getByTestId("cust-end-sheet");
      await expect(sheet).toBeVisible();
      await cp.waitForTimeout(ARM_WAIT_MS);
      await sheet.getByRole("button", { name: "끝내기", exact: true }).click();
      await expect(cp.getByTestId("cust-ended")).toBeVisible();
      await expect(ep.getByTestId("eng-customer-ended")).toContainText("고객님이 통화를 끝냈어요", { timeout: 10_000 });
      await expect.poll(async () => (await mockRoom(ROOM.id))?.status).toBe("ended");
      expect(logs).toEqual([]);
    } finally {
      dumpOnFail(rig, logs);
    }
  });
});

test("고객 소켓이 유예(8초)보다 오래 끊겼다 같은 폰으로 돌아오면 엔지니어가 다시 맺자고 알려(reoffer) 저절로 이어진다 (CALL-05)", async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp, logs } = await start(rig);
    try {
      const customer = deviceId(rig, C_LANE);
      await watch(ep);

      // 고객 소켓을 끊고 12초 동안 다시 못 붙게 한다 (realtime-js는 1·2·5·10초 간격으로 다시 시도 → 약 18초 뒤 복귀)
      expect(rig.hub.disconnect((t) => t === C_LANE, 12_000)).toBe(1);
      // 엔지니어는 8초 뒤 연결을 버리고 대기 화면('고객님을 다시 기다리고 있어요')으로 간다
      await expect(ep.getByTestId("eng-waiting")).toBeVisible({ timeout: 20_000 });
      expect(rig.hub.presence(C_LANE)).toEqual([]);

      // 같은 기기 id로 돌아온다 → 엔지니어가 reoffer → 고객이 새 offer → 다시 통화 중. 아무도 버튼을 누르지 않는다
      await expect.poll(() => rig.hub.presence(C_LANE).map((m) => m.id), { timeout: 40_000 }).toEqual([customer]);
      await expect.poll(() => rig.hub.broadcasts.filter((b) => b.event === "reoffer" && b.topic.endsWith(":e")).length, { timeout: 10_000 }).toBe(1);
      await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중", { timeout: 30_000 });
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
      await expect(cp.getByRole("button", { name: /다시 연결/ })).toHaveCount(0);
      expect(offers(rig)).toBe(2);
      // 같은 기기라 '기기가 바뀌었어요'는 없다
      expect((await seen(ep)).peerChanged).toBe(false);
      expect(logs).toEqual([]);
    } finally {
      dumpOnFail(rig, logs);
    }
  });
});

test("엔지니어 소켓이 유예(8초)보다 오래 끊기면 고객은 '기사님을 다시 기다리는 중…', 돌아오면 고객이 새로 청해 이어진다 (CALL-05)", async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp, logs } = await start(rig);
    try {
      const engineer = deviceId(rig, E_LANE);
      expect(rig.hub.disconnect((t) => t === E_LANE, 12_000)).toBe(1);
      // 고객은 8초 뒤 연결을 버리고 다시 기다린다 — 처음 기다릴 때의 '카메라 켰다고 알려 주세요'가 아니다
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 다시 기다리는 중…", { timeout: 20_000 });
      await expect(cp.getByText(/기사님이 다시 들어오면 바로 이어져요/)).toBeVisible();
      // 같은 기기 id로 돌아오면 고객이 새로 청해 이어진다. 아무도 버튼을 누르지 않는다
      await expect.poll(() => rig.hub.presence(E_LANE).map((m) => m.id), { timeout: 40_000 }).toEqual([engineer]);
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
      await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중", { timeout: 30_000 });
      await expect(cp.getByRole("button", { name: /다시 연결/ })).toHaveCount(0);
      expect(offers(rig)).toBe(2);
      expect(logs).toEqual([]);
    } finally {
      dumpOnFail(rig, logs);
    }
  });
});

test("offer가 유실되면(상대 소켓이 재접속 중) 고객이 10초 뒤 다시 청해 연결된다 (CALL-03)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const cp = await rig.customer();
    const logs: string[] = [];
    for (const [who, p] of [["eng", ep], ["cust", cp]] as const) p.on("pageerror", (e) => logs.push(`[${who}] ${e.message}`));
    try {
      await engineerReady(ep, ROOM.id);
      rig.hub.drop.add("offer"); // 첫 offer는 사라진다
      await customerJoin(cp, ROOM.join_token);
      await expect.poll(() => offers(rig), { timeout: 20_000 }).toBe(1);
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님과 연결하는 중…");
      rig.hub.drop.delete("offer");
      // 10초가 지나면 두 번째 offer가 가고, 이번엔 answer가 와서 연결된다
      await expect.poll(() => offers(rig), { timeout: 20_000 }).toBe(2);
      await connected(ep, cp);
      await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
      await expect(cp.getByRole("button", { name: /다시 연결/ })).toHaveCount(0);
      expect(logs).toEqual([]);
    } finally {
      dumpOnFail(rig, logs);
    }
  });
});

test("엔지니어 소켓만 잠깐 끊겨도 통화는 그대로 (고객은 다시 연결하지 않음, '기기가 바뀌었어요' 없음)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp, logs } = await start(rig);
    try {
      await watch(ep);
      expect(offers(rig)).toBe(1);
      expect(rig.hub.disconnect((t) => t === E_LANE)).toBe(1);
      // 고객은 엔지니어 presence가 사라져도 통화가 살아 있으면 8초 기다린다(CALL-05). 그 안에 같은 기기가 돌아오면
      // 연결을 그대로 둔다 — 새 offer 없음, 고객 화면은 계속 '기사님이 보고 있어요'
      expect(rig.hub.presence(E_LANE).length).toBe(0);
      await expect.poll(() => rig.hub.presence(E_LANE).length, { timeout: 20_000 }).toBe(1);
      await cp.waitForTimeout(3_000);
      expect(offers(rig)).toBe(1);
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요");
      await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
      expect((await seen(ep)).peerChanged).toBe(false);
      expect(logs).toEqual([]);
    } finally {
      dumpOnFail(rig, logs);
    }
  });
});

test("진짜 고객 기기 id로 다른 인증서의 offer가 오면 '고객 쪽 기기가 바뀌었어요' (CALL-12·13)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp, logs } = await start(rig);
    try {
      const customer = deviceId(rig, C_LANE);
      const engineer = deviceId(rig, E_LANE);
      // 다른 기기의 offer: 새 연결이라 인증서가 다르다
      const sdp = await cp.evaluate(async () => {
        const pc = new RTCPeerConnection();
        pc.createDataChannel("draw");
        const o = await pc.createOffer();
        pc.close();
        return { type: o.type, sdp: o.sdp };
      });
      rig.hub.inject(C_LANE, "offer", { from: customer, to: engineer, sdp, pinned: true });
      await expect(ep.getByText("고객 쪽 기기가 바뀌었어요")).toBeVisible({ timeout: 10_000 });
      expect(logs).toEqual([]);
    } finally {
      dumpOnFail(rig, logs);
    }
  });
});
