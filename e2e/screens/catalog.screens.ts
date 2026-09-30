import { expect, test, type Page } from "@playwright/test";
import { CLIPS, FIXTURE, fakeCamera, mockReset } from "../helpers";
import { failGum, holdGum, releaseGum, removeCamera, setFlip, setPeerState } from "./browser-hooks";
import {
  EXPIRED,
  ROOM,
  UA,
  center,
  connect,
  cust,
  customerJoin,
  eng,
  engPc,
  engineerReady,
  finger,
  holdPosts,
  mock,
  open,
  padCenter,
  useRig,
  zoomPill,
  type Touch,
} from "./rig";
import { shot, unreachable, type ShotMeta } from "./shots";

// 화면 카탈로그 (npm run screens): 모든 화면·상태를 찍어 screens/index.html 한 장으로 모은다.
// e2e와 같은 가짜 Supabase·가짜 카메라·실제 WebRTC 루프백을 쓴다. 상태마다 요구사항 ID와 피그마 화면 번호를 붙인다.
// 버튼·상태는 되도록 data-testid와 역할(role)로 찾는다 — 문구·디자인이 바뀌어도 덜 깨지게.
// 새 화면·상태를 만들면 여기에 shot()을 하나 더한다. 못 가는 상태는 unreachable()로 이유를 남긴다.
// AR 핀처럼 다른 가짜 카메라 영상이 필요한 상태는 pin-*.screens.ts (영상은 파일마다 하나).

test.use({ launchOptions: fakeCamera(CLIPS.jitter) });

/** 확인 창이 뜬 직후(0.6초)의 탭은 일부러 무시하므로 조금 기다렸다 누른다 */
const ARM_MS = 700;
/** 종료 화면 변형에 쓰는 방 (ROOM-11) */
const [ROOM_B, ROOM_C, ROOM_D] = FIXTURE.rooms.slice(2);

// ---------- 대시보드·통계용 가짜 데이터 ----------

const catRoom = (n: number) => `e2e00000-0000-4000-8000-0000000c00${String(n).padStart(2, "0")}`;
const catToken = (n: number) => `e2e0${"c".repeat(26)}${String(n).padStart(2, "0")}`;

/** 대시보드·통계용 상담 목록: 상태마다 하나씩 */
async function seedDashboard() {
  const room = (n: number, r: Record<string, unknown>) => ({ id: catRoom(n), code: `CAT00${n}`, join_token: catToken(n), ...r });
  const ev = (n: number, name: string, props: Record<string, unknown> = {}) => ({ room_id: catRoom(n), actor: "customer", name, props });
  await mock("/__seed", {
    rooms: [
      room(1, { status: "waiting", ageMin: 3 }),
      room(2, { status: "active", ageMin: 25 }),
      room(3, { status: "ended", resolved_remotely: true, ageMin: 90, tookMin: 9 }),
      room(4, { status: "ended", resolved_remotely: false, ageMin: 5 * 60, tookMin: 21 }),
      room(5, { status: "ended", resolved_remotely: null, ageMin: 20 * 60, tookMin: 5 }),
      room(6, { status: "waiting", expired: true }),
      room(7, { status: "ended", resolved_remotely: true, ageMin: 3 * 24 * 60, tookMin: 7 }),
    ],
    events: [
      ev(1, "link_opened"),
      ...["link_opened", "camera_granted", "connected", "pointer_used"].map((e) => ev(2, e)),
      ...["link_opened", "camera_granted", "connected", "relay_used", "pointer_used", "freeze_used", "resolved_remotely"].map((e) => ev(3, e)),
      ev(3, "ended", { duration_sec: 540, resolved_remotely: true }),
      ...["link_opened", "camera_granted", "connected", "pointer_used", "guide_used"].map((e) => ev(4, e)),
      ev(4, "ended", { duration_sec: 1260, resolved_remotely: false }),
      ev(5, "link_opened"),
      ev(5, "camera_denied"),
      ev(5, "ended", { duration_sec: 300, resolved_remotely: null }),
      ev(6, "link_opened"),
      ev(6, "camera_granted"),
      ...["link_opened", "camera_granted", "connected", "freeze_used", "anchor_used", "photo_taken", "resolved_remotely"].map((e) => ev(7, e)),
      ev(7, "ended", { duration_sec: 420, resolved_remotely: true }),
    ],
  });
}

// ---------- 누르고 있는 동안만 보이는 상태 ----------

/** 이 자리를 누르고 있는 동안 찍고 뗀다 (방향 지시) */
function holdWhileShooting(meta: ShotMeta, ep: Page, cp: Page, at: () => Promise<{ x: number; y: number }>, cmd: string) {
  let f: Touch | undefined;
  return shot(
    meta,
    async () => {
      const p = await at();
      f = await finger(ep);
      await f.down(p.x, p.y);
      await expect(cp.getByTestId("guide-band")).toHaveAttribute("data-cmd", cmd, { timeout: 5_000 });
      await cp.waitForTimeout(400); // 화살표가 들어오는 움직임이 끝날 시간
      return [eng(ep), cust(cp)];
    },
    async () => {
      await f?.up();
      await expect(cp.getByTestId("guide-band")).toHaveCount(0, { timeout: 5_000 });
    },
  );
}

test.beforeEach(async () => {
  await mockReset();
});

// =====================================================================

