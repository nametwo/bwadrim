// 홀드아웃 전용 텍스처 — 개발용 텍스처와 다른 기기·배치·재질 (추적기 개발 중에는 보지 말 것).
// 렌더 뒤 photoize(사진처럼)를 입힌다. 부조는 data-relief="mm" (+돌출 −함몰) 요소로 표시 (보이지 않는 상자도 가능).
import { FONT_KO, FONT_MONO, FONT_SANS, Rng, barcode, kcMark, noise, page, qrCode, screw, sevenSeg, text } from "./common";

const rel = (x: number, y: number, w: number, h: number, mm: number, r = 0, ellipse = false) =>
  `<div class="abs" data-relief="${mm}"${r ? ` data-relief-r="${r}"` : ""}${ellipse ? ` data-relief-shape="ellipse"` : ""} style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`;
const lm = (name: string, x: number, y: number, w: number, h: number) =>
  `<div class="abs" data-lm="${name}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`;

// ───────────── (h1) 광모뎀(ONT) 뒷면: 흰 광택 본체, 광 포트, 노란 LAN 4개, 전화 2개 ─────────────
export const ONT_W = 1600;
export const ONT_H = 600;

function rj45y(name: string, cx: number, cy: number): string {
  const w = 96;
  const h = 84;
  const x = cx - w / 2;
  const y = cy - h / 2;
  let pins = "";
  for (let i = 0; i < 8; i++) pins += `<rect x="${12 + i * 7}" y="4" width="3" height="14" fill="#c9a236"/>`;
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:4px;background:linear-gradient(180deg,#e9d23a,#c8ac18 60%,#a88f10);box-shadow:0 2px 3px rgba(0,0,0,.45)"></div>
<svg class="abs" style="left:${x + 10}px;top:${y + 8}px" width="76" height="68" viewBox="0 0 76 68"><path d="M0 0 H76 V50 H52 V68 H24 V50 H0 Z" fill="#141414"/><g>${pins}</g></svg>
${rel(x + 10, y + 8, 76, 50, -6)}${rel(x + 34, y + 58, 28, 18, -6)}${lm(name, x, y, w, h)}
<div class="abs" style="left:${x + 8}px;top:${y - 26}px;width:14px;height:10px;border-radius:2px;background:#3fd14b;box-shadow:0 0 6px #6f6"></div>
<div class="abs" style="left:${x + w - 22}px;top:${y - 26}px;width:14px;height:10px;border-radius:2px;background:#e8a21c"></div>`;
}

export function ontHtml(): string {
  const rng = new Rng(9101);
  let b = "";
  b += `<div class="abs" style="left:0;top:0;width:${ONT_W}px;height:${ONT_H}px;background:linear-gradient(180deg,#fafaf7 0%,#efeee8 45%,#e2e0d8 100%)"></div>`;
  b += noise({ freq: 0.9, octaves: 2, seed: 911, opacity: 0.1, w: ONT_W, h: ONT_H, contrast: 1.3 });
  // 위쪽 통풍구 (엇갈린 짧은 슬롯)
  let vents = "";
  for (let r = 0; r < 2; r++) for (let i = 0; i < 34; i++) vents += `<rect x="${60 + i * 44 + (r % 2) * 22}" y="${34 + r * 30}" width="30" height="12" rx="6" fill="#55544f"/>`;
  b += `<svg class="abs" style="left:0;top:0" width="${ONT_W}" height="120">${vents}</svg>`;
  // 라벨 스티커 (왼쪽 위)
  b += `<div class="abs" data-lm="label" style="left:60px;top:110px;width:430px;height:120px;background:#fff;border:2px solid #bbb;border-radius:4px"></div>`;
  b += text(74, 118, "HANBIT NET  광가입자망 단말 ONT-G24", 19, "#111", FONT_KO, "font-weight:bold");
  b += text(74, 146, "MAC 3C:9A:77:0B:5E:21", 17, "#222", FONT_MONO);
  b += text(74, 168, "S/N HBN24G0913377", 17, "#222", FONT_MONO);
  b += text(74, 190, "DC 12V 1.5A   R-C-HBN-G24", 15, "#333", FONT_SANS);
  b += qrCode(rng, 410, 118, 72, 21);
  b += text(560, 150, "GPON  1.25G / 2.5G", 26, "#8a8983", FONT_SANS, "letter-spacing:3px");
  b += text(1100, 150, "사용 전 설명서를 확인하세요", 22, "#8a8983", FONT_KO);
  // 포트 줄
  const cy = 360;
  const label = (cx: number, s: string, size = 22, color = "#3b3a36", font = FONT_SANS) =>
    `<div class="abs" style="left:${cx - 80}px;top:${cy + 62}px;width:160px;text-align:center;font-family:${font};font-size:${size}px;color:${color};font-weight:bold">${s}</div>`;
  // DC 잭
  b += `<div class="abs" style="left:${120 - 32}px;top:${cy - 32}px;width:64px;height:64px;border-radius:50%;background:radial-gradient(circle,#050505 0 40%,#6b6b66 44%,#cfcfca 60%,#8c8b86 75%)"></div>`;
  b += rel(120 - 13, cy - 13, 26, 26, -6, 0, true) + lm("dc", 120 - 32, cy - 32, 64, 64);
  b += label(120, "12V⎓");
  // 전원 버튼 (동그란 누름)
  b += `<div class="abs" style="left:${220 - 30}px;top:${cy - 30}px;width:60px;height:60px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff,#d6d5cf 60%,#a8a7a1);box-shadow:0 3px 5px rgba(0,0,0,.35)"></div>`;
  b += `<svg class="abs" style="left:${220 - 16}px;top:${cy - 16}px" width="32" height="32" viewBox="0 0 32 32"><path d="M16 4 V15" stroke="#3a3a3a" stroke-width="3.5" stroke-linecap="round"/><path d="M9 9 A10 10 0 1 0 23 9" fill="none" stroke="#3a3a3a" stroke-width="3.5" stroke-linecap="round"/></svg>`;
  b += rel(220 - 30, cy - 30, 60, 60, 2.5, 0, true) + lm("powerBtn", 220 - 30, cy - 30, 60, 60);
  b += label(220, "ON/OFF", 18);
  // 광 포트 (SC/APC, 초록 먼지 덮개가 튀어나옴)
  b += `<div class="abs" style="left:${340 - 44}px;top:${cy - 44}px;width:88px;height:88px;border-radius:6px;background:linear-gradient(180deg,#8a8984,#5f5e5a);box-shadow:0 2px 4px rgba(0,0,0,.5)"></div>`;
  b += `<div class="abs" style="left:${340 - 30}px;top:${cy - 34}px;width:60px;height:68px;border-radius:5px;background:linear-gradient(135deg,#6fd36a,#2f9a36 60%,#1f6f25);box-shadow:inset 0 2px 2px rgba(255,255,255,.4)"></div>`;
  b += `<div class="abs" style="left:${340 - 10}px;top:${cy - 12}px;width:20px;height:24px;border-radius:3px;background:#1b5a20"></div>`;
  b += rel(340 - 44, cy - 44, 88, 88, 1.5, 6) + rel(340 - 30, cy - 34, 60, 68, 5, 5) + lm("fiber", 340 - 30, cy - 34, 60, 68);
  b += label(340, "PON", 24, "#2f7a34");
  b += `<svg class="abs" style="left:${340 - 70}px;top:${cy - 90}px" width="140" height="30"><path d="M8 15 H132" stroke="#c43" stroke-width="3"/><text x="70" y="11" text-anchor="middle" font-family="${FONT_SANS}" font-size="13" fill="#c43">LASER CLASS 1</text></svg>`;
  // LAN 1~4 (노란 인서트) — 반복
  const lanX = [500, 630, 760, 890];
  lanX.forEach((x, i) => {
    b += rj45y(`lan${i + 1}`, x, cy);
    b += label(x, `LAN${i + 1}`, 22);
  });
  b += `<div class="abs" style="left:${lanX[0] - 50}px;top:${cy + 96}px;width:${lanX[3] - lanX[0] + 100}px;height:4px;background:#d5b91c"></div>`;
  // TEL 1·2 (RJ11, 회색)
  [1040, 1150].forEach((x, i) => {
    b += `<div class="abs" style="left:${x - 36}px;top:${cy - 32}px;width:72px;height:64px;border-radius:3px;background:linear-gradient(180deg,#9b9a95,#6d6c67);box-shadow:0 2px 3px rgba(0,0,0,.4)"></div>`;
    b += `<svg class="abs" style="left:${x - 26}px;top:${cy - 24}px" width="52" height="48" viewBox="0 0 52 48"><path d="M0 0 H52 V36 H36 V48 H16 V36 H0 Z" fill="#121212"/><rect x="14" y="3" width="3" height="10" fill="#c9a236"/><rect x="22" y="3" width="3" height="10" fill="#c9a236"/><rect x="30" y="3" width="3" height="10" fill="#c9a236"/><rect x="38" y="3" width="3" height="10" fill="#c9a236"/></svg>`;
    b += rel(x - 26, cy - 24, 52, 36, -5) + rel(x - 10, cy + 12, 20, 12, -5) + lm(`tel${i + 1}`, x - 36, cy - 32, 72, 64);
    b += label(x, `TEL${i + 1}`, 20);
  });
  // USB
  b += `<div class="abs" style="left:${1270 - 38}px;top:${cy - 16}px;width:76px;height:32px;border-radius:3px;background:linear-gradient(180deg,#e8e8e6,#9f9f9c);box-shadow:0 1px 2px #000"></div><div class="abs" style="left:${1270 - 32}px;top:${cy - 11}px;width:64px;height:22px;background:#0a0a0a"></div><div class="abs" style="left:${1270 - 28}px;top:${cy - 9}px;width:56px;height:9px;background:#e6e6e3"></div>`;
  b += rel(1270 - 32, cy - 11, 64, 22, -6) + lm("usb", 1270 - 38, cy - 16, 76, 32);
  b += label(1270, "USB", 20);
  // RESET 핀홀 + WPS 버튼
  b += `<div class="abs" style="left:${1370 - 9}px;top:${cy - 9}px;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle,#000 0 45%,#7b7a75 60%,#c9c8c2 80%)"></div>`;
  b += rel(1370 - 5, cy - 5, 10, 10, -5, 0, true) + lm("reset", 1370 - 9, cy - 9, 18, 18);
  b += label(1370, "RESET", 16, "#c0392b");
  b += `<div class="abs" style="left:${1470 - 26}px;top:${cy - 26}px;width:52px;height:52px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#9fd0ff,#2f7fd0 60%,#1c4f86);box-shadow:0 3px 4px rgba(0,0,0,.4)"></div>`;
  b += rel(1470 - 26, cy - 26, 52, 52, 2, 0, true) + lm("wps", 1470 - 26, cy - 26, 52, 52);
  b += label(1470, "WPS", 18, "#1c4f86");
  // 아래 모서리·고무발 그림자
  b += `<div class="abs" style="left:0;top:${ONT_H - 40}px;width:${ONT_W}px;height:40px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.25))"></div>`;
  b += noise({ freq: 0.01, octaves: 3, seed: 912, opacity: 0.12, w: ONT_W, h: ONT_H, blend: "soft-light" });
  return page(ONT_W, ONT_H, b);
}

// ───────────── (h2) 세탁기 조작부: 큰 다이얼 + 코스 LED + 7세그 + 버튼 줄 ─────────────
export const WASHER_W = 1600;
export const WASHER_H = 800;

export function washerHtml(): string {
  let b = "";
  b += `<div class="abs" style="left:0;top:0;width:${WASHER_W}px;height:${WASHER_H}px;background:linear-gradient(180deg,#f4f5f6 0%,#dfe2e5 55%,#cfd3d7 100%)"></div>`;
  b += noise({ freq: [0.002, 0.35], octaves: 2, seed: 921, opacity: 0.14, w: WASHER_W, h: WASHER_H, contrast: 1.4 });
  b += `<div class="abs" style="left:30px;top:30px;width:${WASHER_W - 60}px;height:${WASHER_H - 60}px;border-radius:40px;background:linear-gradient(180deg,#34383d,#1f2226);box-shadow:inset 0 2px 3px rgba(255,255,255,.3)"></div>`;
  b += text(70, 60, "SORA", 44, "#e9ecef", FONT_SANS, "font-weight:bold;letter-spacing:8px");
  b += text(250, 72, "드럼세탁기 21kg · AI 세탁", 24, "#a9b0b8", FONT_KO);
  // 전원 (왼쪽)
  b += `<div class="abs" style="left:${130 - 56}px;top:${420 - 56}px;width:112px;height:112px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#5a5f66,#2a2d31 70%);box-shadow:0 5px 8px rgba(0,0,0,.6), inset 0 2px 2px rgba(255,255,255,.25)"></div>`;
  b += `<svg class="abs" style="left:${130 - 26}px;top:${420 - 26}px" width="52" height="52" viewBox="0 0 32 32"><path d="M16 4 V15" stroke="#ff4d3d" stroke-width="3" stroke-linecap="round"/><path d="M9 9 A10 10 0 1 0 23 9" fill="none" stroke="#ff4d3d" stroke-width="3" stroke-linecap="round"/></svg>`;
  b += rel(130 - 56, 420 - 56, 112, 112, 3, 0, true) + lm("btnPower", 130 - 56, 420 - 56, 112, 112);
  b += text(100, 490, "전원", 24, "#d7dce1", FONT_KO);
  // 다이얼 + 코스 표시 (원 둘레)
  const kx = 520;
  const ky = 420;
  const courses = ["표준", "울/섬세", "이불", "타월", "헹굼+탈수", "탈수", "통세척", "속건", "아기옷", "스피드"];
  courses.forEach((c, i) => {
    const a = ((-150 + (i * 300) / (courses.length - 1)) * Math.PI) / 180;
    const rx = kx + 215 * Math.sin(a);
    const ry = ky - 215 * Math.cos(a);
    b += `<div class="abs" style="left:${rx - 7}px;top:${ry - 7}px;width:14px;height:14px;border-radius:50%;background:${i === 0 ? "#6cf06a" : "#555b62"}"></div>`;
    const tx = kx + 265 * Math.sin(a);
    const ty = ky - 265 * Math.cos(a);
    b += `<div class="abs" style="left:${tx - 70}px;top:${ty - 14}px;width:140px;text-align:center;font-family:${FONT_KO};font-size:22px;color:#e1e5e9">${c}</div>`;
  });
  b += `<div class="abs" style="left:${kx - 168}px;top:${ky - 168}px;width:336px;height:336px;border-radius:50%;background:radial-gradient(circle,#2b2f34 60%,#15171a);box-shadow:inset 0 3px 6px #000"></div>`;
  let ridges = "";
  for (let i = 0; i < 36; i++) ridges += `<rect x="-3" y="-150" width="6" height="26" rx="3" fill="#8b9199" transform="rotate(${i * 10})"/>`;
  b += `<svg class="abs" style="left:${kx - 150}px;top:${ky - 150}px" width="300" height="300" viewBox="-150 -150 300 300"><defs><radialGradient id="kb" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#e8ebee"/><stop offset=".55" stop-color="#b7bdc4"/><stop offset="1" stop-color="#7d838a"/></radialGradient></defs><circle r="148" fill="url(#kb)"/>${ridges}<circle r="112" fill="#c9ced4"/><rect x="-7" y="-106" width="14" height="46" rx="7" fill="#2b2f34"/></svg>`;
  b += rel(kx - 168, ky - 168, 336, 336, -2, 0, true) + rel(kx - 150, ky - 150, 300, 300, 6, 0, true) + lm("knob", kx - 112, ky - 112, 224, 224);
  // 표시창 (7세그 남은 시간 + 아이콘)
  b += `<div class="abs" style="left:880px;top:180px;width:420px;height:200px;border-radius:14px;background:#050607;box-shadow:inset 0 3px 6px #000"></div>`;
  b += rel(880, 180, 420, 200, -1.5, 14) + lm("display", 880, 180, 420, 200);
  b += `<svg class="abs" style="left:0;top:0" width="${WASHER_W}" height="${WASHER_H}">${sevenSeg("1 25", 920, 205, 120, "#ffb23d", 0.06)}</svg>`;
  b += `<div class="abs" style="left:1030px;top:240px;width:14px;height:14px;border-radius:50%;background:#ffb23d"></div><div class="abs" style="left:1030px;top:290px;width:14px;height:14px;border-radius:50%;background:#ffb23d"></div>`;
  b += text(1210, 214, "남은", 20, "#ffb23d", FONT_KO);
  b += text(1210, 240, "시간", 20, "#ffb23d", FONT_KO);
  b += text(1200, 330, "40°C 1000", 22, "#ffb23d", FONT_SANS);
  // 버튼 줄
  const btns = [
    ["btnTemp", "온도"],
    ["btnRinse", "헹굼"],
    ["btnSpin", "탈수"],
    ["btnResv", "예약"],
    ["btnDet", "세제"],
  ];
  btns.forEach(([name, lab], i) => {
    const x = 860 + i * 96;
    b += `<div class="abs" style="left:${x}px;top:430px;width:80px;height:54px;border-radius:12px;background:linear-gradient(180deg,#50555c,#2d3136);box-shadow:0 4px 5px rgba(0,0,0,.55), inset 0 1px 1px rgba(255,255,255,.3)"></div>`;
    b += rel(x, 430, 80, 54, 2, 12) + lm(name, x, 430, 80, 54);
    b += `<div class="abs" style="left:${x}px;top:494px;width:80px;text-align:center;font-family:${FONT_KO};font-size:22px;color:#dfe3e7">${lab}</div>`;
    b += `<div class="abs" style="left:${x + 34}px;top:530px;width:12px;height:6px;border-radius:3px;background:${i === 0 ? "#6cf06a" : "#484d53"}"></div>`;
  });
  // 동작/일시정지 (오른쪽 큰 버튼)
  b += `<div class="abs" style="left:${1430 - 70}px;top:${420 - 70}px;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#5a5f66,#2a2d31 70%);box-shadow:0 5px 8px rgba(0,0,0,.6), inset 0 2px 2px rgba(255,255,255,.25)"></div>`;
  b += `<svg class="abs" style="left:${1430 - 34}px;top:${420 - 26}px" width="70" height="52" viewBox="0 0 70 52"><path d="M4 4 L30 26 L4 48 Z" fill="#6cf06a"/><rect x="40" y="6" width="9" height="40" fill="#6cf06a"/><rect x="55" y="6" width="9" height="40" fill="#6cf06a"/></svg>`;
  b += rel(1430 - 70, 420 - 70, 140, 140, 3, 0, true) + lm("btnStart", 1430 - 70, 420 - 70, 140, 140);
  b += text(1360, 510, "동작/일시정지", 22, "#d7dce1", FONT_KO);
  b += text(860, 600, "3초 누르면 잠금 ·  세제 자동투입", 22, "#8f969e", FONT_KO);
  b += noise({ freq: 0.012, octaves: 2, seed: 922, opacity: 0.1, w: WASHER_W, h: WASHER_H, blend: "soft-light" });
  return page(WASHER_W, WASHER_H, b);
}

