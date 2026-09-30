import type { Page } from "@playwright/test";
import { center, connect, cust, eng, longPress, type Rig } from "./rig";
import { shot, unreachable } from "./shots";

// AR 핀(CALL-14) 상태 중 추적 결과에 따라 나오는 것들: 핀을 꽂고 기다리다가 나오는 대로 찍는다.
// 가짜 카메라 영상이 바뀌어야 해서(브라우저 실행 옵션) 영상마다 파일을 나눴다 — pin-*.screens.ts

interface PinState {
  key: string;
  title: string;
  ids: string[];
  /** 지금 이 상태가 화면에 떠 있는지 */
  seen(ep: Page, cp: Page): Promise<boolean>;
}

/** 연결 → 영상 가운데를 길게 눌러 핀 → ms 동안 기다리며 나오는 상태마다 한 번씩 찍는다 */
export async function pinStates(rig: Rig, want: PinState[], ms: number) {
  const { ep, cp } = await connect(rig);
  await ep.waitForTimeout(1500); // 추적기가 첫 프레임을 받을 시간
  const v = await center(ep, "eng-video");
  await longPress(ep, v.x, v.y);
  const left = new Map(want.map((w) => [w.key, w]));
  const until = Date.now() + ms;
  while (left.size && Date.now() < until) {
    for (const w of [...left.values()]) {
      if (await w.seen(ep, cp).catch(() => false)) {
        await shot({ section: "pin", ids: w.ids, title: w.title }, async () => [eng(ep), cust(cp)]);
        left.delete(w.key);
      }
    }
    await ep.waitForTimeout(150);
  }
  if (!left.size) return;
  // 대신 무엇이 떠 있었는지 남긴다 (엔지니어 영상 위 상태칩 등)
  const onStage = ((await ep.getByTestId("eng-stage").innerText().catch(() => "")) || "없음").replace(/\s+/g, " ").trim();
  for (const w of left.values()) {
    await unreachable(
      { section: "pin", ids: w.ids, title: w.title },
      `${ms / 1000}초 안에 나오지 않음 — 가짜 카메라 영상에서 추적이 그렇게 흘러가지 않았다. 끝날 때 엔지니어 영상 위: ${onStage.slice(0, 80)}`,
    );
  }
}

export const visible = (p: Page, testId: string) => p.getByTestId(testId).isVisible();

