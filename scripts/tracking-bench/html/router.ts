// (b) 공유기 뒷면: 똑같은 LAN 포트 4개 + WAN + 전원 + 리셋 + USB + 안테나 (반복 패턴!)
import { FONT_KO, FONT_SANS, noise, page, text } from "./common";

export const ROUTER_W = 1600;
export const ROUTER_H = 700;

/** RJ45 잭: 금속 실드 + 검은 구멍 + 금색 접점 8개 + 아래쪽 걸쇠 홈. 모든 LAN 포트가 픽셀 단위로 같다 */
function rj45(lm: string, cx: number, cy: number, insert: string): string {
  const w = 104;
  const h = 92;
  const x = cx - w / 2;
  const y = cy - h / 2;
  let pins = "";
  for (let i = 0; i < 8; i++) {
    pins += `<rect x="${14 + i * 7.6}" y="4" width="3.4" height="16" fill="url(#gold)"/>`;
  }
  return `<div class="abs" data-lm="${lm}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:5px;
background:linear-gradient(180deg,#e3e6ea 0%,#aeb3b9 40%,#8d9298 70%,#c4c8cc 100%);box-shadow:0 3px 5px rgba(0,0,0,.7), inset 0 1px 1px #fff"></div>
<svg class="abs" style="left:${x + 11}px;top:${y + 9}px" width="82" height="76" viewBox="0 0 82 76">
<defs><linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2b3"/><stop offset=".5" stop-color="#d6a932"/><stop offset="1" stop-color="#7a5a12"/></linearGradient>
<linearGradient id="hole${insert.slice(1)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset=".55" stop-color="${insert}"/><stop offset="1" stop-color="#000"/></linearGradient></defs>
<path d="M0 0 H82 V58 H56 V76 H26 V58 H0 Z" fill="url(#hole${insert.slice(1)})"/>
<path d="M0 0 H82 V58 H56 V76 H26 V58 H0 Z" fill="none" stroke="#000" stroke-width="3"/>
<g transform="translate(4,0)">${pins}</g>
<rect x="8" y="30" width="66" height="22" fill="#000" opacity=".55"/>
</svg>
<div class="abs" style="left:${x + 4}px;top:${y + 3}px;width:12px;height:7px;border-radius:2px;background:#3d4a3d;box-shadow:inset 0 1px 1px rgba(255,255,255,.3)"></div>
<div class="abs" style="left:${x + w - 16}px;top:${y + 3}px;width:12px;height:7px;border-radius:2px;background:#4d4435;box-shadow:inset 0 1px 1px rgba(255,255,255,.3)"></div>`;
}

function smaAntenna(lm: string, cx: number, cy: number): string {
  return `<svg class="abs" data-lm="${lm}" style="left:${cx - 50}px;top:${cy - 50}px" width="100" height="100" viewBox="-50 -50 100 100">
<defs><radialGradient id="nut" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff6c8"/><stop offset=".45" stop-color="#d9b04a"/><stop offset="1" stop-color="#6c5114"/></radialGradient>
<radialGradient id="cap" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#55585d"/><stop offset="1" stop-color="#0c0c0d"/></radialGradient></defs>
<circle r="46" fill="#111" opacity=".6"/>
<polygon points="40,0 20,34.6 -20,34.6 -40,0 -20,-34.6 20,-34.6" fill="url(#nut)" stroke="#5b4510" stroke-width="2"/>
<circle r="26" fill="url(#cap)" stroke="#000" stroke-width="2"/>
<circle r="9" fill="#27292c"/>
</svg>`;
}