// ───────────── (h3) 다른 회사 실내 온도조절기 (세로형, 둥근 LCD, 물리 버튼 4개) ─────────────
export const THERMO_W = 1100;
export const THERMO_H = 1400;

export function thermoHtml(): string {
  let b = "";
  b += `<div class="abs" style="left:0;top:0;width:${THERMO_W}px;height:${THERMO_H}px;background:#cfc8bb"></div>`;
  b += `<div class="abs" style="left:8px;top:8px;width:${THERMO_W - 16}px;height:${THERMO_H - 16}px;border-radius:70px;background:linear-gradient(165deg,#474b50 0%,#2e3135 50%,#232528 100%);box-shadow:inset 0 5px 8px rgba(255,255,255,.18), inset 0 -10px 16px rgba(0,0,0,.5)"></div>`;
  b += noise({ freq: 0.8, octaves: 2, seed: 931, opacity: 0.14, x: 8, y: 8, w: THERMO_W - 16, h: THERMO_H - 16, radius: 70, contrast: 1.4 });
  b += text(90, 80, "NARAE", 46, "#e7e9ec", FONT_SANS, "font-weight:bold;letter-spacing:4px");
  b += text(330, 94, "각방 온도조절기 RC-310", 26, "#9ba1a8", FONT_KO);
  b += `<div class="abs" data-lm="led" style="left:960px;top:96px;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#ffd9c2,#ff6a2b 50%,#9c2d08)"></div>`;
  // 둥근 LCD (약간 들어감) + 링
  const cx = 550;
  const cy = 540;
  b += `<div class="abs" style="left:${cx - 330}px;top:${cy - 330}px;width:660px;height:660px;border-radius:50%;background:conic-gradient(from 20deg,#5a5f66,#2b2e32,#5a5f66,#2b2e32,#5a5f66);box-shadow:0 3px 4px rgba(0,0,0,.5)"></div>`;
  b += `<div class="abs" style="left:${cx - 280}px;top:${cy - 280}px;width:560px;height:560px;border-radius:50%;background:radial-gradient(circle at 45% 40%,#bfe6ff 0%,#8fcbef 55%,#5fa5cf 100%);box-shadow:inset 0 0 30px rgba(0,0,0,.45)"></div>`;
  b += rel(cx - 280, cy - 280, 560, 560, -1.5, 0, true);
  b += lm("lcdTemp", cx - 180, cy - 150, 300, 220);
  b += `<svg class="abs" style="left:0;top:0" width="${THERMO_W}" height="${THERMO_H}">${sevenSeg("22", cx - 190, cy - 150, 230, "#0f2a3d", 0.08)}${sevenSeg("5", cx + 140, cy - 40, 110, "#0f2a3d", 0.08)}</svg>`;
  b += `<div class="abs" style="left:${cx + 112}px;top:${cy + 50}px;width:14px;height:14px;border-radius:50%;background:#0f2a3d"></div>`;
  b += text(cx + 140, cy - 150, "°C", 56, "#0f2a3d", FONT_SANS, "font-weight:bold");
  b += text(cx - 150, cy + 110, "실내", 34, "#0f2a3d", FONT_KO);
  b += text(cx - 20, cy + 110, "설정 24.0", 34, "#0f2a3d", FONT_KO);
  b += `<svg class="abs" style="left:${cx - 110}px;top:${cy - 230}px" width="220" height="50" viewBox="0 0 220 50"><path d="M20 44 C10 30 22 22 22 8 C30 18 36 22 32 36 C38 30 38 24 36 18 C46 28 44 42 34 46 Z" fill="#0f2a3d"/><rect x="80" y="14" width="48" height="10" rx="4" fill="#0f2a3d" opacity=".12"/><circle cx="170" cy="25" r="16" fill="none" stroke="#0f2a3d" stroke-width="4" opacity=".12"/></svg>`;
  // 버튼 4개 (물리)
  const bs: [string, string, number][] = [
    ["btnMode", "모드", 190],
    ["btnDown", "▼", 420],
    ["btnUp", "▲", 650],
    ["btnAway", "외출", 880],
  ];
  for (const [name, lab, x] of bs) {
    b += `<div class="abs" style="left:${x - 90}px;top:960px;width:180px;height:150px;border-radius:30px;background:linear-gradient(180deg,#5e636a,#393c41 60%,#2c2e32);box-shadow:0 7px 9px rgba(0,0,0,.6), inset 0 2px 2px rgba(255,255,255,.3)"></div>`;
    b += rel(x - 90, 960, 180, 150, 2.5, 30) + lm(name, x - 90, 960, 180, 150);
    b += `<div class="abs" style="left:${x - 90}px;top:1002px;width:180px;text-align:center;font-family:${FONT_KO};font-size:${lab.length > 1 ? 44 : 56}px;color:#f0f2f4;font-weight:bold">${lab}</div>`;
  }
  b += text(170, 1180, "▲▼ 온도   ·   모드 3초: 난방/온수 전환", 30, "#8d939a", FONT_KO);
  b += text(360, 1260, "고객센터 1661-0000", 28, "#7a8087", FONT_KO);
  b += screw(550, 1340, 16, 30, "#8f9398");
  b += noise({ freq: 0.01, octaves: 3, seed: 932, opacity: 0.12, w: THERMO_W, h: THERMO_H, blend: "soft-light" });
  return page(THERMO_W, THERMO_H, b);
}

