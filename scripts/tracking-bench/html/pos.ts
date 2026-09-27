// (a) 카드 결제 단말기 윗면: LCD, 숫자 키패드, 기능키, 로고, NFC, 스티커, IC 슬롯
import { FONT_KO, FONT_MONO, FONT_SANS, Rng, barcode, noise, page, text } from "./common";

export const POS_W = 1600;
export const POS_H = 1200;

function key(
  lm: string,
  x: number,
  y: number,
  w: number,
  h: number,
  main: string,
  sub: string,
  opt: { bg?: string; fg?: string; size?: number; font?: string; subColor?: string } = {},
): string {
  const bg = opt.bg ?? "linear-gradient(180deg,#f1f2f3 0%,#dcdee0 55%,#c3c6c9 100%)";
  const fg = opt.fg ?? "#1d1f22";
  return `<div class="abs" data-lm="${lm}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:22px;background:${bg};
box-shadow:0 7px 0 #1a1b1d, 0 10px 14px rgba(0,0,0,.55), inset 0 2px 1px rgba(255,255,255,.75), inset 0 -4px 6px rgba(0,0,0,.18);
display:flex;flex-direction:column;align-items:center;justify-content:center;color:${fg}">
<div style="font-family:${opt.font ?? FONT_SANS};font-weight:bold;font-size:${opt.size ?? 64}px;line-height:1">${main}</div>
${sub ? `<div style="font-family:${FONT_SANS};font-size:21px;letter-spacing:3px;margin-top:6px;color:${opt.subColor ?? "#50545a"}">${sub}</div>` : ""}
</div>`;
}

export function posHtml(): string {
  const rng = new Rng(1001);
  let b = "";
  // 본체 (어두운 그라파이트 플라스틱) — 모서리 밖은 책상 그림자
  b += `<div class="abs" style="left:0;top:0;width:${POS_W}px;height:${POS_H}px;background:#2b2621"></div>`;
  b += `<div class="abs" style="left:4px;top:4px;width:${POS_W - 8}px;height:${POS_H - 8}px;border-radius:70px;
background:linear-gradient(175deg,#4a4d52 0%,#35383c 30%,#2d3034 70%,#26282b 100%);
box-shadow:inset 0 6px 8px rgba(255,255,255,.25), inset 0 -10px 16px rgba(0,0,0,.6), inset 8px 0 10px rgba(255,255,255,.06)"></div>`;
  b += noise({ freq: 0.85, octaves: 2, seed: 11, opacity: 0.22, w: POS_W, h: POS_H, radius: 70, contrast: 1.6 });
  b += noise({ freq: 0.012, octaves: 3, seed: 12, opacity: 0.18, w: POS_W, h: POS_H, radius: 70, blend: "soft-light" });

  // LCD 창
  b += `<div class="abs" style="left:80px;top:80px;width:850px;height:400px;border-radius:26px;background:linear-gradient(160deg,#151617,#050505 60%,#1d1e20);
box-shadow:inset 0 3px 3px rgba(255,255,255,.18), 0 2px 0 rgba(255,255,255,.12)"></div>`;
  b += `<div class="abs" data-lm="lcd" style="left:120px;top:118px;width:770px;height:324px;border-radius:8px;
background:linear-gradient(180deg,#b3c6ae 0%,#a4b99f 60%,#98ad93 100%);box-shadow:inset 0 0 18px rgba(0,0,0,.45)"></div>`;
  // LCD 픽셀 격자
  b += `<div class="abs" style="left:120px;top:118px;width:770px;height:324px;border-radius:8px;opacity:.13;
background:repeating-linear-gradient(0deg,#000 0 1px,transparent 1px 4px),repeating-linear-gradient(90deg,#000 0 1px,transparent 1px 4px)"></div>`;
  const lcd = "#1c2a1f";
  // 상태줄: 신호 막대, LTE, 배터리, 시각
  let bars = "";
  for (let i = 0; i < 4; i++) bars += `<rect x="${i * 11}" y="${24 - (i + 1) * 6}" width="7" height="${(i + 1) * 6}" fill="${lcd}"/>`;
  b += `<svg class="abs" style="left:140px;top:132px" width="60" height="26">${bars}</svg>`;
  b += text(192, 134, "LTE", 22, lcd, FONT_SANS, "font-weight:bold");
  b += `<svg class="abs" style="left:790px;top:132px" width="70" height="28"><rect x="1" y="3" width="54" height="22" rx="3" fill="none" stroke="${lcd}" stroke-width="3"/><rect x="56" y="9" width="6" height="10" fill="${lcd}"/><rect x="5" y="7" width="34" height="14" fill="${lcd}"/></svg>`;
  b += text(640, 134, "14:32", 26, lcd, FONT_MONO, "font-weight:bold");
  b += `<div class="abs" style="left:130px;top:168px;width:750px;height:2px;background:${lcd};opacity:.8"></div>`;
  b += text(150, 184, "[신용승인요청]", 40, lcd, FONT_KO, "font-weight:bold");
  b += text(560, 190, "No.0142", 30, lcd, FONT_MONO);
  b += text(150, 244, "금  액 :", 38, lcd, FONT_KO);
  b += text(520, 240, "12,500 원", 46, lcd, FONT_MONO, "font-weight:bold");
  b += text(150, 300, "할  부 :", 38, lcd, FONT_KO);
  b += text(600, 302, "일시불", 38, lcd, FONT_KO);
  b += `<div class="abs" style="left:136px;top:362px;width:738px;height:62px;background:${lcd}"></div>`;
  b += text(186, 372, "IC카드를 끝까지 넣어주세요", 40, "#a9bda5", FONT_KO);
  // 상태 LED
  b += `<div class="abs" data-lm="led" style="left:950px;top:112px;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#d9ffd4,#35c246 45%,#0e5c1b);box-shadow:0 0 10px rgba(80,255,90,.6)"></div>`;

  // 로고 + 모델
  b += `<div class="abs" data-lm="logo" style="left:1010px;top:110px;width:480px;height:140px"></div>`;
  b += `<svg class="abs" style="left:1000px;top:96px" width="500" height="170" viewBox="0 0 500 170">
<path d="M18 128 C120 150 300 150 470 88 C330 128 170 132 40 110 Z" fill="#e0342b"/>
<text x="24" y="100" font-family="${FONT_SANS}" font-weight="bold" font-style="italic" font-size="106" fill="#f3f4f5" letter-spacing="-2">PAYON</text>
</svg>`;
  b += text(1030, 272, "IC CARD TERMINAL", 26, "#9ea3a9", FONT_SANS, "letter-spacing:4px");
  b += text(1030, 308, "KT-7200 · 무선 LTE", 24, "#80868c", FONT_KO);
  // NFC 영역
  b += `<div class="abs" data-lm="nfc" style="left:1150px;top:352px;width:230px;height:120px;border-radius:18px;border:3px solid #6e7379;opacity:.95"></div>`;
  b += `<svg class="abs" style="left:1175px;top:367px" width="90" height="90" viewBox="0 0 90 90">
<g fill="none" stroke="#d6d9dc" stroke-width="7" stroke-linecap="round">
<path d="M22 30 Q30 45 22 60"/><path d="M36 22 Q48 45 36 68"/><path d="M50 14 Q66 45 50 76"/><path d="M64 8 Q84 45 64 82"/></g></svg>`;
  b += text(1272, 385, "NFC", 30, "#d6d9dc", FONT_SANS, "font-weight:bold");
  b += text(1272, 425, "터치결제", 24, "#aeb3b8", FONT_KO);

  // 기능키 줄
  const fx = [90, 270, 450, 630];
  ["F1", "F2", "F3", "F4"].forEach((f, i) => {
    b += key(`f${i + 1}`, fx[i], 530, 150, 64, f, "", {
      bg: "linear-gradient(180deg,#5a5e64,#3d4045 60%,#303236)",
      fg: "#eceef0",
      size: 34,
    });
  });
  b += key("menu", 810, 530, 190, 64, "메뉴", "", {
    bg: "linear-gradient(180deg,#5a5e64,#3d4045 60%,#303236)",
    fg: "#eceef0",
    size: 34,
    font: FONT_KO,
  });

  // 숫자 키패드 3x4
  const labels = [
    ["1", "QZ"],
    ["2", "ABC"],
    ["3", "DEF"],
    ["4", "GHI"],
    ["5", "JKL"],
    ["6", "MNO"],
    ["7", "PRS"],
    ["8", "TUV"],
    ["9", "WXY"],
    ["*", ""],
    ["0", "-  ,"],
    ["#", ""],
  ];
  const kx = [90, 320, 550];
  const ky = [630, 760, 890, 1020];
  labels.forEach(([m, s], i) => {
    const c = i % 3;
    const r = Math.floor(i / 3);
    const lm = m === "*" ? "keyStar" : m === "#" ? "keyHash" : `key${m}`;
    b += key(lm, kx[c], ky[r], 200, 108, m, s);
  });
  // 5번 키 돌기(시각장애인용 점)
  b += `<div class="abs" style="left:${kx[1] + 94}px;top:${ky[1] + 12}px;width:12px;height:6px;border-radius:3px;background:#8d9095"></div>`;

  // 취소 / 정정 / 확인
  b += key("keyCancel", 800, 630, 200, 108, "취소", "CANCEL", {
    bg: "linear-gradient(180deg,#ee5a4c,#cf3325 60%,#a8261b)",
    fg: "#fff",
    size: 44,
    font: FONT_KO,
    subColor: "#ffd9d4",
  });
  b += key("keyClear", 800, 760, 200, 108, "정정", "CLEAR", {
    bg: "linear-gradient(180deg,#f7d060,#e5b022 60%,#bf8d10)",
    fg: "#2a2006",
    size: 44,
    font: FONT_KO,
    subColor: "#5c4a12",
  });
  b += key("keyOk", 800, 890, 200, 238, "확인", "ENTER", {
    bg: "linear-gradient(180deg,#55c178,#2e9a4f 60%,#1f7439)",
    fg: "#fff",
    size: 50,
    font: FONT_KO,
    subColor: "#d4f5de",
  });

  // 프린터 덮개 (오른쪽 아래)
  b += `<div class="abs" style="left:1060px;top:520px;width:470px;height:610px;border-radius:30px;
background:linear-gradient(180deg,#3b3e43,#2f3236 50%,#292b2f);box-shadow:inset 0 3px 2px rgba(255,255,255,.14), inset 0 -6px 10px rgba(0,0,0,.5), 0 0 0 3px #1c1d20"></div>`;
  b += noise({ freq: 0.5, octaves: 2, seed: 13, opacity: 0.18, x: 1060, y: 520, w: 470, h: 610, radius: 30, contrast: 1.5 });
  // 영수증 배출구 + 종이 끝
  b += `<div class="abs" style="left:1100px;top:548px;width:390px;height:22px;border-radius:11px;background:#0b0b0c;box-shadow:inset 0 3px 4px #000"></div>`;
  b += `<div class="abs" data-lm="paper" style="left:1120px;top:538px;width:350px;height:26px;background:linear-gradient(180deg,#f4f1ea,#dcd8cf);clip-path:polygon(0 100%,3% 0,8% 60%,14% 5%,20% 55%,27% 0,33% 50%,40% 8%,47% 60%,55% 0,63% 50%,70% 5%,78% 55%,85% 0,92% 50%,97% 10%,100% 100%)"></div>`;
  b += text(1120, 600, "용지 교체 시 덮개를 여세요 ▲", 22, "#9ba0a6", FONT_KO);
  // 스티커
  b += `<div class="abs" data-lm="sticker" style="left:1100px;top:760px;width:390px;height:250px;border-radius:8px;background:linear-gradient(170deg,#f7f7f4,#e6e6e1);box-shadow:0 2px 4px rgba(0,0,0,.6)"></div>`;
  b += text(1118, 776, "PAYON KT-7200", 26, "#111", FONT_SANS, "font-weight:bold");
  b += text(1118, 810, "S/N KT72-2231-0048", 22, "#222", FONT_MONO);
  b += text(1118, 838, "KC R-R-PYN-KT7200", 20, "#333", FONT_MONO);
  b += text(1118, 864, "DC 5V ⎓ 2A  제조 2025.03", 20, "#333", FONT_KO);
  b += barcode(rng, 1118, 894, 350, 96, "7200223100480");
  // 나사 구멍, 스피커 구멍
  let holes = "";
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 6; i++)
      holes += `<circle cx="${10 + i * 18 + (j % 2) * 9}" cy="${10 + j * 16}" r="4.5" fill="#101112"/>`;
  b += `<svg class="abs" style="left:1390px;top:1050px" width="130" height="50">${holes}</svg>`;

  // IC 카드 슬롯 (앞쪽 모서리)
  b += `<div class="abs" data-lm="slot" style="left:230px;top:1150px;width:560px;height:30px;border-radius:15px;background:linear-gradient(180deg,#050505,#1b1c1e);box-shadow:inset 0 4px 5px #000, 0 -2px 0 rgba(255,255,255,.18)"></div>`;
  b += text(806, 1150, "IC ▲", 26, "#c3c7cb", FONT_SANS, "font-weight:bold");
  // 먼지·손때
  let dust = "";
  for (let i = 0; i < 90; i++) {
    const x = rng.range(20, POS_W - 20);
    const y = rng.range(20, POS_H - 20);
    const r = rng.range(0.8, 2.6);
    dust += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#fff" opacity="${rng.range(0.08, 0.3).toFixed(2)}"/>`;
  }
  b += `<svg class="abs" style="left:0;top:0" width="${POS_W}" height="${POS_H}">${dust}</svg>`;
  b += noise({ freq: 0.006, octaves: 2, seed: 14, opacity: 0.12, w: POS_W, h: POS_H, blend: "soft-light" });
  return page(POS_W, POS_H, b);
}
