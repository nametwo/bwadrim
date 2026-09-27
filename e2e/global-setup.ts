import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLIPS, ROOT, Y4M_DIR } from "./helpers";

// 가짜 카메라 영상(벤치 합성 y4m + 정답 JSON)이 없으면 만든다. 캐시 폴더라 git에 없다.
export default function globalSetup() {
  const missing = Object.values(CLIPS).filter(
    (n) => !fs.existsSync(path.join(Y4M_DIR, `${n}.y4m`)) || !fs.existsSync(path.join(Y4M_DIR, `${n}.json`)),
  );
  if (missing.length === 0) return;
  console.log(`[e2e] 가짜 카메라 영상 만드는 중 (${missing.join(", ")}) — 처음 한 번, 몇 분 걸려요`);
  execSync("npm run bench:tracking -- --y4m", { cwd: ROOT, stdio: "inherit", timeout: 20 * 60_000 });
  const still = missing.filter((n) => !fs.existsSync(path.join(Y4M_DIR, `${n}.y4m`)));
  if (still.length) throw new Error(`y4m 생성 실패: ${still.join(", ")}`);
}