// ───────────── (h4) 휴대형 카드 단말기 (터치 화면 + 작은 고무 키패드) ─────────────
export const HANDHELD_W = 1000;
export const HANDHELD_H = 1700;

export function handheldHtml(): string {
  const rng = new Rng(9404);
  let b = "";
  b += `<div class="abs" style="left:0;top:0;width:${HANDHELD_W}px;height:${HANDHELD_H}px;background:#2a2622"></div>`;
  b += `<div class="abs" style="left:6px;top:6px;width:${HANDHELD_W - 12}px;height:${HANDHELD_H - 12}px;border-radius:90px;background:linear-gradient(170deg,#3c3f44,#212326 60%,#191a1c);box-shadow:inset 0 6px 8px rgba(255,255,255,.2)"></div>`;
  b += noise({ freq: 0.9, octaves: 2, seed: 941, opacity: 0.16, x: 6, y: 6, w: HANDHELD_W - 12, h: HANDHELD_H - 12, radius: 90, contrast: 1.5 });
  // 프린터 용지 배출구 (위)
  b += `<div class="abs" style="left:120px;top:60px;width:760px;height:30px;border-radius:15px;background:#050505;box-shadow:inset 0 4px 5px #000"></div>`;
  b += rel(120, 60, 760, 30, -4, 15) + lm("paperSlot", 120, 60, 760, 30);
  b += text(360, 110, "M-PAY 5", 34, "#cfd3d8", FONT_SANS, "font-weight:bold;letter-spacing:4px");
  // 터치 화면 (유리, 살짝 들어감) — 결제 화면
  const sx = 90;
  const sy = 170;
  const sw = 820;
  const sh = 700;
  b += `<div class="abs" style="left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px;border-radius:24px;background:#0a0b0c"></div>`;
  b += rel(sx, sy, sw, sh, -1, 24);
  b += `<div class="abs" style="left:${sx + 30}px;top:${sy + 30}px;width:${sw - 60}px;height:${sh - 60}px;border-radius:8px;background:linear-gradient(180deg,#f7f9fc,#e9eef5)"></div>`;
  b += `<div class="abs" style="left:${sx + 30}px;top:${sy + 30}px;width:${sw - 60}px;height:70px;background:#1f5fbf;border-radius:8px 8px 0 0"></div>`;
  b += text(sx + 60, sy + 50, "신용카드 결제", 34, "#fff", FONT_KO, "font-weight:bold");
  b += text(sx + 600, sy + 52, "14:07", 30, "#dbe6ff", FONT_SANS);
  b += text(sx + 60, sy + 140, "결제 금액", 34, "#333", FONT_KO);
  b += text(sx + 360, sy + 128, "35,000원", 64, "#111", FONT_KO, "font-weight:bold");
  b += text(sx + 60, sy + 230, "할부 개월", 30, "#555", FONT_KO);
  b += text(sx + 520, sy + 230, "일시불  ▾", 30, "#1f5fbf", FONT_KO);
  b += `<div class="abs" style="left:${sx + 60}px;top:${sy + 290}px;width:${sw - 120}px;height:2px;background:#c9d1dc"></div>`;
  b += text(sx + 60, sy + 320, "카드를 꽂거나 대주세요", 32, "#333", FONT_KO);
  b += barcode(rng, sx + 60, sy + 380, 330, 90);
  b += qrCode(rng, sx + 560, sy + 360, 140, 21);
  b += `<div class="abs" style="left:${sx + 60}px;top:${sy + 520}px;width:320px;height:100px;border-radius:14px;background:#e4e8ee;border:3px solid #b7c0cc;text-align:center;font-family:${FONT_KO};font-size:40px;line-height:94px;color:#444">취소</div>`;
  b += `<div class="abs" style="left:${sx + 440}px;top:${sy + 520}px;width:320px;height:100px;border-radius:14px;background:#1f5fbf;text-align:center;font-family:${FONT_KO};font-size:40px;line-height:100px;color:#fff;font-weight:bold">승인 요청</div>`;
  b += lm("screenOk", sx + 440, sy + 520, 320, 100) + lm("screenCancel", sx + 60, sy + 520, 320, 100);
  // 고무 키패드 4x3
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  keys.forEach((k, i) => {
    const c = i % 3;
    const r = Math.floor(i / 3);
    const x = 110 + c * 210;
    const y = 930 + r * 120;
    b += `<div class="abs" style="left:${x}px;top:${y}px;width:180px;height:96px;border-radius:40px;background:linear-gradient(180deg,#6d7178,#4b4e53 60%,#3b3d41);box-shadow:0 5px 6px rgba(0,0,0,.6), inset 0 2px 2px rgba(255,255,255,.25)"></div>`;
    b += rel(x, y, 180, 96, 2, 40) + lm(k === "*" ? "keyStar" : k === "#" ? "keyHash" : `key${k}`, x, y, 180, 96);
    b += `<div class="abs" style="left:${x}px;top:${y + 20}px;width:180px;text-align:center;font-family:${FONT_SANS};font-size:50px;color:#f4f5f6;font-weight:bold;line-height:1">${k}</div>`;
  });
  // 기능키 (오른쪽 세로): 취소(빨강) 정정(노랑) 확인(초록)
  const fk: [string, string, string, number][] = [
    ["keyCancel", "✕", "#d9412f", 930],
    ["keyClear", "◀", "#e2b21c", 1050],
    ["keyEnter", "●", "#2e9a4f", 1170],
  ];
  for (const [name, sym, col, y] of fk) {
    b += `<div class="abs" style="left:750px;top:${y}px;width:150px;height:96px;border-radius:40px;background:${col};box-shadow:0 5px 6px rgba(0,0,0,.6), inset 0 2px 2px rgba(255,255,255,.35)"></div>`;
    b += rel(750, y, 150, 96, 2, 40) + lm(name, 750, y, 150, 96);
    b += `<div class="abs" style="left:750px;top:${y + 18}px;width:150px;text-align:center;font-family:${FONT_SANS};font-size:52px;color:#fff;line-height:1">${sym}</div>`;
  }
  // 카드 슬롯 (아래 앞면)
  b += `<div class="abs" style="left:150px;top:1480px;width:700px;height:34px;border-radius:17px;background:linear-gradient(180deg,#000,#1a1b1d);box-shadow:inset 0 4px 5px #000, 0 -2px 0 rgba(255,255,255,.15)"></div>`;
  b += rel(150, 1480, 700, 34, -6, 17) + lm("cardSlot", 150, 1480, 700, 34);
  b += text(360, 1540, "IC 카드 ▲ 이쪽으로", 30, "#aeb3b9", FONT_KO);
  b += kcMark(860, 1590, 60, "#8b9096");
  b += noise({ freq: 0.008, octaves: 2, seed: 942, opacity: 0.12, w: HANDHELD_W, h: HANDHELD_H, blend: "soft-light" });
  return page(HANDHELD_W, HANDHELD_H, b);
}