test("첫 화면·로그인·404", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  await useRig(browser, baseURL, async (rig) => {
    const p = await rig.visitor();
    const pc = await rig.visitor(true);

    await shot({ section: "home", ids: ["AUTH-01", "AUTH-02", "AUTH-04"], title: "로그인", note: "사이트 주소(/)를 열어도, 로그인 안 하고 대시보드·세션·통계를 열어도 이 화면으로 온다" }, async () => {
      await open(p, "/");
      await expect(p).toHaveURL(/\/login$/);
      await open(pc, "/dashboard");
      await expect(pc).toHaveURL(/\/login\?next=%2Fdashboard/);
      return [{ label: "폰", page: p }, { label: "PC", page: pc }];
    });

    const release = await holdPosts(p, "/login");
    await shot({ section: "home", ids: ["AUTH-02"], title: "로그인 중…" }, async () => {
      await p.getByLabel("이메일").fill("engineer@example.com");
      await p.getByLabel("비밀번호", { exact: true }).fill("wrong-password");
      await p.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(p.getByRole("button", { name: /로그인 중/ })).toBeVisible();
      return [{ label: "폰", page: p }];
    });
    release();

    await shot({ section: "home", ids: ["AUTH-03"], title: "로그인 실패" }, async () => {
      await expect(p.getByText("이메일이나 비밀번호가 맞지 않아요.")).toBeVisible({ timeout: 20_000 });
      return [{ label: "폰", page: p }];
    });

    const kb = await rig.visitor();
    await shot(
      { section: "home", ids: ["AUTH-02"], title: "로그인 — 키보드가 올라와 화면이 낮을 때", note: "안드로이드 카톡 같은 앱 안 브라우저는 키보드만큼 화면이 줄어든다. 글을 치는 동안은 '로그인'이 입력칸 아래로 내려가 가리지 않는다(BUG-21)" },
      async () => {
        await open(kb, "/login");
        await kb.getByLabel("이메일").focus();
        await kb.setViewportSize({ width: 390, height: 360 });
        // 폰은 키보드가 올라오면 커서가 있는 입력칸이 보이게 스크롤한다
        await kb.evaluate(() => (document.activeElement as HTMLElement).scrollIntoView({ block: "nearest" }));
        return [{ label: "폰", page: kb, fullPage: false }];
      },
    );

    const kakao = await rig.visitor(false, UA.kakao);
    const naver = await rig.visitor(false, UA.naver);
    await shot(
      { section: "home", ids: ["AUTH-09"], title: "엔지니어 — 앱 안 브라우저 안내", note: "카카오톡·라인은 자동으로 인터넷 앱으로 넘긴다(여기선 넘어갈 앱이 없어 안내가 남음). 네이버·인스타그램 등은 메뉴에서 직접 열도록 그림으로 안내. 로그인·대시보드·상담·통계 모두 같다" },
      async () => {
        await open(kakao, "/").catch(() => {});
        await expect(kakao.getByTestId("eng-in-app")).toBeVisible();
        await open(naver, "/login");
        await expect(naver.getByRole("button", { name: /링크 복사하기/ })).toBeVisible();
        return [{ label: "카카오톡", page: kakao }, { label: "네이버 앱", page: naver }];
      },
    );

    const ep = await rig.engineer();
    await shot({ section: "home", ids: ["AUTH-08"], title: "없는 주소·남의 상담 (404)" }, async () => {
      await open(ep, "/room/e2e00000-0000-4000-8000-00000000ffff");
      await expect(ep.getByText("페이지를 찾을 수 없어요")).toBeVisible({ timeout: 30_000 });
      return [eng(ep)];
    });
  });
});

test("대시보드·통계", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const epc = await rig.engineer({ pc: true });

    await mock("/__seed", { rooms: [], events: [] });
    await shot({ section: "dashboard", ids: ["ROOM-04", "AUTH-01"], title: "대시보드 — 상담 없음 (E02)", note: "로그인한 채로 사이트 주소(/)를 열면 여기로 온다" }, async () => {
      await open(ep, "/");
      await expect(ep).toHaveURL(/\/dashboard$/);
      await expect(ep.getByText("아직 상담이 없어요")).toBeVisible({ timeout: 30_000 });
      return [eng(ep)];
    });
    await shot({ section: "dashboard", ids: ["DATA-06"], title: "통계 — 상담 없음" }, async () => {
      await open(ep, "/stats");
      await expect(ep.getByRole("navigation", { name: "기간" })).toBeVisible({ timeout: 30_000 });
      return [eng(ep)];
    });

    await seedDashboard();
    await shot(
      { section: "dashboard", ids: ["ROOM-04", "ROOM-03"], title: "대시보드 — 상태별 상담 (E02)", note: "진행 중(기다리는 중·결과 기록 전) · 원격 해결 · 방문 필요 · 연결 안 됨 · 만료" },
      async () => {
        await open(ep, "/dashboard");
        await open(epc, "/dashboard");
        await expect(ep.getByText("만료")).toBeVisible();
        return [eng(ep), engPc(epc)];
      },
    );
    await shot({ section: "dashboard", ids: ["DATA-06"], title: "통계 — 30일" }, async () => {
      await open(ep, "/stats");
      await open(epc, "/stats");
      await expect(ep.getByText("원격 해결률").first()).toBeVisible({ timeout: 30_000 });
      return [eng(ep), engPc(epc)];
    });

    await open(ep, "/dashboard");
    const release = await holdPosts(ep, "/dashboard");
    await shot({ section: "dashboard", ids: ["ROOM-01"], title: "새 A/S 만드는 중…" }, async () => {
      await ep.getByRole("button", { name: /새 A\/S 시작/ }).click();
      await expect(ep.getByRole("button", { name: /만드는 중/ })).toBeVisible();
      return [eng(ep)];
    });
    release();
    await shot(
      { section: "dashboard", ids: ["ROOM-01"], title: "새 A/S 만들기 실패 (오류 화면)", note: "가짜 서버가 상담 만들기를 거부하게 해서 띄움. 개발 모드 오류 표시는 가림" },
      async () => {
        await expect(ep.getByText("잠깐 문제가 생겼어요")).toBeVisible({ timeout: 30_000 });
        return [eng(ep)];
      },
    );
  });
});

