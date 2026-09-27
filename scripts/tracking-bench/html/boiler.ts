// (c) 보일러 실내 온도조절기: 7세그먼트 LCD(꺼진 세그먼트 잔상), 둥근 버튼, 한글 라벨
import { FONT_KO, FONT_SANS, noise, page, sevenSeg, text } from "./common";

export const BOILER_W = 1600;
export const BOILER_H = 1200;

function roundButton(lm: string, cx: number, cy: number, icon: string, labelText: string): string {
  const r = 78;
  return `<div class="abs" style="left:${cx - r - 10}px;top:${cy - r - 10}px;width:${2 * r + 20}px;height:${2 * r + 20}px;border-radius:50%;
background:linear-gradient(180deg,#cfcabd,#f6f3ec);box-shadow:inset 0 3px 6px rgba(0,0,0,.25)"></div>
<div class="abs" data-lm="${lm}" style="left:${cx - r}px;top:${cy - r}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;
background:radial-gradient(circle at 42% 30%,#ffffff 0%,#f4f2ec 45%,#dcd7cb 85%,#c7c1b3 100%);
box-shadow:0 6px 10px rgba(0,0,0,.35), 0 2px 2px rgba(0,0,0,.3), inset 0 -5px 8px rgba(0,0,0,.12)"></div>
<svg class="abs" style="left:${cx - 40}px;top:${cy - 40}px" width="80" height="80" viewBox="0 0 80 80">${icon}</svg>
<div class="abs ko" style="left:${cx - 110}px;top:${cy + r + 26}px;width:220px;text-align:center;font-size:36px;color:#3d3b37">${labelText}</div>`;
}

const ICON_POWER = `<path d="M40 12 V38" stroke="#d23a2a" stroke-width="8" stroke-linecap="round"/><path d="M24 22 A24 24 0 1 0 56 22" fill="none" stroke="#d23a2a" stroke-width="8" stroke-linecap="round"/>`;
const ICON_FLAME = `<path d="M40 8 C52 26 62 34 58 52 C55 66 46 72 40 72 C30 72 20 64 20 50 C20 38 30 34 32 22 C38 30 36 38 42 42 C46 34 44 22 40 8 Z" fill="#e25a1c"/><path d="M40 44 C46 52 48 58 44 64 C40 68 34 66 33 60 C32 54 38 52 40 44 Z" fill="#ffc44d"/>`;
const ICON_FAUCET = `<path d="M12 30 H44 C56 30 62 38 62 48 V54 H50 V48 C50 44 48 42 44 42 H12 Z" fill="#2a78c7"/><rect x="26" y="18" width="10" height="12" fill="#2a78c7"/><rect x="18" y="12" width="26" height="7" rx="3" fill="#2a78c7"/><path d="M56 60 C60 66 60 70 56 72 C52 70 52 66 56 60 Z" fill="#58a8f0"/>`;
const ICON_AWAY = `<path d="M16 40 L40 18 L64 40 V66 H16 Z" fill="none" stroke="#4d4a44" stroke-width="6" stroke-linejoin="round"/><path d="M34 66 V50 H46 V66" fill="none" stroke="#4d4a44" stroke-width="6"/>`;
const ICON_CLOCK = `<circle cx="40" cy="40" r="26" fill="none" stroke="#4d4a44" stroke-width="6"/><path d="M40 24 V41 L52 48" fill="none" stroke="#4d4a44" stroke-width="6" stroke-linecap="round"/>`;