// ───────────── (h5) 다른 분전반: 2줄, 1P/2P 섞임, 빈 덮개, 손글씨 라벨 ─────────────
export const PANEL2_W = 1600;
export const PANEL2_H = 1100;

function mcb2(name: string, x: number, y: number, w: number, poles: 1 | 2): string {
  const h = 260;
  let s = `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:5px;background:linear-gradient(90deg,#cfd0cc,#f6f6f2 20%,#fdfdfa 50%,#efefeb 80%,#c4c5c1);box-shadow:3px 0 4px rgba(0,0,0,.45)"></div>`;
  s += rel(x, y, w, h, 3, 5);
  s += `<div class="abs" style="left:${x}px;top:${y + 12}px;width:${w}px;text-align:center;font-family:${FONT_SANS};font-size:18px;font-weight:bold;color:#1d1d1d">${poles === 2 ? "C32" : "B16"}</div>`;
  s += `<div class="abs" style="left:${x + 12}px;top:${y + 70}px;width:${w - 24}px;height:130px;border-radius:5px;background:linear-gradient(180deg,#a3a39c,#e2e2dc 20%,#d3d3cd 80%,#95958f);box-shadow:inset 0 2px 5px rgba(0,0,0,.5)"></div>`;
  s += rel(x + 12, y + 70, w - 24, 130, 1.5, 5);
  const lw = poles === 2 ? w - 40 : w - 30;
  s += `<div class="abs" style="left:${x + (w - lw) / 2}px;top:${y + 78}px;width:${lw}px;height:70px;border-radius:5px;background:linear-gradient(180deg,#2f63b8,#1d3f7a 60%,#132a52);box-shadow:0 7px 7px rgba(0,0,0,.55), inset 0 2px 1px rgba(255,255,255,.35)"></div>`;
  s += rel(x + (w - lw) / 2, y + 78, lw, 70, 6, 5) + lm(name, x + (w - lw) / 2, y + 78, lw, 70);
  s += `<div class="abs" style="left:${x}px;top:${y + 214}px;width:${w}px;text-align:center;font-family:${FONT_SANS};font-size:13px;color:#555">ON ▲</div>`;
  return s;
}