test("세션 화면 — 고객 부르기", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    const epc = await rig.engineer({ pc: true });

    await shot(
      { section: "room", ids: ["CALL-01"], title: "마이크부터 켜 주세요", note: "대시보드의 '새 A/S 시작'·'이어하기'로 오면 이 단계 없이 바로 링크 보내기" },
      async () => {
        await open(ep, `/room/${ROOM.id}`);
        await open(epc, `/room/${ROOM.id}`);
        await expect(ep.getByRole("button", { name: /연결 준비/ })).toBeVisible({ timeout: 30_000 });
        return [eng(ep), engPc(epc)];
      },
    );

    await shot({ section: "room", ids: ["ROOM-10"], title: "상담 닫기 확인 (연결된 적 없음)" }, async () => {
      await ep.getByRole("button", { name: "상담 닫기" }).click();
      await expect(ep.getByTestId("eng-close-sheet")).toBeVisible();
      await ep.waitForTimeout(300); // 아래에서 올라오는 움직임
      return [eng(ep)];
    });
    await ep.waitForTimeout(ARM_MS);
    await ep.getByTestId("eng-close-sheet").getByRole("button", { name: "취소" }).click();
    await expect(ep.getByTestId("eng-close-sheet")).toHaveCount(0);

    await holdGum(ep);
    await shot({ section: "room", ids: ["CALL-01"], title: "연결 준비 중…", note: "마이크 권한을 기다리는 동안" }, async () => {
      await ep.getByRole("button", { name: /연결 준비/ }).click();
      await expect(ep.getByRole("button", { name: /준비 중/ })).toBeVisible();
      return [eng(ep)];
    });
    await releaseGum(ep);

    await shot(
      {
        section: "room",
        ids: ["ROOM-05", "ROOM-06", "ROOM-07", "ROOM-08", "ROOM-14"],
        title: "고객님께 링크를 보내 주세요 (E03)",
        note: "폰: 파란 문자 + 카톡 보내기·공유하기·링크 복사 한 줄. PC는 문자 앱이 없어 문자를 숨기고, 이 PC 브라우저는 공유 기능도 없어 카톡 보내기·링크 복사만. 그래서 PC 카드는 '보낼 링크'",
      },
      async () => {
        await expect(ep.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "false", { timeout: 30_000 });
        // PC는 다른 상담으로 — 같은 상담이면 나중에 들어온 PC가 폰 통화를 이어받는다 (CALL-13)
        await engineerReady(epc, ROOM_C.id);
        await expect(epc.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "false");
        // 가짜 카카오 키 없이 뜬 서버를 다시 쓰면 다른 모양이 찍히므로 여기서 멈춘다 (playwright.screens.config.ts)
        for (const id of ["share-sms", "share-kakao", "share-sheet", "share-copy"]) await expect(ep.getByTestId(id)).toBeVisible();
        for (const id of ["share-kakao", "share-copy"]) await expect(epc.getByTestId(id)).toBeVisible();
        for (const id of ["share-sms", "share-sheet"]) await expect(epc.getByTestId(id)).toHaveCount(0);
        return [eng(ep), engPc(epc)];
      },
    );

    await shot(
      { section: "room", ids: ["ROOM-14", "ROOM-13"], title: "카톡 보내기 → 고객 기다리는 중 (PC)", note: "카카오 SDK는 가짜라 친구 선택 창은 뜨지 않는다" },
      async () => {
        await epc.getByTestId("share-kakao").click();
        await expect(epc.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "true");
        await expect(epc.getByTestId("eng-progress")).toContainText("카톡을 보냈어요");
        return [engPc(epc)];
      },
    );

    // 카카오 키는 빌드할 때 들어가서 한 번 띄운 서버로는 키가 없는 모양을 만들 수 없다 (playwright.screens.config.ts)
    const noKey = "카탈로그는 가짜 카카오 키로 띄워 '카톡 보내기'가 늘 있다. 키를 뺀 서버로 따로 띄워야 한다";
    await unreachable({ section: "room", ids: ["ROOM-05", "ROOM-07", "ROOM-08"], title: "카카오 키 없을 때 (폰: 문자 + 공유하기·링크 복사)" }, noKey);
    await unreachable(
      { section: "room", ids: ["ROOM-05", "ROOM-08"], title: "링크 복사만 있을 때 (공유 기능 없는 PC, 카카오 키 없음, 파란 큰 '링크 복사')" },
      noKey,
    );

    const kakaoFail = await rig.engineer({ kakao: "fail" });
    await shot(
      { section: "room", ids: ["ROOM-14"], title: "카카오톡을 열지 못했어요", note: "카카오 SDK를 못 받았을 때. 문자·공유하기·링크 복사로 보내면 된다" },
      async () => {
        await engineerReady(kakaoFail, ROOM_D.id);
        await kakaoFail.getByTestId("share-kakao").click();
        await expect(kakaoFail.getByTestId("share-kakao-fail")).toBeVisible();
        return [eng(kakaoFail)];
      },
    );
    await kakaoFail.close();

    await shot({ section: "room", ids: ["ROOM-13", "ROOM-08"], title: "링크 복사 → 고객이 링크 열기를 기다리는 중 (E04)" }, async () => {
      await ep.getByTestId("share-copy").click();
      await expect(ep.getByTestId("eng-waiting")).toHaveAttribute("data-sent", "true");
      await expect(ep.getByTestId("eng-progress")).toContainText("링크를 복사했어요");
      return [eng(ep)];
    });

    const cp = await rig.customer();
    await shot({ section: "room", ids: ["ROOM-13", "JOIN-02"], title: "고객이 링크를 열었어요", note: "엔지니어 화면은 3초마다 고객 진행 상황을 새로 읽는다" }, async () => {
      await open(cp, `/join/${ROOM.join_token}`);
      await expect(ep.getByTestId("eng-progress")).toContainText("고객님이 링크를 열었어요", { timeout: 15_000 });
      return [eng(ep), cust(cp)];
    });

    await shot({ section: "room", ids: ["ROOM-13", "JOIN-05"], title: "고객 카메라가 막혀 있어요", note: "고객이 권한 창에서 '허용 안 함'. 엔지니어 화면에 전화로 해 줄 말" }, async () => {
      await failGum(cp, { name: "NotAllowedError" });
      await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
      await expect(cp.getByTestId("cust-camera-help")).toBeVisible();
      await expect(ep.getByTestId("eng-wait-title")).toContainText("막혀", { timeout: 15_000 });
      return [eng(ep), cust(cp)];
    });

    rig.hub.drop.add("offer"); // 연결은 시작하되 신호가 오가지 않게 붙잡는다
    await shot({ section: "room", ids: ["ROOM-13", "CALL-03", "JOIN-06"], title: "곧 연결돼요 (신호 교환 전)" }, async () => {
      await failGum(cp, null);
      await cp.getByRole("button", { name: /다시 시도하기/ }).click();
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님과 연결하는 중…", { timeout: 30_000 });
      await expect(ep.getByTestId("eng-wait-title")).toContainText("곧 연결돼요", { timeout: 15_000 });
      return [eng(ep), cust(cp)];
    });

    const mic = await rig.engineer();
    await shot({ section: "room", ids: ["CALL-02"], title: "마이크 없이 보기만", note: "엔지니어가 마이크를 거부했거나 없음" }, async () => {
      await open(mic, `/room/${ROOM.id}`);
      await failGum(mic, { name: "NotAllowedError", audio: true });
      await mic.getByRole("button", { name: /연결 준비/ }).click();
      await expect(mic.getByText("마이크 꺼짐")).toBeVisible({ timeout: 30_000 });
      return [eng(mic)];
    });

    const turn = await rig.engineer({ turnWarning: true });
    await shot(
      { section: "room", ids: ["NET-03"], title: "중계 서버(TURN) 없이 연결 중 경고", note: "이 환경은 TURN 키가 없어서 실제로 뜨는 경고. 다른 장면은 가리고 찍었다" },
      async () => {
        await engineerReady(turn);
        await expect(turn.getByText("중계 서버 없이 연결하고 있어요")).toBeVisible();
        return [eng(turn)];
      },
    );

    await shot({ section: "room", ids: ["CALL-01", "CALL-05"], title: "다시 연결할까요? (연결된 적 있는 상담)" }, async () => {
      await mock("/__patch-room", { id: ROOM_B.id, status: "active" });
      await open(ep, `/room/${ROOM_B.id}`);
      await expect(ep.getByText("다시 연결할까요?")).toBeVisible({ timeout: 30_000 });
      return [eng(ep)];
    });

    // 끝난 상담 화면 (ROOM-11): 결과마다 제목이 다르다
    const now = new Date().toISOString();
    await mock("/__patch-room", { id: ROOM_B.id, status: "ended", resolved_remotely: true, ended_at: now });
    await mock("/__patch-room", { id: ROOM_C.id, status: "ended", resolved_remotely: false, ended_at: now });
    await mock("/__patch-room", { id: ROOM_D.id, status: "ended", resolved_remotely: null, ended_at: now });
    const done = [await rig.engineer(), await rig.engineer(), await rig.engineer()];
    await shot({ section: "room", ids: ["ROOM-11", "ROOM-03"], title: "끝난 상담 화면", note: "원격 해결 · 방문 필요 · 연결 없이 닫음 · 만료" }, async () => {
      await open(done[0], `/room/${ROOM_B.id}`);
      await open(done[1], `/room/${ROOM_C.id}`);
      await open(done[2], `/room/${ROOM_D.id}`);
      await open(ep, `/room/${EXPIRED.id}`);
      await expect(ep.getByText("만료된 상담이에요")).toBeVisible();
      return [
        { label: "원격 해결", page: done[0] },
        { label: "방문 필요", page: done[1] },
        { label: "연결 없이 닫음", page: done[2] },
        { label: "만료", page: ep },
      ];
    });
  });
});

