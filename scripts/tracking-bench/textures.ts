// 평면 대상·배경 텍스처: HTML/CSS/SVG를 Playwright Chromium으로 PNG 렌더 → .cache/textures/ 캐시.
// 텍스처는 선형광(linear light) float 밉맵으로 올려 렌더러가 쓴다.
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { sourceHash } from "./codehash";
import { type PhotoizeOpts, photoize } from "./photoize";
import type { ReliefBox } from "./relief";
import { hashString } from "./rng";
import { applianceHtml, APPLIANCE_H, APPLIANCE_W } from "./html/appliance";
import { BG_H, BG_W, deskHtml, wallHtml } from "./html/background";
import { boilerHtml, BOILER_H, BOILER_W } from "./html/boiler";
import { breakerHtml, BREAKER_H, BREAKER_W } from "./html/breaker";
import { nameplateHtml, NAMEPLATE_H, NAMEPLATE_W } from "./html/nameplate";
import { posHtml, POS_H, POS_W } from "./html/pos";
import { routerHtml, ROUTER_H, ROUTER_W } from "./html/router";
import {
  HANDHELD_H,
  HANDHELD_W,
  METAL_H,
  METAL_W,
  ONT_H,
  ONT_W,
  PANEL2_H,
  PANEL2_W,
  THERMO_H,
  THERMO_W,
  WASHER_H,
  WASHER_W,
  handheldHtml,
  metalPlateHtml,
  ontHtml,
  panel2Html,
  thermoHtml,
  washerHtml,
} from "./html/holdout";

export const BENCH_DIR = __dirname;
export const CACHE_DIR = path.join(BENCH_DIR, ".cache");
export const TEXTURE_DIR = path.join(CACHE_DIR, "textures");
/** 렌더 방식이 바뀌면 올린다 (캐시 무효화) */
const TEXTURE_VERSION = 2;

/** 개발용 대상 */
export type BaseTargetId = "pos" | "router" | "boiler" | "breaker" | "appliance" | "nameplate";
/** 홀드아웃 전용 대상 (html/holdout.ts, 사진처럼 후처리) — 추적기 개발 중에는 보지 말 것 */
export type HoldoutTargetId = "ont" | "washer" | "thermo" | "handheld" | "panel2" | "metalplate";
export type TargetId = BaseTargetId | HoldoutTargetId;
export type BackgroundId = "wall" | "desk";
export type TextureId = TargetId | BackgroundId;

export interface TextureDef {
  id: TextureId;
  kind: "target" | "background";
  /** 한글 이름 */
  title: string;
  width: number;
  height: number;
  /** 텍스처 1픽셀의 실제 크기(mm) */
  mmPerPx: number;
  html: () => string;
  /** 정반사 광택: 세기(선형광, 1=흰색 가산)와 퍼짐(mm) */
  gloss?: { strength: number; sigmaMm: number };
  /** 뒤 배경 평면까지 깊이(mm, 대상 평면 뒤쪽) — 시차 */
  bgDepthMm?: number;
  background?: BackgroundId;
  /** 사진처럼 후처리 (photoize.ts: 조명 불균일·때·지문·먼지·잡음·JPEG) — 홀드아웃 텍스처 */
  photo?: PhotoizeOpts;
}

