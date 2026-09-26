// (f) 제품 명판 스티커: 촘촘한 작은 글씨 표, KC 마크, 바코드, QR
import { FONT_KO, FONT_MONO, FONT_SANS, Rng, barcode, kcMark, noise, page, qrCode, text } from "./common";

export const NAMEPLATE_W = 1600;
export const NAMEPLATE_H = 1200;

export function nameplateHtml(): string {
  const rng = new Rng(6006);
  let b = "";
  // 제품 외장 (베이지 도장)
  b += `<div class="abs" style="left:0;top:0;width:${NAMEPLATE_W}px;height:${NAMEPLATE_H}px;background:linear-gradient(180deg,#e2dccf,#d6cfbf)"></div>`;
  b += noise({ freq: 0.7, octaves: 3, seed: 61, opacity: 0.16, w: NAMEPLATE_W, h: NAMEPLATE_H, contrast: 1.3 });
  // 스티커 (은백색, 얇은 그림자)
  const sx = 60;
  const sy = 60;
  const sw = NAMEPLATE_W - 120;
  const sh = NAMEPLATE_H - 120;
  b += `<div class="abs" style="left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px;border-radius:18px;
background:linear-gradient(160deg,#fbfbf9 0%,#eeefec 50%,#e3e4e1 100%);box-shadow:0 3px 3px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.15)"></div>`;
  b += noise({ freq: [0.02, 0.6], octaves: 2, seed: 62, opacity: 0.08, x: sx, y: sy, w: sw, h: sh, radius: 18 });
  b += `<div class="abs" style="left:${sx + 16}px;top:${sy + 16}px;width:${sw - 32}px;height:${sh - 32}px;border-radius:10px;border:4px solid #1e1e1e"></div>`;

  // 머리글
  b += `<div class="abs" data-lm="brand" style="left:100px;top:96px;width:330px;height:84px"></div>`;
  b += text(104, 100, "SUNGWON", 66, "#16306b", FONT_SANS, "font-weight:bold;letter-spacing:-1px");
  b += text(520, 116, "전기온수기 (저장식)", 46, "#111", FONT_KO, "font-weight:bold");
  b += `<div class="abs" style="left:1210px;top:100px;width:290px;height:76px;border:4px solid #111;text-align:center;font-family:${FONT_KO};font-size:44px;line-height:68px;font-weight:bold">정격 명판</div>`;
  b += `<div class="abs" style="left:76px;top:200px;width:${NAMEPLATE_W - 152}px;height:4px;background:#1e1e1e"></div>`;

  // 표
  const rows: [string, string, string?][] = [
    ["모 델 명", "SWH-150E", "model"],
    ["정격전압", "단상 220V~ 60Hz", "voltage"],
    ["정격소비전력", "2.5 kW (10.9 A)", "power"],
    ["정격용량", "150 L", undefined],
    ["최고사용압력", "0.6 MPa", undefined],
    ["제조번호", "2408-15E-00173", "serial"],
    ["제조년월", "2024. 08", "date"],
    ["제 조 자", "(주)성원전기 / 대한민국", undefined],
  ];
  const tx = 90;
  const ty = 224;
  const rh = 88;
  rows.forEach(([k, v, lm], i) => {
    const y = ty + i * rh;
    b += `<div class="abs" style="left:${tx}px;top:${y}px;width:310px;height:${rh}px;background:#dfe1de;border-bottom:2px solid #444;border-right:2px solid #444"></div>`;
    b += text(tx + 20, y + 26, k, 34, "#111", FONT_KO, "font-weight:bold");
    b += `<div class="abs" ${lm ? `data-lm="${lm}"` : ""} style="left:${tx + 310}px;top:${y}px;width:680px;height:${rh}px;border-bottom:2px solid #444"></div>`;
    const mono = /[A-Z0-9]/.test(v[0]) && !v.includes("(주)");
    b += text(tx + 336, y + 22, v, mono ? 40 : 38, "#0c0c0c", mono ? FONT_MONO : FONT_KO, mono ? "font-weight:bold" : "");
  });

  // 오른쪽 열: KC 마크, 인증번호, QR, 바코드
  b += `<div class="abs" data-lm="kc" style="left:1130px;top:236px;width:160px;height:160px"></div>`;
  b += kcMark(1130, 236, 160);
  b += `<svg class="abs" style="left:1320px;top:246px" width="150" height="150" viewBox="0 0 100 100">
<g fill="none" stroke="#111" stroke-width="7"><path d="M50 12 L66 40 M50 12 L34 40"/><path d="M84 70 L52 70 M84 70 L70 44"/><path d="M16 70 L30 44 M16 70 L46 70"/></g>
<path d="M50 4 L58 18 H42 Z M92 76 L78 80 L84 66 Z M8 76 L16 64 L22 80 Z" fill="#111"/></svg>`;
  b += text(1124, 410, "안전인증번호", 26, "#111", FONT_KO);
  b += text(1124, 442, "SU05123-24001A", 26, "#111", FONT_MONO);
  b += `<div class="abs" data-lm="qr" style="left:1140px;top:490px;width:240px;height:240px"></div>`;
  b += qrCode(rng, 1140, 490, 240, 25);
  b += text(1392, 560, "사용", 24, "#222", FONT_KO);
  b += text(1392, 590, "설명서", 24, "#222", FONT_KO);
  b += `<div class="abs" data-lm="barcode" style="left:1110px;top:760px;width:400px;height:150px"></div>`;
  b += barcode(rng, 1110, 760, 400, 150, "8801234 567892");

  // 경고문 (작고 촘촘한 글씨)
  b += `<div class="abs" style="left:76px;top:950px;width:${NAMEPLATE_W - 152}px;height:4px;background:#1e1e1e"></div>`;
  b += text(96, 968, "⚠ 주의", 30, "#b0150c", FONT_KO, "font-weight:bold");
  const warn = [
    "· 설치 및 배관 공사는 반드시 전문 기사에게 의뢰하십시오. 접지 공사를 하지 않으면 감전의 위험이 있습니다.",
    "· 점검·청소 시에는 전원 플러그를 뽑거나 누전차단기를 내린 후 작업하십시오. 동결 우려 시 배수하십시오.",
    "· 안전밸브에서 물이 떨어지는 것은 정상입니다. 배수관을 막지 마십시오.   고객센터 1588-0000",
  ];
  warn.forEach((w, i) => {
    b += text(96, 1010 + i * 34, w, 24, "#222", FONT_KO);
  });
  b += noise({ freq: 0.012, octaves: 2, seed: 63, opacity: 0.1, w: NAMEPLATE_W, h: NAMEPLATE_H, blend: "soft-light" });
  return page(NAMEPLATE_W, NAMEPLATE_H, b);
}