test("고객 진입", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  await useRig(browser, baseURL, async (rig) => {
    const cp = await rig.customer();
    const ios = await rig.customer({ userAgent: UA.iphone });

    await shot({ section: "join", ids: ["JOIN-02", "JOIN-01", "AUTH-07"], title: "고객 시작 화면 (C01)", note: "제목 위에 누가 기다리는지(기사님 이름)" }, async () => {
      await open(cp, `/join/${ROOM.join_token}`);
      await expect(cp.getByRole("button", { name: /카메라 켜고 시작하기/ })).toBeVisible({ timeout: 30_000 });
      return [cust(cp)];
    });

    await open(ios, `/join/${ROOM.join_token}`);
    await holdGum(cp);
    await holdGum(ios);
    await shot({ section: "join", ids: ["JOIN-04"], title: "카메라 켜는 중 — '허용'을 눌러 주세요 (C02)", note: "권한 창이 뜨는 쪽을 가리킨다: 안드로이드는 아래, 아이폰은 가운데" }, async () => {
      await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
      await ios.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
      await expect(cp.getByText(/을 눌러 주세요/).last()).toBeVisible();
      await cp.waitForTimeout(800); // 0.4초 늦게 나타나 번지는 움직임
      return [cust(cp, "안드로이드"), cust(ios, "아이폰")];
    });
    await releaseGum(cp);
    await releaseGum(ios);

    await shot({ section: "join", ids: ["JOIN-06"], title: "기사님을 기다리는 중 (C03)", note: "고객이 먼저 들어온 경우. 카메라는 이미 켜졌다고 알린다" }, async () => {
      await expect(cp.getByTestId("cust-status")).toHaveText("기사님을 기다리는 중…", { timeout: 30_000 });
      await cp.waitForTimeout(500);
      return [cust(cp)];
    });
    await shot({ section: "join", ids: ["JOIN-06"], title: "오래 기다리는 중 (20초)", note: "기사님께 전화로 알리라고 안내" }, async () => {
      await expect(cp.getByText(/오래 걸리면/)).toBeVisible({ timeout: 30_000 });
      return [cust(cp)];
    });

    // 카메라를 켜지 못한 원인마다 다른 안내 (JOIN-05, C04)
    const failures: { title: string; fail: Parameters<typeof failGum>[1]; ua?: string; unsupported?: boolean; label?: string }[] = [
      { title: "카메라가 꺼져 있어요 — '허용 안 함'", fail: { name: "NotAllowedError" } },
      { title: "다른 앱이 카메라를 쓰는 중", fail: { name: "NotReadableError" } },
      { title: "카메라를 찾지 못함", fail: { name: "NotFoundError" } },
      { title: "카메라 기능이 없는 화면", fail: null, unsupported: true },
    ];
    for (const f of failures) {
      const a = await rig.customer();
      const b = f.fail?.name === "NotAllowedError" ? await rig.customer({ userAgent: UA.iphone }) : null;
      await shot({ section: "join", ids: ["JOIN-05"], title: `${f.title} (C04)`, note: b ? "켜는 방법이 폰마다 다르다" : undefined }, async () => {
        for (const p of [a, b]) {
          if (!p) continue;
          await open(p, `/join/${ROOM.join_token}`);
          if (f.unsupported) await removeCamera(p);
          else await failGum(p, f.fail);
          await p.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
          await expect(p.getByTestId("cust-camera-help")).toBeVisible();
        }
        return b ? [cust(a, "안드로이드"), cust(b, "아이폰")] : [cust(a)];
      });
    }

    const bad = await rig.customer();
    await shot({ section: "join", ids: ["JOIN-03", "ROOM-12"], title: "열 수 없는 링크", note: "없는 토큰·예전 6자리 링크" }, async () => {
      await open(bad, "/join/ABC123");
      await expect(bad.getByText("열 수 없는 링크예요")).toBeVisible({ timeout: 30_000 });
      return [cust(bad)];
    });
    await shot(
      { section: "join", ids: ["JOIN-03", "CALL-12"], title: "상담이 이미 끝났어요 (C06)", note: "링크를 연 뒤 상담이 닫혀 카메라를 켤 때, 채널이 입장을 거부할 때도 같은 화면" },
      async () => {
        await mock("/__patch-room", { id: ROOM_B.id, status: "ended" });
        await open(bad, `/join/${ROOM_B.join_token}`);
        await expect(bad.getByText("상담이 이미 끝났어요")).toBeVisible();
        return [cust(bad)];
      },
    );
    await shot({ section: "join", ids: ["JOIN-03", "ROOM-03"], title: "링크가 만료됐어요" }, async () => {
      await open(bad, `/join/${EXPIRED.join_token}`);
      await expect(bad.getByText("링크가 만료됐어요")).toBeVisible();
      return [cust(bad)];
    });
    await shot({ section: "join", ids: ["JOIN-03"], title: "서버 오류 — 잠깐 연결이 안 돼요", note: "가짜 서버가 상담 조회에 실패하게 해서 띄움" }, async () => {
      await mock("/__faults", { failJoinToken: ROOM.join_token });
      await open(bad, `/join/${ROOM.join_token}`);
      await expect(bad.getByText("잠깐 연결이 안 돼요")).toBeVisible();
      await mock("/__faults", { failJoinToken: null });
      return [cust(bad)];
    });

    const kakao = await rig.customer({ userAgent: UA.kakao });
    const naver = await rig.customer({ userAgent: UA.naver });
    await shot(
      { section: "join", ids: ["JOIN-10"], title: "앱 안 브라우저 안내", note: "카카오톡·라인은 자동으로 인터넷 앱으로 넘긴다(여기선 넘어갈 앱이 없어 안내가 남음). 네이버·인스타그램 등은 메뉴에서 직접 열도록 그림으로 안내" },
      async () => {
        await open(kakao, `/join/${ROOM.join_token}`).catch(() => {});
        await open(naver, `/join/${ROOM.join_token}`);
        await expect(naver.getByRole("button", { name: /링크 복사하기/ })).toBeVisible();
        return [cust(kakao, "카카오톡"), cust(naver, "네이버 앱")];
      },
    );
  });
});