export const TEXTURES: Record<TextureId, TextureDef> = {
  pos: {
    id: "pos",
    kind: "target",
    title: "카드 결제 단말기",
    width: POS_W,
    height: POS_H,
    mmPerPx: 0.11,
    html: posHtml,
    gloss: { strength: 0.1, sigmaMm: 25 },
    bgDepthMm: 45,
    background: "desk",
  },
  router: {
    id: "router",
    kind: "target",
    title: "공유기 뒷면",
    width: ROUTER_W,
    height: ROUTER_H,
    mmPerPx: 0.14,
    html: routerHtml,
    bgDepthMm: 120,
    background: "desk",
  },
  boiler: {
    id: "boiler",
    kind: "target",
    title: "보일러 온도조절기",
    width: BOILER_W,
    height: BOILER_H,
    mmPerPx: 0.09,
    html: boilerHtml,
    gloss: { strength: 0.12, sigmaMm: 18 },
    bgDepthMm: 18,
    background: "wall",
  },
  breaker: {
    id: "breaker",
    kind: "target",
    title: "분전반(두꺼비집)",
    width: BREAKER_W,
    height: BREAKER_H,
    mmPerPx: 0.25,
    html: breakerHtml,
    bgDepthMm: 60,
    background: "wall",
  },
  appliance: {
    id: "appliance",
    kind: "target",
    title: "광택 흰 가전 패널",
    width: APPLIANCE_W,
    height: APPLIANCE_H,
    mmPerPx: 0.3,
    html: applianceHtml,
    gloss: { strength: 0.6, sigmaMm: 45 },
    bgDepthMm: 30,
    background: "wall",
  },
  nameplate: {
    id: "nameplate",
    kind: "target",
    title: "제품 명판 스티커",
    width: NAMEPLATE_W,
    height: NAMEPLATE_H,
    mmPerPx: 0.07,
    html: nameplateHtml,
    gloss: { strength: 0.08, sigmaMm: 20 },
    bgDepthMm: 0,
    background: "wall",
  },
  // ───── 홀드아웃 전용 (사진처럼 후처리) ─────
  ont: {
    id: "ont",
    kind: "target",
    title: "광모뎀(ONT) 뒷면 — 노란 LAN 4개",
    width: ONT_W,
    height: ONT_H,
    mmPerPx: 0.13,
    html: ontHtml,
    gloss: { strength: 0.08, sigmaMm: 30 },
    bgDepthMm: 70,
    background: "desk",
    photo: { seed: 1101 },
  },
  washer: {
    id: "washer",
    kind: "target",
    title: "세탁기 조작부 — 다이얼·버튼 줄",
    width: WASHER_W,
    height: WASHER_H,
    mmPerPx: 0.2,
    html: washerHtml,
    gloss: { strength: 0.12, sigmaMm: 40 },
    bgDepthMm: 25,
    background: "wall",
    photo: { seed: 1102, light: 0.18 },
  },
  thermo: {
    id: "thermo",
    kind: "target",
    title: "다른 회사 온도조절기 — 둥근 LCD, 버튼 4개",
    width: THERMO_W,
    height: THERMO_H,
    mmPerPx: 0.085,
    html: thermoHtml,
    gloss: { strength: 0.15, sigmaMm: 22 },
    bgDepthMm: 15,
    background: "wall",
    photo: { seed: 1103, grime: 0.09 },
  },
  handheld: {
    id: "handheld",
    kind: "target",
    title: "휴대형 카드 단말기 — 터치 화면 + 고무 키",
    width: HANDHELD_W,
    height: HANDHELD_H,
    mmPerPx: 0.085,
    html: handheldHtml,
    gloss: { strength: 0.14, sigmaMm: 25 },
    bgDepthMm: 30,
    background: "desk",
    photo: { seed: 1104, prints: 12 },
  },
  panel2: {
    id: "panel2",
    kind: "target",
    title: "다른 분전반 — 2줄, 1P/2P 섞임, 빈 덮개",
    width: PANEL2_W,
    height: PANEL2_H,
    mmPerPx: 0.24,
    html: panel2Html,
    bgDepthMm: 70,
    background: "wall",
    photo: { seed: 1105, light: 0.2, noise: 3 },
  },
  metalplate: {
    id: "metalplate",
    kind: "target",
    title: "가스보일러 금속 명판 — 헤어라인 알루미늄",
    width: METAL_W,
    height: METAL_H,
    mmPerPx: 0.06,
    html: metalPlateHtml,
    gloss: { strength: 0.25, sigmaMm: 18 },
    bgDepthMm: 3,
    background: "wall",
    photo: { seed: 1106 },
  },
  wall: {
    id: "wall",
    kind: "background",
    title: "벽 배경",
    width: BG_W,
    height: BG_H,
    mmPerPx: 0.45,
    html: wallHtml,
  },
  desk: {
    id: "desk",
    kind: "background",
    title: "책상 배경",
    width: BG_W,
    height: BG_H,
    mmPerPx: 0.45,
    html: deskHtml,
  },
};

export const TARGET_IDS: BaseTargetId[] = ["pos", "router", "boiler", "breaker", "appliance", "nameplate"];
export const HOLDOUT_TARGET_IDS: HoldoutTargetId[] = ["ont", "washer", "thermo", "handheld", "panel2", "metalplate"];
/** 기본으로 렌더하는 텍스처 (홀드아웃 전용 제외 — --holdout일 때만 렌더) */
export const ALL_TEXTURE_IDS = (Object.keys(TEXTURES) as TextureId[]).filter((id) => !(HOLDOUT_TARGET_IDS as string[]).includes(id));

/** 시나리오들이 쓰는 텍스처 (대상 + 배경) */
export function texturesFor(scs: { target: TargetId; background?: BackgroundId }[]): TextureId[] {
  const ids = new Set<TextureId>();
  for (const sc of scs) {
    ids.add(sc.target);
    ids.add(sc.background ?? TEXTURES[sc.target].background ?? "wall");
  }
  return [...ids];
}

