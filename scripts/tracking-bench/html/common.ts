// 텍스처 HTML 공용 조각. 모든 무작위성은 시드 고정 Rng로 → 같은 HTML → 같은 PNG.
import { Rng, hashString } from "../rng";

export const FONT_KO = "'WenQuanYi Zen Hei', 'Noto Sans CJK KR', 'Unifont', sans-serif";
export const FONT_SANS = "'DejaVu Sans', 'Liberation Sans', 'FreeSans', sans-serif";
export const FONT_NARROW = "'Liberation Sans Narrow', 'Liberation Sans', 'FreeSans', sans-serif";
export const FONT_SERIF = "'Liberation Serif', 'DejaVu Serif', serif";
export const FONT_MONO = "'DejaVu Sans Mono', 'Liberation Mono', monospace";

export interface TextureHtml {
  html: string;
}

export function page(w: number, h: number, body: string, css = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:#777}
*{box-sizing:border-box}
.abs{position:absolute}
.ko{font-family:${FONT_KO}}
.sans{font-family:${FONT_SANS}}
.mono{font-family:${FONT_MONO}}
.serif{font-family:${FONT_SERIF}}
${css}
</style></head><body><div id="root" style="position:relative;width:${w}px;height:${h}px;overflow:hidden">${body}</div></body></html>`;
}

export interface NoiseOpts {
  freq: number | [number, number];
  octaves?: number;
  seed: number;
  opacity: number;
  blend?: string;
  /** 대비 강조 (feComponentTransfer 기울기) */
  contrast?: number;
  x?: number;
  y?: number;
  w: number;
  h: number;
  radius?: number;
  type?: "fractalNoise" | "turbulence";
  /** 색 노이즈 대신 회색 */
  gray?: boolean;
}

/** feTurbulence 노이즈 층 (플라스틱 결, 페인트, 먼지, 나뭇결) */
export function noise(o: NoiseOpts): string {
  // id는 파라미터 해시 — 같은 HTML이 항상 같은 문자열이 되게 (캐시 키)
  const id = `n${hashString(JSON.stringify(o)).toString(36)}`;
  const f = Array.isArray(o.freq) ? `${o.freq[0]} ${o.freq[1]}` : `${o.freq}`;
  const c = o.contrast ?? 1;
  const gray = o.gray ?? true;
  const matrix = gray
    ? `<feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1"/>`
    : "";
  return `<svg class="abs" style="left:${o.x ?? 0}px;top:${o.y ?? 0}px;opacity:${o.opacity};mix-blend-mode:${o.blend ?? "overlay"};border-radius:${o.radius ?? 0}px;overflow:hidden" width="${o.w}" height="${o.h}"><filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="${o.type ?? "fractalNoise"}" baseFrequency="${f}" numOctaves="${o.octaves ?? 3}" seed="${o.seed}" stitchTiles="noStitch"/>${matrix}<feComponentTransfer><feFuncR type="linear" slope="${c}" intercept="${(1 - c) / 2}"/><feFuncG type="linear" slope="${c}" intercept="${(1 - c) / 2}"/><feFuncB type="linear" slope="${c}" intercept="${(1 - c) / 2}"/></feComponentTransfer></filter><rect width="100%" height="100%" filter="url(#${id})"/></svg>`;
}

/** 십자 나사 머리 */
export function screw(x: number, y: number, r: number, rot = 20, tone = "#b9bcc0"): string {
  return `<div class="abs" style="left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;
background:radial-gradient(circle at 35% 30%, #fff 0%, ${tone} 35%, #6d7075 100%);
box-shadow:0 ${r * 0.15}px ${r * 0.3}px rgba(0,0,0,.55), inset 0 0 ${r * 0.2}px rgba(0,0,0,.5)">
<div class="abs" style="left:${r * 0.25}px;top:${r * 0.85}px;width:${r * 1.5}px;height:${r * 0.3}px;background:#44474b;transform:rotate(${rot}deg);border-radius:2px"></div>
<div class="abs" style="left:${r * 0.85}px;top:${r * 0.25}px;width:${r * 0.3}px;height:${r * 1.5}px;background:#44474b;transform:rotate(${rot}deg);border-radius:2px"></div>
</div>`;
}

// 7세그먼트: 세그먼트 a~g 켜짐 표
const SEG: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abdeg",
  "3": "abcdg",
  "4": "bcfg",
  "5": "acdfg",
  "6": "acdefg",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  "-": "g",
  " ": "",
  E: "adefg",
  H: "bcefg",
  L: "def",
  P: "abefg",
  C: "adef",
};

/**
 * 기울어진 7세그먼트 숫자열 (SVG 요소들). 꺼진 세그먼트는 ghost 투명도로 희미하게 (실제 LCD처럼).
 * '.'은 앞 숫자의 소수점.
 */