test("통화 연결 중 (영상 오기 전)", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  // answer를 버리면 엔지니어는 영상 자리에서 '연결하는 중', 고객도 '연결하는 중'에 머문다
  await useRig(browser, baseURL, async (rig) => {
    rig.hub.drop.add("answer");
    const ep = await rig.engineer();
    const cp = await rig.customer();
    await shot({ section: "call", ids: ["CALL-04", "JOIN-06"], title: "연결하는 중 (영상 오기 전)" }, async () => {
      await engineerReady(ep);
      await customerJoin(cp);
      await expect(ep.getByTestId("eng-call-status")).toContainText("연결 중", { timeout: 30_000 });
      await cp.waitForTimeout(500);
      return [eng(ep), cust(cp)];
    });
  });
});

test("통화 중 — 도구·카메라·사진·끝내기", async ({ browser, baseURL }) => {
  test.setTimeout(360_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp } = await connect(rig);

    await shot({ section: "call", ids: ["CALL-04", "JOIN-06", "CALL-03"], title: "연결 직후 (E05·C07)", note: "고객 화면에 '기사님과 연결됐어요'가 잠깐. 엔지니어 화면엔 처음 한 번 제스처 안내" }, async () => [
      eng(ep),
      cust(cp),
    ]);
    await cp.waitForTimeout(2600);
    await shot(
      { section: "call", ids: ["CALL-04", "JOIN-06"], title: "통화 중", note: "고객 폰에 손전등이 있는 척(가짜 카메라)해서 '손전등'이 켜져 있다" },
      async () => {
        await expect(ep.getByTestId("eng-call-status")).toContainText("통화 중");
        return [eng(ep), cust(cp)];
      },
    );

    const v = await center(ep, "eng-video");

    await shot({ section: "tools", ids: ["CALL-08"], title: "레이저 포인터 (톡)" }, async () => {
      await ep.touchscreen.tap(v.x, v.y - v.h * 0.15);
      await expect(cp.getByTestId("pointer-marker")).toBeVisible({ timeout: 5_000 });
      return [eng(ep), cust(cp)];
    });
    await ep.waitForTimeout(3500);

    let held: Touch | undefined;
    await shot(
      { section: "tools", ids: ["CALL-14"], title: "꾹 누르는 중 (흰 원이 차오름)", note: "0.5초가 차면 핀이 꽂힌다" },
      async () => {
        held = await finger(ep);
        await held.down(v.x, v.y);
        await ep.waitForTimeout(200);
        return [{ label: "엔지니어 폰", page: ep, fullPage: false }];
      },
      async () => {
        await ep.waitForTimeout(700);
        await held?.up();
      },
    );

    await shot({ section: "tools", ids: ["CALL-14"], title: "AR 핀 (꾹)" }, async () => {
      await expect(ep.getByText("고객 화면에 표시 중")).toBeVisible({ timeout: 20_000 });
      await expect(cp.getByTestId("cust-status")).toHaveText("빨간 동그라미를 봐 주세요", { timeout: 20_000 });
      return [eng(ep), cust(cp)];
    });

    await holdWhileShooting(
      { section: "tools", ids: ["CALL-15", "CALL-14"], title: "방향 지시 중엔 AR 핀·안내 숨김" },
      ep,
      cp,
      async () => {
        const p = await padCenter(ep);
        return { x: p.x + 70, y: p.y };
      },
      "right",
    );
    await ep.getByRole("button", { name: "핀 지우기" }).click().catch(() => {});

    const ring = [
      { cmd: "right", dx: 70, dy: 0, name: "오른쪽" },
      { cmd: "left", dx: -70, dy: 0, name: "왼쪽" },
      { cmd: "up", dx: 0, dy: -70, name: "위" },
      { cmd: "down", dx: 0, dy: 70, name: "아래" },
    ];
    for (const d of ring) {
      await holdWhileShooting(
        { section: "tools", ids: ["CALL-15"], title: `방향 지시 — ${d.name} (E06)`, note: "방향 링을 누르고 있는 동안만 고객 화면에 노란 원 화살표" },
        ep,
        cp,
        async () => {
          const p = await padCenter(ep);
          return { x: p.x + d.dx, y: p.y + d.dy };
        },
        d.cmd,
      );
    }
    for (const z of ["closer", "farther"] as const) {
      await holdWhileShooting(
        { section: "tools", ids: ["CALL-15"], title: `방향 지시 — ${z === "closer" ? "가까이" : "멀리"}`, note: "링 아래 알약: 오른쪽 반 가까이, 왼쪽 반 멀리" },
        ep,
        cp,
        async () => (await zoomPill(ep))[z],
        z,
      );
    }

    await shot({ section: "tools", ids: ["CALL-15"], title: "방향 링 쓰는 법 (가운데를 톡)" }, async () => {
      const p = await padCenter(ep);
      const f = await finger(ep);
      await f.down(p.x, p.y);
      await f.up();
      await expect(ep.getByTestId("eng-guide-pill").filter({ visible: true })).toContainText("방향을 누르고 있는 동안만", { timeout: 3_000 });
      return [eng(ep)];
    });

    await shot({ section: "tools", ids: ["CALL-09", "CALL-15"], title: "화면 멈춤 (E08·C09)", note: "멈춘 동안 방향 링 자리에 '라이브로'" }, async () => {
      await ep.getByRole("button", { name: "멈추고 그리기" }).click();
      await expect(cp.getByTestId("cust-status")).toHaveText("화면을 멈추고 설명하고 있어요", { timeout: 10_000 });
      await cp.waitForTimeout(500);
      return [eng(ep), cust(cp)];
    });

    await shot({ section: "tools", ids: ["CALL-09"], title: "멈춘 화면에 그리기" }, async () => {
      const s = await center(ep, "eng-stage");
      const f = await finger(ep);
      const pts = Array.from({ length: 16 }, (_, i) => ({
        x: s.x - s.w * 0.3 + (s.w * 0.6 * i) / 15,
        y: s.y + Math.sin(i / 2.5) * s.h * 0.12,
      }));
      await f.down(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) {
        await f.move(p.x, p.y);
        await ep.waitForTimeout(20);
      }
      await f.up();
      await expect(ep.getByRole("button", { name: "되돌리기" })).toBeEnabled();
      await cp.waitForTimeout(800);
      return [eng(ep), cust(cp)];
    });
    await ep.getByRole("button", { name: "라이브로" }).click().catch(() => {});
    await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 10_000 }).catch(() => {});

    await shot({ section: "tools", ids: ["CALL-16"], title: "사진 찍기", note: "고객 폰이 자기 카메라로 원본을 찍어 보낸다. 몰래 찍히지 않게 고객 화면에 알림" }, async () => {
      await ep.getByTestId("eng-photo").click();
      await expect(cp.getByText("기사님이 사진을 찍었어요")).toBeVisible({ timeout: 10_000 });
      await expect(ep.getByTestId("eng-photo-count")).toHaveText("1", { timeout: 15_000 });
      return [eng(ep), cust(cp)];
    });
    await expect(ep.getByTestId("eng-photo")).toBeEnabled();
    await ep.getByTestId("eng-photo").click();
    await expect(ep.getByTestId("eng-photo-count")).toHaveText("2", { timeout: 15_000 }).catch(() => {});
    await cp.waitForTimeout(2600);

    await shot({ section: "end", ids: ["CALL-07", "JOIN-06"], title: "연결이 잠깐 끊김 (E09·C10)", note: "브라우저가 '끊김'으로 판정한 척. 다시 붙으면 사라진다" }, async () => {
      await setPeerState(ep, "disconnected");
      await setPeerState(cp, "disconnected");
      await expect(ep.getByText("연결이 불안정해요")).toBeVisible({ timeout: 5_000 });
      await expect(cp.getByText("연결이 잠깐 끊겼어요")).toBeVisible({ timeout: 5_000 });
      return [eng(ep), cust(cp)];
    });
    await setPeerState(ep, "connected");
    await setPeerState(cp, "connected");

    await shot({ section: "camera", ids: ["CALL-10", "JOIN-07"], title: "고객 카메라 원격 전환" }, async () => {
      await ep.getByRole("button", { name: "카메라 바꾸기" }).click();
      await expect(cp.getByText("기사님이 앞 카메라로 바꿨어요")).toBeVisible({ timeout: 10_000 });
      return [eng(ep), cust(cp)];
    });
    await cp.waitForTimeout(2600);

    await shot({ section: "camera", ids: ["CALL-11"], title: "고객 손전등 켜기", note: "켜지면 버튼이 노랗게 '손전등 끄기'" }, async () => {
      await ep.getByRole("button", { name: "손전등", exact: true }).click();
      await expect(cp.getByText("기사님이 손전등을 켰어요")).toBeVisible({ timeout: 10_000 });
      await expect(ep.getByRole("button", { name: "손전등 끄기" })).toBeVisible();
      return [eng(ep), cust(cp)];
    });
    await cp.waitForTimeout(2600);

    await shot(
      { section: "camera", ids: ["CALL-10"], title: "원격 전환이 막힌 폰 — 고객이 눌러야 함", note: "폰이 탭 없이 카메라를 못 바꾸게 막은 척" },
      async () => {
        await setFlip(cp, { needsTap: true });
        await expect(ep.getByRole("button", { name: "카메라 바꾸기" })).toBeEnabled({ timeout: 8_000 });
        await ep.getByRole("button", { name: "카메라 바꾸기" }).click();
        await expect(cp.getByText("기사님이 카메라를 바꿔 달라고 하셨어요")).toBeVisible({ timeout: 10_000 });
        return [eng(ep), cust(cp)];
      },
    );
    await setFlip(cp, {});
    await cp.getByRole("button", { name: "닫기" }).click().catch(() => {});

    await shot({ section: "camera", ids: ["CALL-10"], title: "원격 전환 실패" }, async () => {
      await setFlip(cp, { fails: 2 });
      await expect(ep.getByRole("button", { name: "카메라 바꾸기" })).toBeEnabled({ timeout: 8_000 });
      await ep.getByRole("button", { name: "카메라 바꾸기" }).click();
      await expect(ep.getByText("고객 폰에서 바꾸지 못했어요")).toBeVisible({ timeout: 10_000 });
      return [eng(ep), cust(cp)];
    });

    await shot({ section: "end", ids: ["CALL-06", "ROOM-10"], title: "통화를 끝낼까요? (E10)", note: "창이 떠 있는 동안에도 통화는 이어진다" }, async () => {
      await ep.getByTestId("eng-end").click();
      await expect(ep.getByTestId("eng-end-sheet")).toBeVisible();
      await ep.waitForTimeout(300);
      return [eng(ep), cust(cp)];
    });
    await ep.waitForTimeout(ARM_MS);
    await ep.getByTestId("eng-end-sheet").getByRole("button", { name: "계속 통화하기" }).click().catch(() => {});

    await shot({ section: "end", ids: ["JOIN-08"], title: "고객 — 상담을 끝낼까요? (C18)" }, async () => {
      await cp.getByRole("button", { name: "통화 종료" }).click();
      await expect(cp.getByTestId("cust-end-sheet")).toBeVisible();
      await cp.waitForTimeout(300);
      return [eng(ep), cust(cp)];
    });
    await cp.waitForTimeout(ARM_MS);
    await cp.getByTestId("cust-end-sheet").getByRole("button", { name: "계속하기" }).click().catch(() => {});

    await shot(
      { section: "end", ids: ["CALL-06", "ROOM-10", "CALL-16"], title: "엔지니어가 끝냄 → 결과 기록 (E11·C19)", note: "통화 중 찍은 사진과 요약. 고르기 전에는 '기록하고 끝내기'가 잠겨 있다" },
      async () => {
        await ep.getByTestId("eng-end").click();
        await ep.waitForTimeout(ARM_MS);
        await ep.getByTestId("eng-end-sheet").getByRole("button", { name: "통화 끝내기" }).click();
        await expect(ep.getByTestId("eng-record")).toBeVisible();
        await expect(cp.getByTestId("cust-ended")).toBeVisible({ timeout: 10_000 });
        return [eng(ep), cust(cp)];
      },
    );

    await shot({ section: "end", ids: ["ROOM-10"], title: "결과를 고름" }, async () => {
      await ep.getByRole("radio", { name: /원격으로 해결/ }).click();
      await expect(ep.getByRole("button", { name: "기록하고 끝내기" })).toBeEnabled();
      return [eng(ep)];
    });

    await shot({ section: "end", ids: ["CALL-16", "ROOM-10"], title: "찍은 사진을 저장할까요?", note: "사진을 저장하지 않고 끝내려 하면 한 번 더 묻는다" }, async () => {
      await ep.getByRole("button", { name: "기록하고 끝내기" }).click();
      await expect(ep.getByTestId("eng-photo-sheet")).toBeVisible();
      await ep.waitForTimeout(300);
      return [eng(ep)];
    });

    await shot({ section: "end", ids: ["ROOM-10"], title: "결과 저장 실패", note: "가짜 서버가 저장을 거부하게 해서 띄움" }, async () => {
      await mock("/__faults", { failRoomUpdate: true });
      await ep.waitForTimeout(ARM_MS);
      await ep.getByTestId("eng-photo-sheet").getByRole("button", { name: "저장 안 하고 끝내기" }).click();
      await expect(ep.getByText("저장에 실패했어요. 다시 눌러 주세요.")).toBeVisible({ timeout: 20_000 });
      return [eng(ep)];
    });
  });
});