export interface Landmark {
  /** 중심 (텍스처 픽셀, 가장자리 규약) */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextureMeta {
  id: TextureId;
  width: number;
  height: number;
  mmPerPx: number;
  hash: string;
  landmarks: Record<string, Landmark>;
  /** HTML의 data-relief="mm" 요소에서 모은 부조 상자 (홀드아웃 텍스처). 없으면 relief.ts의 BASE_RELIEF */
  relief?: ReliefBox[];
}

function textureHash(def: TextureDef, html: string): string {
  // 사진 후처리 텍스처는 후처리 코드·설정도 키에 (기존 텍스처의 키는 그대로)
  const photo = def.photo ? `|photo:${JSON.stringify(def.photo)}:${sourceHash(["photoize.ts"])}` : "";
  return hashString(`${TEXTURE_VERSION}|${def.width}x${def.height}|${html}${photo}`).toString(16).padStart(8, "0");
}

function pngPath(id: TextureId): string {
  return path.join(TEXTURE_DIR, `${id}.png`);
}
function metaPath(id: TextureId): string {
  return path.join(TEXTURE_DIR, `${id}.json`);
}

/** 캐시된 텍스처 메타 (없으면 null). ensureTextures()가 최신 상태를 보장한다 */
export function readTextureMeta(id: TextureId): TextureMeta | null {
  return readMeta(id);
}

function readMeta(id: TextureId): TextureMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as TextureMeta;
  } catch {
    return null;
  }
}

/** 원자적 쓰기 (여러 테스트 워커가 동시에 만들어도 깨진 파일이 보이지 않게) */
export function writeFileAtomic(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// page.evaluate에 넘길 코드는 문자열로 (트랜스파일러 헬퍼가 끼어들지 않게)
const LANDMARK_SCRIPT = `(() => {
  const out = {};
  for (const el of Array.from(document.querySelectorAll('[data-lm]'))) {
    const r = el.getBoundingClientRect();
    out[el.getAttribute('data-lm')] = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }
  return out;
})()`;

// 부조: data-relief="mm" 요소의 상자 (+ data-relief-r 모서리 반경, data-relief-shape="ellipse")
const RELIEF_SCRIPT = `(() => {
  const out = [];
  for (const el of Array.from(document.querySelectorAll('[data-relief]'))) {
    const r = el.getBoundingClientRect();
    const b = { x: r.left, y: r.top, w: r.width, h: r.height, mm: parseFloat(el.getAttribute('data-relief')) };
    if (el.getAttribute('data-relief-shape') === 'ellipse') b.ellipse = true;
    const rr = el.getAttribute('data-relief-r');
    if (rr) b.r = parseFloat(rr);
    out.push(b);
  }
  return out;
})()`;

/**
 * 필요한 텍스처가 캐시에 없거나 HTML이 바뀌었으면 Chromium으로 렌더한다.
 * 결과: 각 텍스처의 메타(랜드마크 포함).
 */
export async function ensureTextures(
  ids: readonly TextureId[] = ALL_TEXTURE_IDS,
  opts: { force?: boolean; log?: (s: string) => void } = {},
): Promise<Record<string, TextureMeta>> {
  const out: Record<string, TextureMeta> = {};
  const todo: { def: TextureDef; html: string; hash: string }[] = [];
  for (const id of ids) {
    const def = TEXTURES[id];
    const html = def.html();
    const hash = textureHash(def, html);
    const meta = readMeta(id);
    if (!opts.force && meta && meta.hash === hash && fs.existsSync(pngPath(id))) {
      out[id] = meta;
    } else {
      todo.push({ def, html, hash });
    }
  }
  if (todo.length === 0) return out;

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text"] });
  try {
    for (const { def, html, hash } of todo) {
      const t0 = Date.now();
      const page = await browser.newPage({
        viewport: { width: def.width, height: def.height },
        deviceScaleFactor: 1,
      });
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready.then(() => true)");
      const landmarks = (await page.evaluate(LANDMARK_SCRIPT)) as Record<string, Landmark>;
      const relief = (await page.evaluate(RELIEF_SCRIPT)) as ReliefBox[];
      let png = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: def.width, height: def.height },
      });
      await page.close();
      if (def.photo) {
        const img = PNG.sync.read(png);
        const out = new PNG({ width: img.width, height: img.height });
        out.data = Buffer.from(photoize(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height, def.photo));
        png = PNG.sync.write(out);
      }
      const meta: TextureMeta = {
        id: def.id,
        width: def.width,
        height: def.height,
        mmPerPx: def.mmPerPx,
        hash,
        landmarks,
      };
      if (relief.length) meta.relief = relief;
      writeFileAtomic(pngPath(def.id), png);
      writeFileAtomic(metaPath(def.id), JSON.stringify(meta, null, 1));
      out[def.id] = meta;
      opts.log?.(`텍스처 렌더: ${def.id} (${def.width}x${def.height}) ${Date.now() - t0}ms`);
    }
  } finally {
    await browser.close();
  }
  return out;
}

