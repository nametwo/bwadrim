import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// 화면 카탈로그 (npm run screens): 모든 화면·상태를 찍어 screens/index.html 한 장으로 모은다.
// 서버·가짜 카메라·가짜 Supabase는 e2e(playwright.config.ts)와 같다. 시나리오는 e2e/screens/*.screens.ts
// 가짜 서버 상태(방·이벤트)를 시나리오마다 초기화하므로 한 번에 하나씩 돈다.
export default defineConfig({
  ...base,
  testMatch: /.*\.screens\.ts$/,
  outputDir: "test-results/screens",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["./e2e/screens/reporter.ts"]],
  // 한 단계가 막혀도 그 장면만 '못 찍은 상태'로 남기고 다음으로 넘어가게
  use: { ...base.use, actionTimeout: 15_000 },
});