export function panel2Html(): string {
  const rng = new Rng(9505);
  let b = "";
  b += `<div class="abs" style="left:0;top:0;width:${PANEL2_W}px;height:${PANEL2_H}px;background:linear-gradient(170deg,#ecebe6,#d9d8d2 70%,#cfcdc6)"></div>`;
  b += noise({ freq: 0.55, octaves: 3, seed: 951, opacity: 0.2, w: PANEL2_W, h: PANEL2_H, contrast: 1.3 });
  b += screw(60, 60, 18, 40, "#c8c9c5");
  b += screw(PANEL2_W - 60, 60, 18, 10, "#c8c9c5");
  b += screw(60, PANEL2_H - 60, 18, 75, "#c8c9c5");
  b += screw(PANEL2_W - 60, PANEL2_H - 60, 18, 55, "#c8c9c5");
  b += rel(42, 42, 36, 36, 1.5, 0, true) + rel(PANEL2_W - 78, 42, 36, 36, 1.5, 0, true);
  b += text(120, 60, "세대 분전반  LS-D12", 38, "#2b2b2b", FONT_KO, "font-weight:bold");
  b += text(120, 110, "정격 220V 60Hz  주 ELB 40A 30mA", 24, "#444", FONT_KO);
  b += `<div class="abs" style="left:1050px;top:50px;width:470px;height:110px;border-radius:6px;background:#f6d21d;box-shadow:0 2px 3px rgba(0,0,0,.3)"></div>`;
  b += text(1075, 66, "⚡ 감전 주의 — 점검 전 주 차단기 OFF", 26, "#111", FONT_KO, "font-weight:bold");
  b += text(1075, 110, "누전 시험은 매월 1회 TEST 버튼", 24, "#222", FONT_KO);
  // 두 줄 창
  const rows = [240, 640];
  for (const ry of rows) {
    b += `<div class="abs" style="left:90px;top:${ry - 20}px;width:1420px;height:300px;border-radius:8px;background:#1b1c1e;box-shadow:inset 0 10px 18px #000, 0 2px 0 rgba(255,255,255,.5)"></div>`;
    b += rel(90, ry - 20, 1420, 300, -6, 8);
    b += `<div class="abs" style="left:90px;top:${ry + 110}px;width:1420px;height:30px;background:linear-gradient(180deg,#8d9196,#c7cacd 40%,#6e7277)"></div>`;
  }
  // 1줄: ELB + 2P + 1P ×4
  const elbX = 120;
  const ey = rows[0];
  b += `<div class="abs" style="left:${elbX}px;top:${ey}px;width:230px;height:260px;border-radius:6px;background:linear-gradient(90deg,#3a3d42,#5a5e64 30%,#4d5156 80%,#34373b);box-shadow:4px 0 6px rgba(0,0,0,.6)"></div>`;
  b += rel(elbX, ey, 230, 260, 3, 6);
  b += text(elbX + 18, ey + 14, "ELB 40A", 24, "#f2f2f2", FONT_SANS, "font-weight:bold");
  b += `<div class="abs" style="left:${elbX + 80}px;top:${ey + 70}px;width:90px;height:130px;border-radius:6px;background:#23262a;box-shadow:inset 0 3px 6px #000"></div>`;
  b += rel(elbX + 80, ey + 70, 90, 130, 1.5, 6);
  b += `<div class="abs" style="left:${elbX + 90}px;top:${ey + 78}px;width:70px;height:70px;border-radius:5px;background:linear-gradient(180deg,#303236,#0e0f10);box-shadow:0 7px 7px rgba(0,0,0,.6)"></div>`;
  b += rel(elbX + 90, ey + 78, 70, 70, 6, 5) + lm("elb", elbX + 90, ey + 78, 70, 70);
  b += `<div class="abs" style="left:${elbX + 22}px;top:${ey + 110}px;width:42px;height:42px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff7a8,#f0cf1c 55%,#a88a05);box-shadow:0 3px 4px rgba(0,0,0,.6)"></div>`;
  b += rel(elbX + 22, ey + 110, 42, 42, 4.5, 0, true) + lm("elbTest", elbX + 22, ey + 110, 42, 42);
  b += text(elbX + 20, ey + 160, "TEST", 18, "#f3d23a", FONT_SANS, "font-weight:bold");
  let x = 380;
  const layout1: (1 | 2 | 0)[] = [2, 1, 1, 1, 1, 0, 1];
  let n = 1;
  const labels = ["에어컨", "거실", "주방", "", "욕실", "", "안방", "작은방", "", "전열", "세탁기", "냉장고"];
  const placeLabel = (lx: number, w: number, ly: number, s: string) => {
    if (!s) return "";
    const rot = rng.range(-5, 5);
    return `<div class="abs" style="left:${lx}px;top:${ly}px;width:${Math.max(w, 100)}px;height:46px;background:linear-gradient(180deg,#f3ecd2,#e6dab4);transform:rotate(${rot.toFixed(1)}deg);font-family:${FONT_KO};font-size:28px;color:#16307a;text-align:center;line-height:46px;font-style:italic">${s}</div>`;
  };
  for (const p of layout1) {
    const w = p === 2 ? 190 : p === 1 ? 100 : 100;
    if (p === 0) {
      b += `<div class="abs" style="left:${x}px;top:${ey}px;width:${w}px;height:260px;border-radius:5px;background:linear-gradient(90deg,#c9c8c2,#e7e6e1 50%,#c2c1bb)"></div>` + rel(x, ey, w, 260, 2, 5);
    } else {
      b += mcb2(`br${n}`, x, ey, w, p);
      b += placeLabel(x, w, ey - 70, labels[n - 1]);
      n++;
    }
    x += w + 12;
  }
  // 2줄: 1P ×6 + 빈 덮개 + 2P
  x = 130;
  const layout2: (1 | 2 | 0)[] = [1, 1, 1, 1, 0, 1, 1, 2];
  const ey2 = rows[1];
  for (const p of layout2) {
    const w = p === 2 ? 190 : 100;
    if (p === 0) {
      b += `<div class="abs" style="left:${x}px;top:${ey2}px;width:${w}px;height:260px;border-radius:5px;background:linear-gradient(90deg,#c9c8c2,#e7e6e1 50%,#c2c1bb)"></div>` + rel(x, ey2, w, 260, 2, 5);
    } else {
      b += mcb2(`br${n}`, x, ey2, w, p);
      b += placeLabel(x, w, ey2 + 290, labels[n - 1]);
      n++;
    }
    x += w + 12;
  }
  for (let i = 0; i < 30; i++) {
    const sx = rng.range(40, PANEL2_W - 40);
    const sy = rng.range(40, PANEL2_H - 40);
    const l = rng.range(10, 50);
    const a = rng.range(0, Math.PI);
    b += `<svg class="abs" style="left:0;top:0" width="${PANEL2_W}" height="${PANEL2_H}"><path d="M${sx.toFixed(0)} ${sy.toFixed(0)} l${(l * Math.cos(a)).toFixed(0)} ${(l * Math.sin(a)).toFixed(0)}" stroke="#fff" stroke-width="1.5" opacity="${rng.range(0.15, 0.4).toFixed(2)}"/></svg>`;
  }
  return page(PANEL2_W, PANEL2_H, b);
}