test("고객이 먼저 끝냄·고객이 나감·상담 닫기 실패", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp } = await connect(rig);
    await shot(
      { section: "end", ids: ["JOIN-08", "ROOM-10"], title: "고객이 끝냄 (E11·C19)", note: "고객이 잘못 눌렀으면 '다시 연결' 한 번으로 돌아온다" },
      async () => {
        await cp.getByRole("button", { name: "통화 종료" }).click();
        await cp.waitForTimeout(ARM_MS);
        await cp.getByTestId("cust-end-sheet").getByRole("button", { name: "끝내기", exact: true }).click();
        await expect(cp.getByTestId("cust-ended")).toBeVisible();
        await expect(ep.getByTestId("eng-record")).toContainText("고객님이 통화를 끝냈어요", { timeout: 10_000 });
        return [eng(ep), cust(cp)];
      },
    );
  });

  await mockReset();
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp } = await connect(rig);
    await shot({ section: "end", ids: ["CALL-05", "CALL-07"], title: "고객이 창을 닫고 나감", note: "엔지니어는 기다리는 화면으로. 고객이 다시 들어오면 자동으로 이어진다" }, async () => {
      await cp.close();
      await expect(ep.getByTestId("eng-waiting")).toBeVisible({ timeout: 20_000 });
      return [eng(ep)];
    });
  });

  await mockReset();
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer();
    await shot({ section: "end", ids: ["ROOM-10"], title: "상담 닫기 실패", note: "연결 없이 닫다가 저장 실패 (가짜 서버가 거부)" }, async () => {
      await engineerReady(ep);
      await ep.getByRole("button", { name: "상담 닫기" }).click();
      await mock("/__faults", { failRoomUpdate: true });
      await ep.waitForTimeout(ARM_MS);
      await ep.getByTestId("eng-close-sheet").getByRole("button", { name: "닫기", exact: true }).click();
      await expect(ep.getByText("상담을 닫지 못했어요")).toBeVisible({ timeout: 20_000 });
      return [eng(ep)];
    });
  });
});

