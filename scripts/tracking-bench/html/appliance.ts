// (e) 광택 있는 흰 가전 패널: 거의 무늬 없음 + 작은 로고 하나 (어려운 경우). 정반사는 렌더러가 더한다
import { FONT_SANS, noise, page, text } from "./common";

export const APPLIANCE_W = 1600;
export const APPLIANCE_H = 1200;

export function applianceHtml(): string {
  let b = "";
  b += `<div class="abs" style="left:0;top:0;width:${APPLIANCE_W}px;height:${APPLIANCE_H}px;
background:linear-gradient(178deg,#f8f9f9 0%,#f1f2f2 45%,#e9ebeb 100%)"></div>`;
  b += noise({ freq: 0.9, octaves: 1, seed: 51, opacity: 0.04, w: APPLIANCE_W, h: APPLIANCE_H });
  // 문 이음매
  b += `<div class="abs" data-lm="seam" style="left:0;top:880px;width:${APPLIANCE_W}px;height:3px;background:#c4c8c8"></div>`;
  b += `<div class="abs" style="left:0;top:883px;width:${APPLIANCE_W}px;height:2px;background:#fdfefe"></div>`;
  // 작은 로고
  b += `<div class="abs" data-lm="logo" style="left:730px;top:470px;width:150px;height:40px"></div>`;
  b += text(732, 472, "LUMEN", 34, "#b7bbbc", FONT_SANS, "letter-spacing:6px");
  // 작은 표시등
  b += `<div class="abs" data-lm="led" style="left:1200px;top:930px;width:10px;height:10px;border-radius:50%;background:#a9b3b5"></div>`;
  // 핀 후보: 로고 옆 빈 곳 (표식 없음)
  b += `<div class="abs" data-lm="blank" style="left:980px;top:600px;width:2px;height:2px"></div>`;
  return page(APPLIANCE_W, APPLIANCE_H, b);
}
