import { defineConfig } from "@playwright/test";
import screens from "./playwright.screens.config";

// README 움짤 (npm run readme:media): 화면 카탈로그와 같은 서버로 통화 장면을 녹화한다.
// 녹화: e2e/readme/*.media.ts → test-results/readme. 움짤 합치기: scripts/readme-media/make-gif.py → docs/media
export default defineConfig({
  ...screens,
  testMatch: /.*\.media\.ts$/,
  outputDir: "test-results/readme-run",
  reporter: [["list"]],
});