test("연결 실패·이어받기·권한 거부·마이크 없이 통화", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp } = await connect(rig);
    // 브라우저가 연결을 '완전 실패'로 판정한 척. 고객은 실패하면 채널에서 나가므로 엔지니어 쪽을 먼저 찍는다
    await shot({ section: "end", ids: ["CALL-07"], title: "연결 실패 (엔지니어)", note: "고객 쪽이 아직 채널에 남아 있을 때. 링크를 다시 보낼 수 있다" }, async () => {
      await setPeerState(ep, "failed");
      await expect(ep.getByTestId("eng-wait-title")).toContainText("연결에 실패했어요", { timeout: 10_000 });
      return [eng(ep)];
    });
    await shot({ section: "end", ids: ["JOIN-09", "CALL-07"], title: "연결 실패 (고객)" }, async () => {
      await setPeerState(cp, "failed");
      await expect(cp.getByTestId("cust-failed")).toBeVisible({ timeout: 10_000 });
      return [eng(ep), cust(cp)];
    });
  });

  await mockReset();
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp } = await connect(rig);
    const cp2 = await rig.customer();
    await shot(
      { section: "end", ids: ["JOIN-11", "CALL-13"], title: "고객이 다른 폰에서 이어받음", note: "엔지니어 화면엔 8초 동안 '고객 쪽 기기가 바뀌었어요'" },
      async () => {
        await customerJoin(cp2);
        await expect(cp.getByTestId("cust-replaced")).toBeVisible({ timeout: 20_000 });
        await expect(ep.getByText("고객 쪽 기기가 바뀌었어요")).toBeVisible({ timeout: 10_000 });
        await expect(cp2.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
        return [eng(ep), cust(cp, "먼저 쓰던 고객 폰"), cust(cp2, "새 고객 폰")];
      },
    );

    const ep2 = await rig.engineer({ pc: true });
    await shot({ section: "end", ids: ["CALL-13"], title: "엔지니어가 다른 기기(PC)에서 이어받음" }, async () => {
      await engineerReady(ep2);
      await expect(ep.getByText("다른 기기에서 이어받았어요")).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => ep2.getByTestId("eng-video").evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
      await ep2.waitForTimeout(500);
      return [{ label: "먼저 쓰던 엔지니어 폰", page: ep }, { label: "새 엔지니어 PC", page: ep2 }];
    });
  });

  await mockReset();
  await useRig(browser, baseURL, async (rig) => {
    rig.hub.denyTrack = (topic) => topic.endsWith(":e");
    const ep = await rig.engineer();
    await shot({ section: "end", ids: ["CALL-12"], title: "통화 권한 거부 (엔지니어)", note: "로그인이 풀렸거나 상담 주인이 아닐 때. 고객 쪽 거부는 '상담이 이미 끝났어요'" }, async () => {
      await open(ep, `/room/${ROOM.id}`);
      await ep.getByRole("button", { name: /연결 준비/ }).click({ timeout: 30_000 });
      await expect(ep.getByText("통화 권한을 확인하지 못했어요")).toBeVisible({ timeout: 20_000 });
      return [eng(ep)];
    });
  });

  await mockReset();
  await useRig(browser, baseURL, async (rig) => {
    const ep = await rig.engineer({ turnWarning: true });
    const cp = await rig.customer();
    await shot({ section: "call", ids: ["JOIN-06", "JOIN-04"], title: "고객 마이크를 못 쓰는 폰 — 기다리는 중", note: "전화 통화 중 등. 카메라만으로 연결한다" }, async () => {
      await open(cp, `/join/${ROOM.join_token}`);
      await failGum(cp, { name: "NotReadableError", audio: true });
      await cp.getByRole("button", { name: /카메라 켜고 시작하기/ }).click();
      await expect(cp.getByText(/마이크 없이 연결할게요/)).toBeVisible({ timeout: 30_000 });
      return [cust(cp)];
    });
    await shot(
      { section: "call", ids: ["CALL-02", "NET-03"], title: "마이크 없이 통화 + 중계 서버 경고", note: "엔지니어 마이크 거부 · 고객 마이크 못 씀 · 위쪽 ⚠를 눌러 연 TURN 경고" },
      async () => {
        await open(ep, `/room/${ROOM.id}`);
        await failGum(ep, { name: "NotAllowedError", audio: true });
        await ep.getByRole("button", { name: /연결 준비/ }).click();
        await expect(cp.getByTestId("cust-status")).toHaveText("기사님이 보고 있어요", { timeout: 30_000 });
        await expect(ep.getByText("고객님 마이크가 꺼져 있어요")).toBeVisible({ timeout: 10_000 });
        await ep.getByRole("button", { name: "연결 경고 보기" }).click();
        await expect(ep.getByText("중계 서버 없이 연결하고 있어요")).toBeVisible();
        await cp.waitForTimeout(2600);
        return [eng(ep), cust(cp)];
      },
    );
  });
});