// ───────────── (h6) 가스보일러 금속 명판 (헤어라인 알루미늄, 에칭 글씨, 리벳) ─────────────
export const METAL_W = 1600;
export const METAL_H = 1000;

export function metalPlateHtml(): string {
  const rng = new Rng(9606);
  let b = "";
  b += `<div class="abs" style="left:0;top:0;width:${METAL_W}px;height:${METAL_H}px;background:#e9e6df"></div>`;
  b += noise({ freq: 0.6, octaves: 2, seed: 961, opacity: 0.15, w: METAL_W, h: METAL_H });
  b += `<div class="abs" style="left:50px;top:50px;width:${METAL_W - 100}px;height:${METAL_H - 100}px;border-radius:26px;background:linear-gradient(100deg,#c9ccd0 0%,#eef0f2 30%,#b7bbc0 55%,#e3e6e9 80%,#c2c6ca 100%);box-shadow:0 3px 4px rgba(0,0,0,.4)"></div>`;
  b += noise({ freq: [0.0015, 0.5], octaves: 2, seed: 962, opacity: 0.5, x: 50, y: 50, w: METAL_W - 100, h: METAL_H - 100, radius: 26, contrast: 1.6 });
  b += rel(50, 50, METAL_W - 100, METAL_H - 100, 0.6, 26);
  for (const [rx, ry] of [
    [100, 100],
    [METAL_W - 100, 100],
    [100, METAL_H - 100],
    [METAL_W - 100, METAL_H - 100],
  ]) {
    b += `<div class="abs" style="left:${rx - 18}px;top:${ry - 18}px;width:36px;height:36px;border-radius:50%;background:radial-gradient(circle at 38% 32%,#fff,#b9bdc2 50%,#74787d);box-shadow:0 2px 3px rgba(0,0,0,.5)"></div>`;
    b += rel(rx - 18, ry - 18, 36, 36, 1.8, 0, true);
  }
  b += text(150, 120, "대양가스보일러", 56, "#1b1b1b", FONT_KO, "font-weight:bold");
  b += text(640, 132, "DY-HC24K  콘덴싱 · 가정용", 38, "#222", FONT_KO);
  b += `<div class="abs" style="left:140px;top:200px;width:${METAL_W - 280}px;height:4px;background:#2a2a2a"></div>`;
  const rowsT: [string, string, string?][] = [
    ["형식", "강제급배기식 FF", "type"],
    ["가스 종류", "LNG (도시가스)  2.0 kPa", "gas"],
    ["난방 출력", "20,000 kcal/h (23.3 kW)", "output"],
    ["최고 사용 압력", "0.35 MPa", undefined],
    ["전원", "AC 220V 60Hz  115 W", "power"],
    ["제조 번호", "DY24K-2507-081443", "serial"],
    ["제조 년월", "2025년 07월", "date"],
  ];
  rowsT.forEach(([k, v, name], i) => {
    const y = 230 + i * 78;
    b += text(160, y + 18, k, 34, "#1c1c1c", FONT_KO, "font-weight:bold");
    b += text(520, y + 16, v, 38, "#111", /[0-9A-Z]/.test(v[0]) ? FONT_MONO : FONT_KO, "font-weight:bold");
    if (name) b += lm(name, 510, y + 6, 640, 62);
    b += `<div class="abs" style="left:150px;top:${y + 72}px;width:1030px;height:2px;background:#5a5c60;opacity:.7"></div>`;
  });
  b += kcMark(1240, 250, 150, "#1a1a1a");
  b += qrCode(rng, 1230, 450, 200, 21);
  b += text(1215, 670, "사용설명·A/S", 24, "#222", FONT_KO);
  b += text(160, 820, "※ 설치·이전은 가스시공업 등록업체에서만 하십시오.  A/S 1577-0000", 26, "#2a2a2a", FONT_KO);
  // 각인 점 (스탬프)
  let dots = "";
  for (let i = 0; i < 120; i++) dots += `<circle cx="${rng.range(160, 1180).toFixed(0)}" cy="${rng.range(880, 900).toFixed(0)}" r="1.6" fill="#555"/>`;
  b += `<svg class="abs" style="left:0;top:0" width="${METAL_W}" height="${METAL_H}">${dots}</svg>`;
  return page(METAL_W, METAL_H, b);
}

export { FONT_SANS };
