import fs from "node:fs";
import { test } from "@playwright/test";
import { fakeCamera, mockReset, y4mPath } from "../helpers";
import { pinStates, visible } from "./pin-states";
import { useRig } from "./rig";
import { unreachable, type ShotMeta } from "./shots";

// 화면 카탈로그 — AR 핀(CALL-14): 공유기 LAN 포트처럼 같은 무늬가 반복되는 영상.
// 엔지니어에게 '같은 무늬가 반복돼요' 안내, 고객에게 사진 카드가 나오는지 찍는다.
// 영상은 추적 벤치(npm run bench:tracking -- --y4m)가 만든다. 없으면 이유만 남긴다.

const CLIP = "repetitive_router-lan3_pan_480x640";

test.use({ launchOptions: fakeCamera(CLIP) });

test.beforeEach(async () => {
  await mockReset();
});

test("AR 핀 — 같은 무늬가 반복되는 영상", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const meta: ShotMeta = { section: "pin", ids: ["CALL-14"], title: "반복 무늬 — 엔지니어 안내 + 고객 사진 카드" };
  if (!fs.existsSync(y4mPath(CLIP))) {
    await unreachable(meta, `가짜 카메라 영상이 없음: npm run bench:tracking -- --y4m 으로 ${CLIP}.y4m을 만들 것`);
    return;
  }
  await useRig(browser, baseURL, (rig) =>
    pinStates(
      rig,
      [{ key: "toast", ...meta, seen: async (ep, cp) => (await ep.getByText(/무늬가/).isVisible()) || visible(cp, "cust-card") }],
      20_000,
    ),
  );
});
