// 플레이 스토어 그래픽 만들기 (OPS-08): 화면 카탈로그(npm run screens) 캡처로
// 휴대전화 스크린샷(1080×1920)과 그래픽 이미지(1024×500)를 docs/play-store에 만든다.
// 쓰는 법: npm run screens  →  node scripts/play-store/make-assets.mjs
// 글꼴은 Pretendard(OFL)를 jsDelivr에서 받는다. 앱 화면 캡처는 가짜 카메라(카드 단말기 영상)라 실제 고객 정보가 없다.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SCREENS = path.join(ROOT, "screens");
const OUT = path.join(ROOT, "docs/play-store");
const BLUE = "#2456e6";
const FONT = "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/woff2";

// 카탈로그의 그림 설명(alt)은 '<장면 제목> — <화면 이름>'
const html = fs.readFileSync(path.join(SCREENS, "index.html"), "utf8");
const shots = [...html.matchAll(/<img src="([^"]+)"[^>]*alt="([^"]+)"/g)].map((m) => ({
  src: path.join(SCREENS, m[1]),
  alt: m[2].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
}));
function find(title, label) {
  const hit = shots.find((s) => s.alt.startsWith(title) && (!label || s.alt.includes(`— ${label}`)));
  if (!hit) {
    const near = shots.filter((s) => s.alt.includes(title.slice(0, 6))).map((s) => s.alt);
    throw new Error(`카탈로그에 없음: ${title} / ${label ?? ""}\n비슷한 것: ${near.join(" | ")}`);
  }
  return "data:image/jpeg;base64," + fs.readFileSync(hit.src).toString("base64");
}

// 스크린샷 순서 = 스토어에 보이는 순서. 제목은 두 줄까지, 화면 문구 규칙(해요체)을 따른다
const SCREENSHOTS = [
  { name: "01-pointer", lines: ["톡 누르면", "고객님 화면에 표시가 떠요"], phones: [["레이저 포인터 (톡)", "엔지니어"], ["레이저 포인터 (톡)", "고객"]] },
  // 링크를 보내는 화면(E03)은 카탈로그에서 링크 주소가 localhost라 쓰지 않는다. 보낸 뒤 진행 상황 화면을 쓴다
  { name: "02-send-link", lines: ["카톡으로 보내고", "고객님 진행을 바로 봐요"], phones: [["고객이 링크를 열었어요", "엔지니어 폰"]] },
  { name: "03-customer-start", lines: ["고객님은 앱 없이", "카메라만 켜면 돼요"], phones: [["고객 시작 화면 (C01)", "고객 폰"]] },
  { name: "04-guide", lines: ["어디로 비출지", "화살표로 알려 드려요"], phones: [["방향 지시 — 오른쪽 (E06)", "엔지니어 폰"], ["방향 지시 — 오른쪽 (E06)", "고객 폰"]] },
  { name: "05-draw", lines: ["화면을 멈추고", "그려서 보여 드려요"], phones: [["멈춘 화면에 그리기", "엔지니어"], ["멈춘 화면에 그리기", "고객"]] },
  { name: "06-ar-pin", lines: ["꾹 누른 자리에", "핀이 붙어 따라가요"], phones: [["AR 핀 (꾹)", "엔지니어"], ["AR 핀 (꾹)", "고객"]] },
  { name: "07-photo", lines: ["고객님 폰 카메라로", "사진을 찍어 받아요"], phones: [["사진 찍기", "엔지니어"]] },
  { name: "08-dashboard", lines: ["누구와 한 상담인지", "목록에 남아요"], phones: [["대시보드 — 받는 분 이름 (E02)", "엔지니어 폰"]] },
];

const css = `
@font-face{font-family:P;font-weight:700;src:url(${FONT}/Pretendard-Bold.woff2)}
@font-face{font-family:P;font-weight:800;src:url(${FONT}/Pretendard-ExtraBold.woff2)}
@font-face{font-family:P;font-weight:900;src:url(${FONT}/Pretendard-Black.woff2)}
*{box-sizing:border-box}body{margin:0;font-family:P,sans-serif}`;

