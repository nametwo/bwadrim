import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import fixture from "./e2e/fixtures.json";

// 화면 카탈로그 (npm run screens): 모든 화면·상태를 찍어 screens/index.html 한 장으로 모은다.
// 서버·가짜 카메라·가짜 Supabase는 e2e(playwright.config.ts)와 같다. 시나리오는 e2e/screens/*.screens.ts
// 가짜 서버 상태(방·이벤트)를 시나리오마다 초기화하므로 한 번에 하나씩 돈다.
// '카톡 보내기'(ROOM-14)가 보이게 가짜 카카오 키로 띄운다. SDK는 rig.ts가 가짜로 바꿔 내려 준다.
// 카톡 공유 웹훅용 가짜 어드민 키(KAKAO_ADMIN_KEY)도 e2e와 같은 값으로 넣는다 — 받는 분 이름표(ROOM-16) 장면이
// 가짜 SDK에 실린 서명(serverCallbackArgs)을 그대로 실어 카카오인 척 웹훅을 보낸다.
// 이미 떠 있는 개발 서버를 다시 쓰면(reuseExistingServer) 이 키가 없어 링크 보내기·카톡·받는 분 장면이 못 찍은 상태로 남는다
const webServer = (Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : []).map((s) =>
  s.command.includes("next dev")
    ? { ...s, env: { ...s.env, NEXT_PUBLIC_KAKAO_JS_KEY: "catalog-fake-key", KAKAO_ADMIN_KEY: fixture.kakaoAdminKey } }
    : s,
);

export default defineConfig({
  ...base,
  webServer,
  testMatch: /.*\.screens\.ts$/,
  outputDir: "test-results/screens",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["./e2e/screens/reporter.ts"]],
  // 한 단계가 막혀도 그 장면만 '못 찍은 상태'로 남기고 다음으로 넘어가게
  use: { ...base.use, actionTimeout: 15_000 },
});
