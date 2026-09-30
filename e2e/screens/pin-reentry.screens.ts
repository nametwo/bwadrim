import { test } from "@playwright/test";
import { CLIPS, fakeCamera, mockReset } from "../helpers";
import { pinStates, visible } from "./pin-states";
import { useRig } from "./rig";

// 화면 카탈로그 — AR 핀(CALL-14): 가짜 카메라가 핀 자리를 화면 밖으로 뺐다가 돌아오는 영상.
// 화살표·사진 카드·놓침·찾는 중이 나오는 대로 찍는다.

test.use({ launchOptions: fakeCamera(CLIPS.reentry) });

test.beforeEach(async () => {
  await mockReset();
});

test("AR 핀 — 화면 밖으로 나갔다 돌아오는 영상", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  await useRig(browser, baseURL, (rig) =>
    pinStates(
      rig,
      [
        { key: "arrow", title: "핀이 화면 밖 — 화살표 안내", ids: ["CALL-14"], seen: (_, cp) => visible(cp, "cust-arrow-text") },
        { key: "card", title: "핀을 못 찾음 — 사진 카드 안내", ids: ["CALL-14"], seen: (_, cp) => visible(cp, "cust-card") },
        { key: "lost", title: "고객 화면에서 놓침 (엔지니어 표시)", ids: ["CALL-14"], seen: (ep) => ep.getByText("고객 화면에서 놓침").isVisible() },
        { key: "finding", title: "고객 화면에서 찾는 중 (엔지니어 표시)", ids: ["CALL-14"], seen: (ep) => ep.getByText("고객 화면에서 찾는 중…").isVisible() },
      ],
      25_000,
    ),
  );
});
