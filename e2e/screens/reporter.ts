import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { OUT_DIR, SECTIONS, type ShotRecord } from "./shots";

// 화면 카탈로그 리포터: 테스트가 첨부한 'screen' 기록을 모아 screens/index.html 한 장으로 만든다.

interface Broken {
  title: string;
  error: string;
}

export default class ScreensReporter implements Reporter {
  private shots: ShotRecord[] = [];
  private broken: Broken[] = [];

  onBegin() {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT_DIR, "img"), { recursive: true });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    for (const a of result.attachments) {
      if (a.name === "screen" && a.body) this.shots.push(JSON.parse(a.body.toString("utf8")));
    }
    if (result.status !== "passed" && result.status !== "skipped") {
      const error = (result.errors[0]?.message ?? result.status).replace(/\u001b\[[0-9;]*m/g, "");
      this.broken.push({ title: test.title, error: error.split("\n").slice(0, 4).join("\n") });
    }
  }

  onEnd() {
    const file = path.join(OUT_DIR, "index.html");
    fs.writeFileSync(file, renderHtml(this.shots, this.broken));
    const taken = this.shots.filter((s) => s.images).length;
    const missing = this.shots.length - taken;
    console.log(`\n화면 카탈로그: ${taken}개 상태${missing ? `, 못 찍은 상태 ${missing}개` : ""} → ${file}`);
  }

  printsToStdio() {
    return false;
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function gitLabel() {
  try {
    const rev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() ? " + 커밋 안 한 변경" : "";
    return `${rev}${dirty}`;
  } catch {
    return "";
  }
}

// 요구사항 ID 정렬: 영역 순서(문서 목차) → 번호
const AREA_ORDER = ["AUTH", "ROOM", "JOIN", "CALL", "NET", "DATA", "NFR", "OPS", "BUG"];
function idKey(id: string) {
  const [area, num] = id.split("-");
  const a = AREA_ORDER.indexOf(area);
  return (a < 0 ? 99 : a) * 1000 + Number(num);
}

function renderHtml(shots: ShotRecord[], broken: Broken[]) {
  const taken = shots.filter((s) => s.images);
  const missing = shots.filter((s) => !s.images);
  const ids = [...new Set(taken.flatMap((s) => s.ids))].sort((a, b) => idKey(a) - idKey(b));
  const sections = SECTIONS.map(([key, title]) => ({
    key,
    title,
    shots: taken.filter((s) => s.section === key),
  })).filter((s) => s.shots.length);
  const images = taken.reduce((n, s) => n + s.images!.length, 0);
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

  const card = (s: ShotRecord) => `
    <article class="card" data-ids="${esc(s.ids.join(" "))}">
      <header>
        <div class="ids">${s.ids.map((id) => `<button class="id" data-id="${esc(id)}">${esc(id)}</button>`).join("")}</div>
        <h3>${esc(s.title)}</h3>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
      </header>
      <div class="frames">
        ${s
          .images!.map(
            (im) => `
          <figure>
            <figcaption>${esc(im.label)}</figcaption>
            <a href="${esc(im.file)}" target="_blank"><img src="${esc(im.file)}" loading="lazy" style="width:calc(${im.width}px * var(--scale))" alt="${esc(`${s.title} — ${im.label}`)}"></a>
          </figure>`,
          )
          .join("")}
      </div>
    </article>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>봐드림 화면 카탈로그</title>
<style>
  :root { --scale: .6; --bg: #f4f4f5; --card: #fff; --text: #18181b; --muted: #71717a; --line: #e4e4e7; --accent: #18181b; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", sans-serif; }
  .top { border-bottom: 1px solid var(--line); padding: 12px 20px; display: flex; flex-direction: column; gap: 8px; }
  .bar { position: sticky; top: 0; z-index: 2; background: rgba(244,244,245,.94); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); padding: 8px 20px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  details .ids { margin-top: 6px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
  h1 { font-size: 18px; margin: 0; }
  .meta { color: var(--muted); font-size: 12px; }
  .seg button, .id { border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 12px; cursor: pointer; }
  .seg button[aria-pressed="true"], .id.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  nav a { color: var(--muted); text-decoration: none; font-size: 13px; }
  nav a:hover { color: var(--text); }
  main { padding: 8px 20px 60px; }
  h2 { font-size: 16px; margin: 28px 0 12px; scroll-margin-top: 56px; }
  h2 small { color: var(--muted); font-weight: normal; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; max-width: 100%; }
  .card header { max-width: 640px; margin-bottom: 8px; }
  .card h3 { font-size: 14px; margin: 4px 0 0; }
  .note { color: var(--muted); margin: 2px 0 0; font-size: 12px; }
  .ids { display: flex; flex-wrap: wrap; gap: 4px; }
  .frames { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  img { display: block; max-width: none; border: 1px solid var(--line); border-radius: 8px; background: #000; }
  .hidden { display: none !important; }
  table { border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  td, th { text-align: left; padding: 6px 10px; border-top: 1px solid var(--line); vertical-align: top; font-size: 13px; }
  th { background: #fafafa; border-top: 0; }
  pre { white-space: pre-wrap; margin: 0; font-size: 12px; }
  .empty { color: var(--muted); }
</style>
</head>
<body>
<div class="top">
  <div class="row">
    <h1>봐드림 화면 카탈로그</h1>
    <span class="meta">${esc(now)} · ${esc(gitLabel())} · 상태 ${taken.length}개 · 이미지 ${images}장${missing.length ? ` · 못 찍음 ${missing.length}개` : ""}</span>
  </div>
  <nav class="row">${sections.map((s) => `<a href="#${s.key}">${esc(s.title)} ${s.shots.length}</a>`).join("")}${missing.length ? `<a href="#missing">못 찍은 상태 ${missing.length}</a>` : ""}</nav>
  <details>
    <summary>요구사항 ID로 걸러 보기 (카드의 ID를 눌러도 된다)</summary>
    <div class="row ids" id="filter"><button class="id on" data-id="">전체</button>${ids.map((id) => `<button class="id" data-id="${esc(id)}">${esc(id)}</button>`).join("")}</div>
  </details>
</div>
<div class="bar row">
  <span class="seg" role="group" aria-label="크기">
    <button data-scale=".45">작게</button><button data-scale=".6" aria-pressed="true">보통</button><button data-scale="1">실제 크기</button>
  </span>
  <span class="meta" id="showing"></span>
</div>
<main>
${sections
  .map(
    (s) => `<section data-section>
  <h2 id="${s.key}">${esc(s.title)} <small>${s.shots.length}</small></h2>
  <div class="grid">${s.shots.map(card).join("")}</div>
</section>`,
  )
  .join("\n")}
${
  missing.length
    ? `<section id="missing-wrap">
  <h2 id="missing">못 찍은 상태 <small>${missing.length}</small></h2>
  <table><tr><th>ID</th><th>상태</th><th>이유</th></tr>
  ${missing.map((s) => `<tr><td>${esc(s.ids.join(", "))}</td><td>${esc(s.title)}</td><td>${esc(s.missing ?? "")}</td></tr>`).join("")}
  </table>
</section>`
    : ""
}
${
  broken.length
    ? `<section>
  <h2>중간에 멈춘 시나리오 <small>${broken.length}</small></h2>
  <table><tr><th>시나리오</th><th>오류</th></tr>
  ${broken.map((b) => `<tr><td>${esc(b.title)}</td><td><pre>${esc(b.error)}</pre></td></tr>`).join("")}
  </table>
</section>`
    : ""
}
${taken.length ? "" : `<p class="empty">찍은 화면이 없어요.</p>`}
</main>
<script>
  const root = document.documentElement;
  for (const b of document.querySelectorAll("[data-scale]")) {
    b.addEventListener("click", () => {
      root.style.setProperty("--scale", b.dataset.scale);
      for (const o of document.querySelectorAll("[data-scale]")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  function filter(id) {
    for (const c of document.querySelectorAll(".card")) c.classList.toggle("hidden", !!id && !c.dataset.ids.split(" ").includes(id));
    for (const s of document.querySelectorAll("[data-section]")) s.classList.toggle("hidden", !s.querySelector(".card:not(.hidden)"));
    for (const b of document.querySelectorAll(".id")) b.classList.toggle("on", b.dataset.id === id);
    document.getElementById("showing").innerHTML = id ? "<b>" + id + "</b>만 보는 중 · <a href='#' data-clear>전체 보기</a>" : "";
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".id");
    if (b) filter(b.dataset.id);
    if (e.target.closest("[data-clear]")) {
      e.preventDefault();
      filter("");
    }
  });
</script>
</body>
</html>
`;
}