export function routerHtml(): string {
  let b = "";
  // 본체: 무광 검정 플라스틱, 위아래 모서리 곡면
  b += `<div class="abs" style="left:0;top:0;width:${ROUTER_W}px;height:${ROUTER_H}px;
background:linear-gradient(180deg,#5b5e63 0%,#3a3c40 4%,#2c2e31 8%,#2a2c2f 60%,#232427 92%,#141516 100%)"></div>`;
  b += noise({ freq: 0.9, octaves: 2, seed: 21, opacity: 0.2, w: ROUTER_W, h: ROUTER_H, contrast: 1.5 });
  b += noise({ freq: [0.004, 0.02], octaves: 2, seed: 22, opacity: 0.12, w: ROUTER_W, h: ROUTER_H, blend: "soft-light" });

  // 통풍구 슬롯 (반복, 엇갈림)
  let vents = "";
  for (let r = 0; r < 4; r++) {
    const off = r % 2 ? 22 : 0;
    for (let i = 0; i < 29; i++) {
      const x = 170 + off + i * 44;
      if (x > 1440) break;
      vents += `<rect x="${x}" y="${78 + r * 46}" width="32" height="24" rx="8" fill="#08090a"/>`;
      vents += `<rect x="${x}" y="${100 + r * 46}" width="32" height="3" rx="1.5" fill="#6a6d72" opacity=".45"/>`;
    }
  }
  b += `<svg class="abs" style="left:0;top:0" width="${ROUTER_W}" height="${ROUTER_H}">${vents}</svg>`;
  // 양각 브랜드
  b += text(180, 290, "NETIS", 58, "#34373b", FONT_SANS, "font-weight:bold;letter-spacing:6px;text-shadow:0 -2px 1px rgba(0,0,0,.8),0 2px 1px rgba(255,255,255,.12)");
  b += text(420, 306, "AX3000 Wi-Fi 6 Router", 30, "#8a8e94", FONT_SANS, "letter-spacing:2px");
  b += text(1090, 306, "Made in Korea", 26, "#6e7277", FONT_SANS, "letter-spacing:3px");

  // 포트 패널 (움푹 들어간 판)
  b += `<div class="abs" style="left:40px;top:360px;width:1520px;height:300px;border-radius:14px;background:linear-gradient(180deg,#1c1d1f,#232427 20%,#1f2022);
box-shadow:inset 0 6px 10px rgba(0,0,0,.85), 0 2px 0 rgba(255,255,255,.08)"></div>`;
  b += noise({ freq: 0.7, octaves: 2, seed: 23, opacity: 0.15, x: 40, y: 360, w: 1520, h: 300, radius: 14, contrast: 1.4 });

  const cy = 480;
  const label = (cx: number, s: string, size = 26, color = "#d9dcdf", font = FONT_SANS) =>
    `<div class="abs" style="left:${cx - 100}px;top:${cy + 70}px;width:200px;text-align:center;font-family:${font};font-size:${size}px;color:${color};font-weight:bold;letter-spacing:1px">${s}</div>`;

  b += smaAntenna("antL", 110, cy);
  b += smaAntenna("antR", 1490, cy);

  // DC 잭
  b += `<div class="abs" data-lm="dc" style="left:${215 - 34}px;top:${cy - 34}px;width:68px;height:68px;border-radius:50%;
background:radial-gradient(circle at 50% 50%,#000 0 38%,#2f3134 40%,#6f7378 55%,#2a2c2f 72%);box-shadow:0 2px 4px #000"></div>
<div class="abs" style="left:${215 - 7}px;top:${cy - 7}px;width:14px;height:14px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff,#9aa0a6 60%,#555)"></div>`;
  b += label(215, "DC 12V", 20);
  b += `<svg class="abs" style="left:${215 - 48}px;top:${cy + 102}px" width="96" height="26" viewBox="0 0 96 26">
<circle cx="12" cy="13" r="8" fill="none" stroke="#bfc3c7" stroke-width="2.5"/><path d="M8 13 H16" stroke="#bfc3c7" stroke-width="2.5"/>
<path d="M22 13 H36 M60 13 H74" stroke="#bfc3c7" stroke-width="2.5"/><path d="M50 5 A8 8 0 1 0 50 21" fill="none" stroke="#bfc3c7" stroke-width="2.5"/><circle cx="48" cy="13" r="2.5" fill="#bfc3c7"/>
<circle cx="84" cy="13" r="8" fill="none" stroke="#bfc3c7" stroke-width="2.5"/><path d="M80 13 H88 M84 9 V17" stroke="#bfc3c7" stroke-width="2.5"/></svg>`;

  // 전원 스위치 (로커)
  b += `<div class="abs" data-lm="power" style="left:${322 - 30}px;top:${cy - 44}px;width:60px;height:88px;border-radius:8px;background:#0d0e0f;box-shadow:inset 0 0 0 4px #3a3d41"></div>
<div class="abs" style="left:${322 - 22}px;top:${cy - 36}px;width:44px;height:72px;border-radius:5px;background:linear-gradient(180deg,#4b4f54 0%,#2b2d30 48%,#1a1b1d 52%,#26282b 100%)"></div>`;
  b += text(322 - 6, cy - 30, "I", 22, "#e6e8ea", FONT_SANS, "font-weight:bold");
  b += text(322 - 9, cy + 8, "O", 22, "#8b9095", FONT_SANS, "font-weight:bold");
  b += label(322, "POWER", 18);

  // 리셋 구멍
  b += `<div class="abs" data-lm="reset" style="left:${418 - 11}px;top:${cy - 11}px;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle,#000 0 45%,#4d5055 60%,#1f2022 80%)"></div>`;
  b += label(418, "RESET", 18, "#e04b3e");

  // USB
  b += `<div class="abs" data-lm="usb" style="left:${520 - 42}px;top:${cy - 20}px;width:84px;height:40px;border-radius:3px;background:linear-gradient(180deg,#eef0f2,#a3a8ae 50%,#d3d6d9);box-shadow:0 2px 3px #000"></div>
<div class="abs" style="left:${520 - 36}px;top:${cy - 14}px;width:72px;height:28px;background:#050505"></div>
<div class="abs" style="left:${520 - 32}px;top:${cy - 12}px;width:64px;height:12px;background:linear-gradient(180deg,#3b76d6,#1f4fa1)"></div>`;
  b += label(520, "USB 3.0", 22);

  // WAN (파란 인서트 + 파란 밑줄)
  b += rj45("wan", 680, cy, "#1c3f8f");
  b += label(680, "WAN", 30, "#6fa4ff");
  b += `<div class="abs" style="left:${680 - 52}px;top:${cy + 108}px;width:104px;height:6px;border-radius:3px;background:#3f7ae0"></div>`;
  b += text(680 - 34, cy - 88, "인터넷", 26, "#9fc0ff", FONT_KO);

  // LAN 1~4 (완전히 같은 모양)
  const lanX = [850, 1000, 1150, 1300];
  lanX.forEach((x, i) => {
    b += rj45(`lan${i + 1}`, x, cy, "#1a1b1c");
    b += label(x, `${i + 1}`, 28);
  });
  // LAN 괄호 줄
  b += `<div class="abs" style="left:${lanX[0] - 52}px;top:${cy + 112}px;width:${lanX[3] - lanX[0] + 104}px;height:14px;border:3px solid #cfd2d6;border-top:none"></div>`;
  b += `<div class="abs" style="left:${(lanX[0] + lanX[3]) / 2 - 40}px;top:${cy + 122}px;width:80px;height:34px;background:#1f2022;text-align:center;font-family:${FONT_SANS};font-size:26px;font-weight:bold;color:#cfd2d6">LAN</div>`;
  b += text(lanX[0] - 40, cy - 88, "내부 네트워크 (PC·TV)", 24, "#aeb2b7", FONT_KO);

  // 바닥 고무발 그림자, 모서리 선
  b += `<div class="abs" style="left:0;top:${ROUTER_H - 26}px;width:${ROUTER_W}px;height:3px;background:rgba(255,255,255,.12)"></div>`;
  b += noise({ freq: 0.02, octaves: 3, seed: 24, opacity: 0.1, w: ROUTER_W, h: ROUTER_H, blend: "soft-light" });
  return page(ROUTER_W, ROUTER_H, b);
}
