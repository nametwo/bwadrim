import { defineConfig } from "@playwright/test";
import fixture from "./e2e/fixtures.json";

// E2E (npm run e2e): Chromium + 가짜 카메라(벤치 y4m) + 가짜 Supabase. 진짜 Supabase·TURN은 필요 없다.
//  - webServer 1: e2e/mock-supabase.mjs (REST·Auth, 이벤트 기록)
//  - webServer 2: next dev -p 3104 (가짜 Supabase를 보도록 env 지정)
//    이미 떠 있는 서버를 쓰려면 E2E_BASE_URL=http://localhost:3104 (그 서버도 같은 env로 띄워야 한다)
//    주의: next dev는 디렉터리당 하나만 뜬다 — 이 저장소에서 다른 next dev가 돌고 있으면 먼저 끄거나 E2E_BASE_URL을 쓸 것
//  - globalSetup: 가짜 카메라 y4m이 없으면 npm run bench:tracking -- --y4m 으로 만든다 (처음 한 번, 몇 분)
const PORT = Number(process.env.E2E_PORT ?? 3104);
const SUPABASE_PORT = Number(process.env.E2E_SUPABASE_PORT ?? fixture.supabasePort);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 추적은 CPU를 많이 쓴다 — 브라우저 2개까지만 동시에
  workers: 2,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    trace: "retain-on-failure",
    permissions: ["camera", "microphone"],
  },
  webServer: [
    {
      command: "node e2e/mock-supabase.mjs",
      url: `http://127.0.0.1:${SUPABASE_PORT}/__health`,
      reuseExistingServer: true,
      env: { E2E_SUPABASE_PORT: String(SUPABASE_PORT) },
      stdout: "ignore",
    },
    ...(process.env.E2E_BASE_URL
      ? []
      : [
          {
            command: `npx next dev -p ${PORT}`,
            url: `${BASE_URL}/lab/track`,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
            env: {
              NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
              NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.anonKey,
              SUPABASE_SERVICE_ROLE_KEY: fixture.serviceKey,
              CLOUDFLARE_TURN_KEY_ID: "",
              CLOUDFLARE_TURN_API_TOKEN: "",
            },
          },
        ]),
  ],
});