// 모서리만 둥글게. 그래픽 이미지에는 기기 테두리를 넣지 않는다(플레이 규칙), 스크린샷에는 두 화면이 구분되게 얇은 테두리를 둔다.
// 통화 화면은 폰 화면 비율(390×844) 그대로. 한 장만 보이는 화면은 스크롤 길이까지 찍힌 캡처라 잘리지 않게 maxH 안에서 원래 비율로 줄인다
function phone(img, w, frame = true, maxH = 0) {
  const border = frame ? `border:${Math.round(w * 0.025)}px solid #0d1220;` : "";
  const box = `border-radius:${Math.round(w * 0.08)}px;overflow:hidden;background:#000;box-shadow:0 24px 60px rgba(10,30,90,.35);${border}`;
  if (maxH) return `<div style="${box}"><img src="${img}" style="display:block;max-width:${w}px;max-height:${maxH}px"></div>`;
  return `<div style="width:${w}px;height:${Math.round((w * 844) / 390)}px;${box}"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top;display:block"></div>`;
}

function screenshotHtml(s) {
  const imgs = s.phones.map(([t, l]) => find(t, l));
  const w = imgs.length === 1 ? 640 : 470;
  const tilt = imgs.length === 2;
  return `<html><head><style>${css}</style></head><body>
<div style="width:1080px;height:1920px;background:${BLUE};position:relative;overflow:hidden">
  <div style="position:absolute;top:150px;left:0;right:0;text-align:center;color:#fff;font-weight:900;font-size:84px;line-height:1.22;letter-spacing:-2px">${s.lines.join("<br>")}</div>
  <div style="position:absolute;top:470px;left:0;right:0;display:flex;justify-content:center;align-items:flex-start;gap:36px">
    ${imgs.map((im, i) => `<div style="${tilt ? `margin-top:${i ? 90 : 0}px` : ""}">${tilt ? phone(im, w) : phone(im, w, true, 1380)}</div>`).join("")}
  </div>
</div></body></html>`;
}

function featureHtml() {
  const eng = find("AR 핀 (꾹)", "고객");
  const mark = fs.readFileSync(path.join(ROOT, "src/app/icon.svg"), "utf8");
  // 로고는 파란 바탕 위라 흰 네모·파란 글자로 뒤집는다(카톡 카드 사진과 같은 모양)
  const inverted = mark.replace('fill="#2456e6"/>', 'fill="#fff"/>').replace(/fill="#fff" stroke="#fff"/, `fill="${BLUE}" stroke="${BLUE}"`);
  return `<html><head><style>${css}</style></head><body>
<div style="width:1024px;height:500px;background:${BLUE};position:relative;overflow:hidden;color:#fff">
  <div style="position:absolute;left:72px;top:78px;display:flex;align-items:center;gap:18px">
    <div style="width:64px;height:64px">${inverted.replace("<svg ", '<svg width="64" height="64" ')}</div>
    <span style="font-weight:800;font-size:44px;letter-spacing:-1px">봐드림</span>
  </div>
  <div style="position:absolute;left:72px;top:190px;font-weight:900;font-size:70px;line-height:1.18;letter-spacing:-2px">출장 가기 전에<br>먼저 봐 드려요</div>
  <div style="position:absolute;left:72px;top:380px;font-weight:700;font-size:28px;color:#dbe4ff">링크 하나로 고객님 폰 카메라를 함께 봐요</div>
  <div style="position:absolute;right:70px;top:46px;transform:rotate(4deg)">${phone(eng, 300, false)}</div>
</div></body></html>`;
}

const browser = await chromium.launch();
async function render(htmlStr, w, h, out) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(htmlStr, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  console.log("만듦", path.relative(ROOT, out));
}
try {
  fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });
  for (const s of SCREENSHOTS) await render(screenshotHtml(s), 1080, 1920, path.join(OUT, "screenshots", `${s.name}.png`));
  await render(featureHtml(), 1024, 500, path.join(OUT, "feature-graphic.png"));
} finally {
  await browser.close();
}