test("엔지니어 PC 통화", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  await useRig(browser, baseURL, async (rig) => {
    const { ep, cp } = await connect(rig, { pc: true });
    await cp.waitForTimeout(2600);

    await shot({ section: "pc", ids: ["CALL-04"], title: "PC로 통화 (P01)", note: "오른쪽 패널에 방향 링과 키보드 안내" }, async () => [engPc(ep), cust(cp)]);

    await shot(
      { section: "pc", ids: ["CALL-15"], title: "PC 방향키로 방향 지시", note: "→ 키를 누르고 있는 동안" },
      async () => {
        await ep.keyboard.down("ArrowRight");
        await expect(cp.getByTestId("guide-band")).toHaveAttribute("data-cmd", "right", { timeout: 5_000 });
        await cp.waitForTimeout(400);
        return [engPc(ep), cust(cp)];
      },
      async () => {
        await ep.keyboard.up("ArrowRight");
        await expect(cp.getByTestId("guide-band")).toHaveCount(0, { timeout: 5_000 });
      },
    );

    await shot({ section: "pc", ids: ["CALL-09"], title: "PC 마우스로 멈추고 그리기" }, async () => {
      await ep.getByRole("button", { name: "멈추고 그리기" }).click();
      await expect(cp.getByTestId("cust-status")).toHaveText("화면을 멈추고 설명하고 있어요", { timeout: 10_000 });
      const s = await center(ep, "eng-stage");
      await ep.mouse.move(s.x - s.w * 0.25, s.y + s.h * 0.1);
      await ep.mouse.down();
      for (let i = 1; i <= 12; i++) await ep.mouse.move(s.x - s.w * 0.25 + (s.w * 0.5 * i) / 12, s.y + s.h * 0.1 - Math.sin(i / 2) * s.h * 0.15, { steps: 2 });
      await ep.mouse.up();
      await cp.waitForTimeout(800);
      return [engPc(ep), cust(cp)];
    });
  });
});

test("실험실", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await useRig(browser, baseURL, async (rig) => {
    const p = await rig.visitor();
    const pc = await rig.visitor(true);
    await shot(
      { section: "lab", ids: ["CALL-15"], title: "방향 지시 실험실 /lab/guide", note: "PC는 → 키를 누르고 있는 중" },
      async () => {
        await open(p, "/lab/guide");
        await open(pc, "/lab/guide");
        await expect(pc.getByRole("group", { name: /방향 링/ })).toBeVisible({ timeout: 30_000 });
        await pc.keyboard.down("ArrowRight");
        await expect(pc.getByTestId("guide-band")).toBeVisible({ timeout: 5_000 });
        await pc.waitForTimeout(400);
        return [{ label: "폰", page: p }, { label: "PC", page: pc }];
      },
      () => pc.keyboard.up("ArrowRight"),
    );
  });
});