export function sevenSeg(text: string, x: number, y: number, h: number, color: string, ghost = 0.07): string {
  const w = h * 0.52;
  const t = h * 0.11; // 두께
  const skew = 0.12;
  const gap = h * 0.012;
  let out = "";
  let cx = x;
  const chars = text.split("");
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ".") continue;
    const on = SEG[ch] ?? "";
    const dot = chars[i + 1] === ".";
    const hs = h / 2;
    // 세그먼트 다각형 (육각 막대), 로컬 좌표 → 기울임 적용
    const sk = (px: number, py: number) => `${(cx + px + (h - py) * skew).toFixed(1)},${(y + py).toFixed(1)}`;
    const horiz = (py: number) =>
      [sk(t / 2 + gap, py), sk(t + gap, py - t / 2), sk(w - t - gap, py - t / 2), sk(w - t / 2 - gap, py), sk(w - t - gap, py + t / 2), sk(t + gap, py + t / 2)].join(" ");
    const vert = (px: number, py0: number, py1: number) =>
      [sk(px, py0 + gap), sk(px + t / 2, py0 + t / 2 + gap), sk(px + t / 2, py1 - t / 2 - gap), sk(px, py1 - gap), sk(px - t / 2, py1 - t / 2 - gap), sk(px - t / 2, py0 + t / 2 + gap)].join(" ");
    const segs: Record<string, string> = {
      a: horiz(t / 2),
      g: horiz(hs),
      d: horiz(h - t / 2),
      f: vert(t / 2, t / 2, hs),
      b: vert(w - t / 2, t / 2, hs),
      e: vert(t / 2, hs, h - t / 2),
      c: vert(w - t / 2, hs, h - t / 2),
    };
    for (const k of Object.keys(segs)) {
      const lit = on.includes(k);
      out += `<polygon points="${segs[k]}" fill="${color}" opacity="${lit ? 1 : ghost}"/>`;
    }
    if (dot || ghost > 0) {
      out += `<circle cx="${cx + w + t * 0.6}" cy="${y + h - t / 2}" r="${t * 0.55}" fill="${color}" opacity="${dot ? 1 : ghost}"/>`;
    }
    cx += w + t * 1.8;
  }
  return out;
}

/** 1차원 바코드 (Code128 흉내, 무작위 막대) */
export function barcode(rng: Rng, x: number, y: number, w: number, h: number, caption?: string): string {
  let bars = "";
  let cx = 6;
  const unit = w / 150;
  // 시작/끝 가드 포함 무작위 폭
  while (cx < w - 8) {
    const bw = unit * (1 + rng.int(4));
    const sw = unit * (1 + rng.int(3));
    if (cx + bw > w - 6) break;
    bars += `<rect x="${cx.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${caption ? h - 22 : h}" fill="#111"/>`;
    cx += bw + sw;
  }
  const cap = caption
    ? `<text x="${w / 2}" y="${h - 3}" font-family="${FONT_MONO}" font-size="18" text-anchor="middle" fill="#111">${caption}</text>`
    : "";
  return `<svg class="abs" style="left:${x}px;top:${y}px" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${bars}${cap}</svg>`;
}

/** QR 비슷한 2D 코드 (파인더 패턴 3개 + 무작위 모듈) */
export function qrCode(rng: Rng, x: number, y: number, size: number, n = 25): string {
  const m = size / (n + 2);
  let cells = "";
  const finder = (fx: number, fy: number) => {
    return `<rect x="${(fx + 1) * m}" y="${(fy + 1) * m}" width="${7 * m}" height="${7 * m}" fill="#111"/>
<rect x="${(fx + 2) * m}" y="${(fy + 2) * m}" width="${5 * m}" height="${5 * m}" fill="#fff"/>
<rect x="${(fx + 3) * m}" y="${(fy + 3) * m}" width="${3 * m}" height="${3 * m}" fill="#111"/>`;
  };
  const inFinder = (i: number, j: number) =>
    (i < 8 && j < 8) || (i >= n - 8 && j < 8) || (i < 8 && j >= n - 8);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (inFinder(i, j)) continue;
      if (rng.next() < 0.47) {
        cells += `<rect x="${((i + 1) * m).toFixed(2)}" y="${((j + 1) * m).toFixed(2)}" width="${(m + 0.3).toFixed(2)}" height="${(m + 0.3).toFixed(2)}" fill="#111"/>`;
      }
    }
  }
  return `<svg class="abs" style="left:${x}px;top:${y}px" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/>${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}${cells}</svg>`;
}

/** KC 인증 마크 흉내 */
export function kcMark(x: number, y: number, s: number, color = "#111"): string {
  return `<svg class="abs" style="left:${x}px;top:${y}px" width="${s}" height="${s}" viewBox="0 0 100 100">
<circle cx="50" cy="50" r="46" fill="none" stroke="${color}" stroke-width="7"/>
<path d="M30 25 L30 75 M30 50 L56 25 M36 45 L58 75" stroke="${color}" stroke-width="9" fill="none" stroke-linecap="square"/>
<path d="M82 36 A20 20 0 1 0 82 64" stroke="${color}" stroke-width="8" fill="none"/>
</svg>`;
}

/** 경고 삼각형 (⚡) */
export function warnTriangle(x: number, y: number, s: number): string {
  return `<svg class="abs" style="left:${x}px;top:${y}px" width="${s}" height="${s}" viewBox="0 0 100 100">
<path d="M50 6 L96 90 L4 90 Z" fill="#f7c600" stroke="#111" stroke-width="6" stroke-linejoin="round"/>
<path d="M55 30 L38 62 L51 62 L44 84 L64 52 L51 52 L58 30 Z" fill="#111"/>
</svg>`;
}

/** 텍스트 한 줄 (절대 위치) */
export function text(
  x: number,
  y: number,
  s: string,
  size: number,
  color: string,
  font = FONT_SANS,
  extra = "",
): string {
  return `<div class="abs" style="left:${x}px;top:${y}px;font-family:${font};font-size:${size}px;color:${color};white-space:nowrap;line-height:1;${extra}">${s}</div>`;
}

/** 나뭇결·벽 얼룩 같은 저주파 명암 */
export function blotches(rng: Rng, w: number, h: number, n: number, color: string, maxR: number, opacity: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    const r = maxR * (0.3 + 0.7 * rng.next());
    const x = rng.range(-r, w + r);
    const y = rng.range(-r, h + r);
    s += `<div class="abs" style="left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r * rng.range(0.5, 1.2)}px;border-radius:50%;background:radial-gradient(closest-side, ${color}, transparent);opacity:${(opacity * rng.range(0.4, 1)).toFixed(3)}"></div>`;
  }
  return s;
}

export { Rng };