// ───────────────────────── 밉맵 텍스처 ─────────────────────────

export interface MipLevel {
  w: number;
  h: number;
  data: Float32Array;
}

/** 한 채널의 밉맵. 값은 선형광 [0,1]. 모든 레벨이 flat 한 버퍼에 이어져 있다 (샘플링 속도) */
export interface MipTexture {
  levels: MipLevel[];
  flat: Float32Array;
  off: Int32Array;
  lw: Int32Array;
  lh: Int32Array;
}

export interface Texture {
  id: string;
  width: number;
  height: number;
  /** 1채널(휘도) 또는 3채널(RGB) */
  channels: MipTexture[];
}

/** sRGB 8bit → 선형광 */
export const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

export function buildMip(base: Float32Array, w: number, h: number): MipTexture {
  const dims: [number, number][] = [[w, h]];
  while (dims.length < 14) {
    const [cw, ch] = dims[dims.length - 1];
    if (cw === 1 && ch === 1) break;
    dims.push([Math.max(1, cw >> 1), Math.max(1, ch >> 1)]);
  }
  const off = new Int32Array(dims.length);
  let total = 0;
  dims.forEach(([dw, dh], i) => {
    off[i] = total;
    total += dw * dh;
  });
  const flat = new Float32Array(total);
  flat.set(base, 0);
  const levels: MipLevel[] = [];
  for (let i = 0; i < dims.length; i++) {
    const [dw, dh] = dims[i];
    const d = flat.subarray(off[i], off[i] + dw * dh);
    if (i > 0) {
      const [cw, ch] = dims[i - 1];
      const src = levels[i - 1].data;
      for (let y = 0; y < dh; y++) {
        const y0 = Math.min(ch - 1, 2 * y);
        const y1 = Math.min(ch - 1, 2 * y + 1);
        for (let x = 0; x < dw; x++) {
          const x0 = Math.min(cw - 1, 2 * x);
          const x1 = Math.min(cw - 1, 2 * x + 1);
          d[y * dw + x] = 0.25 * (src[y0 * cw + x0] + src[y0 * cw + x1] + src[y1 * cw + x0] + src[y1 * cw + x1]);
        }
      }
    }
    levels.push({ w: dw, h: dh, data: d });
  }
  return {
    levels,
    flat,
    off,
    lw: Int32Array.from(dims.map((d) => d[0])),
    lh: Int32Array.from(dims.map((d) => d[1])),
  };
}

/** RGBA 8bit (sRGB) → 선형 텍스처. color=false면 휘도 1채널 (BT.601 가중치를 감마 값에 적용 후 선형화) */
export function textureFromRgba(id: string, rgba: Uint8Array, w: number, h: number, color: boolean): Texture {
  const n = w * h;
  if (!color) {
    const lum = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      // cv/color.ts의 rgbaToGray와 같은 가중치
      const g = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) / 256;
      const gi = Math.min(255, Math.floor(g));
      const f = g - gi;
      lum[i] = SRGB_TO_LINEAR[gi] + f * (SRGB_TO_LINEAR[Math.min(255, gi + 1)] - SRGB_TO_LINEAR[gi]);
    }
    return { id, width: w, height: h, channels: [buildMip(lum, w, h)] };
  }
  const ch: MipTexture[] = [];
  for (let c = 0; c < 3; c++) {
    const d = new Float32Array(n);
    for (let i = 0, j = c; i < n; i++, j += 4) d[i] = SRGB_TO_LINEAR[rgba[j]];
    ch.push(buildMip(d, w, h));
  }
  return { id, width: w, height: h, channels: ch };
}

export function readPng(file: string): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

const texCache = new Map<string, Texture>();

/** 캐시된 PNG를 선형 밉맵 텍스처로 (프로세스 안에서 재사용). ensureTextures가 먼저 돌아야 한다 */
export function loadTexture(id: TextureId, color = false): Texture {
  const key = `${id}|${color ? "rgb" : "y"}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const img = readPng(pngPath(id));
  const tex = textureFromRgba(id, img.data, img.width, img.height, color);
  texCache.set(key, tex);
  return tex;
}

export function texturePngPath(id: TextureId): string {
  return pngPath(id);
}