export function boilerHtml(): string {
  let b = "";
  // 벽 + 본체 (아이보리)
  b += `<div class="abs" style="left:0;top:0;width:${BOILER_W}px;height:${BOILER_H}px;background:#d8d2c6"></div>`;
  b += `<div class="abs" style="left:6px;top:6px;width:${BOILER_W - 12}px;height:${BOILER_H - 12}px;border-radius:90px;
background:linear-gradient(170deg,#fbfaf6 0%,#f0ede4 40%,#e6e2d7 100%);
box-shadow:inset 0 8px 10px rgba(255,255,255,.9), inset 0 -14px 20px rgba(0,0,0,.14), inset -10px 0 16px rgba(0,0,0,.06)"></div>`;
  b += noise({ freq: 0.8, octaves: 2, seed: 31, opacity: 0.12, x: 6, y: 6, w: BOILER_W - 12, h: BOILER_H - 12, radius: 90, contrast: 1.3 });
  // 은색 테두리 선
  b += `<div class="abs" style="left:40px;top:40px;width:${BOILER_W - 80}px;height:${BOILER_H - 80}px;border-radius:64px;border:3px solid #c9c4b8;box-shadow:0 1px 0 #fff"></div>`;

  // 로고
  b += `<svg class="abs" data-lm="logo" style="left:110px;top:78px" width="60" height="70" viewBox="0 0 80 80">${ICON_FLAME}</svg>`;
  b += text(176, 84, "HEATON", 54, "#1d3a6b", FONT_SANS, "font-weight:bold;letter-spacing:2px");
  b += text(470, 102, "콘덴싱 온도조절기", 30, "#6c6a64", FONT_KO);
  b += text(1210, 100, "CTR-5900", 28, "#8a867d", FONT_SANS, "letter-spacing:2px");
  b += `<div class="abs" style="left:1420px;top:100px;width:20px;height:20px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#e3ffd9,#3ccf4a 45%,#15681f)"></div>`;
  b += text(1452, 98, "운전", 26, "#6c6a64", FONT_KO);

  // LCD 베젤 + 창
  b += `<div class="abs" style="left:190px;top:170px;width:1220px;height:480px;border-radius:30px;background:linear-gradient(180deg,#2d3033,#43474b);
box-shadow:0 3px 0 #fff, inset 0 4px 8px rgba(0,0,0,.7)"></div>`;
  b += `<div class="abs" style="left:222px;top:202px;width:1156px;height:416px;border-radius:14px;
background:linear-gradient(180deg,#d2e0da 0%,#c3d4cd 55%,#b7c9c1 100%);box-shadow:inset 0 0 26px rgba(0,0,0,.35)"></div>`;
  const seg = "#1b2226";
  b += text(270, 226, "현재온도", 34, seg, FONT_KO);
  b += `<div class="abs" data-lm="lcdTemp" style="left:280px;top:280px;width:560px;height:240px"></div>`;
  b += `<svg class="abs" style="left:0;top:0" width="${BOILER_W}" height="${BOILER_H}">${sevenSeg("23.5", 290, 285, 230, seg, 0.08)}</svg>`;
  b += text(840, 290, "°C", 70, seg, FONT_SANS, "font-weight:bold");
  // 희망 온도
  b += `<div class="abs" style="left:990px;top:232px;width:120px;height:46px;background:${seg};border-radius:6px"></div>`;
  b += text(1010, 237, "희망", 34, "#c9d9d2", FONT_KO);
  b += `<div class="abs" data-lm="lcdSet" style="left:1010px;top:300px;width:260px;height:150px"></div>`;
  b += `<svg class="abs" style="left:0;top:0" width="${BOILER_W}" height="${BOILER_H}">${sevenSeg("45", 1010, 305, 140, seg, 0.08)}</svg>`;
  b += text(1210, 310, "°C", 44, seg, FONT_SANS, "font-weight:bold");
  // 아이콘 줄 (일부 켜짐)
  const icons: [string, string, number][] = [
    [ICON_FLAME, "난방", 1],
    [ICON_FAUCET, "온수", 0.1],
    [ICON_CLOCK, "예약", 0.1],
    [ICON_AWAY, "외출", 0.1],
  ];
  icons.forEach(([ic, lab, op], i) => {
    const x = 300 + i * 190;
    b += `<svg class="abs" style="left:${x}px;top:530px;opacity:${op};filter:grayscale(1) brightness(.25)" width="56" height="56" viewBox="0 0 80 80">${ic}</svg>`;
    b += text(x + 60, 540, lab, 32, seg, FONT_KO, `opacity:${op === 1 ? 1 : 0.12}`);
  });
  b += text(1070, 540, "▶ 난방 운전중", 32, seg, FONT_KO);

  // 둥근 버튼 줄
  const by = 790;
  const bx = [250, 480, 710, 940, 1170];
  b += roundButton("btnPower", bx[0], by, ICON_POWER, "전원");
  b += roundButton("btnHeat", bx[1], by, ICON_FLAME, "난방");
  b += roundButton("btnWater", bx[2], by, ICON_FAUCET, "온수");
  b += roundButton("btnAway", bx[3], by, ICON_AWAY, "외출");
  b += roundButton("btnResv", bx[4], by, ICON_CLOCK, "예약");

  // ▲▼ 온도 버튼 (세로 알약)
  b += `<div class="abs" style="left:1330px;top:670px;width:170px;height:330px;border-radius:85px;background:linear-gradient(180deg,#cfcabd,#f6f3ec);box-shadow:inset 0 3px 6px rgba(0,0,0,.25)"></div>`;
  b += `<div class="abs" data-lm="btnUp" style="left:1342px;top:682px;width:146px;height:150px;border-radius:73px 73px 12px 12px;
background:radial-gradient(circle at 45% 30%,#fff,#efebe2 55%,#d6d0c3);box-shadow:0 5px 8px rgba(0,0,0,.3)"></div>`;
  b += `<div class="abs" data-lm="btnDown" style="left:1342px;top:838px;width:146px;height:150px;border-radius:12px 12px 73px 73px;
background:radial-gradient(circle at 45% 30%,#fff,#efebe2 55%,#d6d0c3);box-shadow:0 5px 8px rgba(0,0,0,.3)"></div>`;
  b += `<svg class="abs" style="left:1375px;top:715px" width="80" height="80"><path d="M40 16 L68 60 H12 Z" fill="#c2412f"/></svg>`;
  b += `<svg class="abs" style="left:1375px;top:878px" width="80" height="80"><path d="M40 64 L68 20 H12 Z" fill="#2c67b3"/></svg>`;
  b += text(1382, 1012, "온도", 34, "#3d3b37", FONT_KO);

  // 아래 안내문
  b += `<div class="abs" style="left:110px;top:1060px;width:1380px;height:2px;background:#d4cfc3"></div>`;
  b += text(120, 1080, "▲▼ 버튼으로 희망온도를 맞추세요 · 3초 누르면 잠금", 28, "#7b776e", FONT_KO);
  b += text(1150, 1082, "A/S 1588-0000", 28, "#7b776e", FONT_SANS);
  // 나사 캡
  b += `<div class="abs" style="left:790px;top:1128px;width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff,#d8d3c7 60%,#b3ad9f)"></div>`;
  b += noise({ freq: 0.01, octaves: 3, seed: 32, opacity: 0.1, w: BOILER_W, h: BOILER_H, blend: "soft-light" });
  return page(BOILER_W, BOILER_H, b);
}
