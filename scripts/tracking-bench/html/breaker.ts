// (d) 두꺼비집(분전반): 주 누전차단기 + 똑같은 분기 차단기 8개(반복 패턴), 마스킹테이프 손글씨 라벨
import { FONT_KO, FONT_SANS, Rng, noise, page, screw, text, warnTriangle } from "./common";

export const BREAKER_W = 1600;
export const BREAKER_H = 1200;

/** 분기 차단기 1개 — 모두 동일 */
function mcb(lm: string, x: number, y: number): string {
  const w = 118;
  const h = 330;
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:6px;
background:linear-gradient(90deg,#c9c7bf 0%,#f1efe8 18%,#fbfaf5 50%,#ebe9e1 82%,#bfbcb3 100%);
box-shadow:3px 0 4px rgba(0,0,0,.45), -1px 0 2px rgba(0,0,0,.3)"></div>
<div class="abs" style="left:${x + 10}px;top:${y + 20}px;width:${w - 20}px;height:24px;font-family:${FONT_SANS};font-size:22px;font-weight:bold;color:#1a1a1a;text-align:center">C20</div>
<div class="abs" style="left:${x + 12}px;top:${y + 48}px;width:${w - 24}px;font-family:${FONT_SANS};font-size:12px;color:#444;text-align:center;line-height:1.2">220V~ 2P<br>6kA</div>
<div class="abs" style="left:${x + 24}px;top:${y + 86}px;width:${w - 48}px;height:174px;border-radius:6px;background:linear-gradient(180deg,#9d9a91,#dedbd2 20%,#cfccc3 80%,#8f8c84);box-shadow:inset 0 2px 5px rgba(0,0,0,.5)"></div>
<div class="abs" data-lm="${lm}" style="left:${x + 36}px;top:${y + 96}px;width:${w - 72}px;height:92px;border-radius:5px;
background:linear-gradient(180deg,#4a4c50 0%,#2a2b2e 35%,#161718 100%);box-shadow:0 8px 8px rgba(0,0,0,.6), inset 0 2px 1px rgba(255,255,255,.35)"></div>
<div class="abs" style="left:${x + 40}px;top:${y + 196}px;width:${w - 80}px;font-family:${FONT_SANS};font-size:15px;color:#333;text-align:center;font-weight:bold">ON I</div>
<div class="abs" style="left:${x + 40}px;top:${y + 234}px;width:${w - 80}px;font-family:${FONT_SANS};font-size:15px;color:#555;text-align:center">O OFF</div>
<div class="abs" style="left:${x + 46}px;top:${y + 272}px;width:${w - 92}px;height:14px;border-radius:2px;background:#c8352a;box-shadow:inset 0 1px 2px rgba(0,0,0,.5)"></div>
<div class="abs" style="left:${x + 20}px;top:${y + 298}px;width:${w - 40}px;font-family:${FONT_SANS};font-size:11px;color:#666;text-align:center">KS C 8332</div>`;
}

export function breakerHtml(): string {
  const rng = new Rng(4004);
  let b = "";
  // 분전반 속 덮개판(분체도장 회색 철판)
  b += `<div class="abs" style="left:0;top:0;width:${BREAKER_W}px;height:${BREAKER_H}px;background:linear-gradient(175deg,#d9dcdf,#c9cdd1 60%,#bcc0c4)"></div>`;
  b += noise({ freq: 0.6, octaves: 3, seed: 41, opacity: 0.2, w: BREAKER_W, h: BREAKER_H, contrast: 1.3 });
  b += noise({ freq: 0.008, octaves: 3, seed: 42, opacity: 0.16, w: BREAKER_W, h: BREAKER_H, blend: "soft-light" });
  // 판 가장자리 접힘
  b += `<div class="abs" style="left:20px;top:20px;width:${BREAKER_W - 40}px;height:${BREAKER_H - 40}px;border-radius:10px;box-shadow:inset 0 0 0 3px rgba(255,255,255,.45), 0 0 0 3px rgba(0,0,0,.18)"></div>`;
  // 나사 4개 + 창 옆 2개
  b += screw(70, 70, 20, 12);
  b += screw(BREAKER_W - 70, 70, 20, 37);
  b += screw(70, BREAKER_H - 70, 20, 64);
  b += screw(BREAKER_W - 70, BREAKER_H - 70, 20, 5);

  // 상단: 경고 스티커 + 명판
  b += `<div class="abs" data-lm="warning" style="left:130px;top:120px;width:560px;height:200px;border-radius:10px;background:#f6d21d;box-shadow:0 2px 3px rgba(0,0,0,.35)"></div>`;
  b += warnTriangle(150, 135, 160);
  b += text(330, 142, "감전주의", 64, "#111", FONT_KO, "font-weight:bold");
  b += text(330, 222, "점검 시 반드시 주 차단기를", 28, "#222", FONT_KO);
  b += text(330, 260, "내린 후 작업하십시오", 28, "#222", FONT_KO);
  b += `<div class="abs" style="left:960px;top:140px;width:470px;height:150px;border-radius:6px;background:linear-gradient(180deg,#e8e9ea,#c4c7ca);box-shadow:inset 0 0 0 2px #8c9095"></div>`;
  b += text(985, 160, "HANSUNG 분전반", 34, "#1d2a4a", FONT_KO, "font-weight:bold");
  b += text(985, 208, "HS-12  단상 220V  60Hz", 26, "#333", FONT_SANS);
  b += text(985, 246, "주:ELB 32A  분기:C20 × 8", 24, "#333", FONT_KO);

  // 먼지·긁힘
  let sc = "";
  for (let i = 0; i < 40; i++) {
    const x = rng.range(40, BREAKER_W - 40);
    const y = rng.range(40, BREAKER_H - 40);
    const l = rng.range(10, 60);
    const a = rng.range(0, Math.PI);
    sc += `<path d="M${x.toFixed(0)} ${y.toFixed(0)} l${(l * Math.cos(a)).toFixed(0)} ${(l * Math.sin(a)).toFixed(0)}" stroke="#fff" stroke-width="1.5" opacity="${rng.range(0.15, 0.4).toFixed(2)}"/>`;
  }
  b += `<svg class="abs" style="left:0;top:0" width="${BREAKER_W}" height="${BREAKER_H}">${sc}</svg>`;
  // 차단기 창(뚫린 구멍) — 안쪽은 어두운 DIN 레일
  b += `<div class="abs" style="left:110px;top:400px;width:1390px;height:410px;border-radius:8px;background:#1f2123;box-shadow:inset 0 10px 18px #000, 0 2px 0 rgba(255,255,255,.5)"></div>`;
  b += `<div class="abs" style="left:110px;top:590px;width:1390px;height:34px;background:linear-gradient(180deg,#8d9196,#c7cacd 40%,#6e7277)"></div>`;
  // 주 누전차단기 (ELB)
  const ex = 140;
  const ey = 420;
  b += `<div class="abs" data-lm="main" style="left:${ex}px;top:${ey}px;width:260px;height:370px;border-radius:8px;background:linear-gradient(90deg,#3a3d42,#565a60 20%,#5d6167 50%,#4d5156 80%,#34373b);box-shadow:4px 0 6px rgba(0,0,0,.6)"></div>`;
  b += text(ex + 20, ey + 18, "누전차단기", 28, "#f0f0f0", FONT_KO, "font-weight:bold");
  b += text(ex + 20, ey + 56, "ELB 32A 30mA", 20, "#d8d8d8", FONT_SANS);
  b += `<div class="abs" style="left:${ex + 80}px;top:${ey + 100}px;width:100px;height:170px;border-radius:8px;background:#23262a;box-shadow:inset 0 3px 6px #000"></div>`;
  b += `<div class="abs" style="left:${ex + 92}px;top:${ey + 108}px;width:76px;height:96px;border-radius:6px;background:linear-gradient(180deg,#303236,#0e0f10);box-shadow:0 8px 8px rgba(0,0,0,.6), inset 0 2px 1px rgba(255,255,255,.3)"></div>`;
  b += `<div class="abs" style="left:${ex + 26}px;top:${ey + 150}px;width:44px;height:44px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff7a8,#f0cf1c 55%,#a88a05);box-shadow:0 3px 4px rgba(0,0,0,.6)"></div>`;
  b += text(ex + 22, ey + 200, "TEST", 18, "#f3d23a", FONT_SANS, "font-weight:bold");
  b += `<div class="abs" style="left:${ex + 190}px;top:${ey + 150}px;width:40px;height:22px;background:#c3372a;border-radius:3px"></div>`;
  b += text(ex + 190, ey + 176, "ON", 16, "#eee", FONT_SANS);
  b += text(ex + 30, ey + 300, "KS C 4613", 18, "#bbb", FONT_SANS);
  b += text(ex + 30, ey + 328, "정격감도 30mA", 18, "#ccc", FONT_KO);

  // 분기 차단기 8개 — 같은 모양
  const x0 = 450;
  const step = 128;
  for (let i = 0; i < 8; i++) b += mcb(`br${i + 1}`, x0 + i * step, 440);

  // 마스킹테이프 손글씨 라벨 (5번, 7번은 비어 있음)
  const names = ["거실", "주방", "안방", "욕실", "", "에어컨", "", "세탁기"];
  names.forEach((n, i) => {
    if (!n) return;
    const x = x0 + i * step + 4;
    const rot = rng.range(-4, 4);
    b += `<div class="abs" style="left:${x}px;top:${836 + rng.range(-4, 4)}px;width:112px;height:54px;background:linear-gradient(180deg,#efe4c4,#e2d3ab);opacity:.95;transform:rotate(${rot.toFixed(1)}deg);
clip-path:polygon(0 4%,6% 0,15% 5%,28% 0,40% 4%,55% 0,70% 5%,85% 0,100% 4%,98% 50%,100% 96%,85% 100%,70% 95%,55% 100%,40% 96%,25% 100%,10% 95%,0 100%,2% 50%);
font-family:${FONT_KO};font-size:30px;color:#1b2a6b;text-align:center;line-height:54px;font-style:italic">${n}</div>`;
  });
  // 번호 인쇄
  for (let i = 0; i < 8; i++) {
    b += text(x0 + i * step + 50, 912, `${i + 1}`, 22, "#555a60", FONT_SANS);
  }

  // 아래: 통풍 타공 + 로고
  let holes = "";
  for (let j = 0; j < 5; j++) for (let i = 0; i < 28; i++) holes += `<rect x="${i * 40}" y="${j * 30}" width="26" height="12" rx="6" fill="#2a2c2f"/>`;
  b += `<svg class="abs" style="left:250px;top:970px;opacity:.85" width="1120" height="150">${holes}</svg>`;
  b += text(1060, 360, "HANSUNG ELECTRIC", 26, "#6d7278", FONT_SANS, "letter-spacing:3px");
  b += screw(160, 360, 13, 50);
  b += screw(1450, 360, 13, 80);
  return page(BREAKER_W, BREAKER_H, b);
}
