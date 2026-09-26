// PNG 쓰기 + 점검용 주석 그리기 (선, 원, 십자, 다각형, 작은 비트맵 글꼴)
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { GrayImage, Point } from "../../src/lib/tracking/types";

export type RGB = [number, number, number];

/** RGB 캔버스 (정수 배율 확대 지원) */
export class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  static fromGray(img: GrayImage, scale = 1): Canvas {
    const c = new Canvas(img.width * scale, img.height * scale);
    for (let y = 0; y < c.height; y++) {
      const sy = Math.floor(y / scale);
      for (let x = 0; x < c.width; x++) {
        const v = img.data[sy * img.width + Math.floor(x / scale)];
        const j = (y * c.width + x) * 4;
        c.data[j] = v;
        c.data[j + 1] = v;
        c.data[j + 2] = v;
        c.data[j + 3] = 255;
      }
    }
    return c;
  }

  static fromPlanes(w: number, h: number, planes: Uint8Array[]): Canvas {
    const c = new Canvas(w, h);
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      c.data[j] = planes[0][i];
      c.data[j + 1] = planes[planes.length > 1 ? 1 : 0][i];
      c.data[j + 2] = planes[planes.length > 2 ? 2 : 0][i];
      c.data[j + 3] = 255;
    }
    return c;
  }

  set(x: number, y: number, c: RGB, a = 1): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const j = (y * this.width + x) * 4;
    this.data[j] = this.data[j] * (1 - a) + c[0] * a;
    this.data[j + 1] = this.data[j + 1] * (1 - a) + c[1] * a;
    this.data[j + 2] = this.data[j + 2] * (1 - a) + c[2] * a;
  }

  line(a: Point, b: Point, c: RGB, width = 1): void {
    const n = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))) + 1;
    if (!Number.isFinite(n) || n > 20000) return;
    const r = (width - 1) / 2;
    for (let i = 0; i <= n; i++) {
      const x = a.x + ((b.x - a.x) * i) / n;
      const y = a.y + ((b.y - a.y) * i) / n;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.set(x + dx, y + dy, c);
    }
  }

  poly(pts: Point[], c: RGB, width = 1): void {
    for (let i = 0; i < pts.length; i++) this.line(pts[i], pts[(i + 1) % pts.length], c, width);
  }

  circle(p: Point, r: number, c: RGB, width = 1): void {
    const n = Math.max(16, Math.ceil(r * 7));
    let prev: Point | null = null;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) };
      if (prev) this.line(prev, q, c, width);
      prev = q;
    }
  }

  cross(p: Point, r: number, c: RGB, width = 1): void {
    this.line({ x: p.x - r, y: p.y }, { x: p.x + r, y: p.y }, c, width);
    this.line({ x: p.x, y: p.y - r }, { x: p.x, y: p.y + r }, c, width);
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(this.width, x + w); i++) this.set(i, j, c, a);
    }
  }

  /** 5x7 비트맵 글꼴 (대문자·숫자·몇몇 기호) */
  text(x: number, y: number, s: string, c: RGB, scale = 1, bg?: RGB): void {
    if (bg) this.fillRect(x - scale, y - scale, s.length * 6 * scale + scale, 9 * scale, bg, 0.75);
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT["?"];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if ((g[row] >> (4 - col)) & 1) this.fillRect(cx + col * scale, y + row * scale, scale, scale, c);
        }
      }
      cx += 6 * scale;
    }
  }

  writePng(file: string): void {
    const png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.length);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG.sync.write(png));
  }
}

export function writeGrayPng(file: string, img: GrayImage, scale = 1): void {
  Canvas.fromGray(img, scale).writePng(file);
}

// 5x7 글꼴: 행마다 5비트
const FONT: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "?": [14, 17, 1, 2, 4, 0, 4],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  ".": [0, 0, 0, 0, 0, 12, 12],
  ":": [0, 12, 12, 0, 12, 12, 0],
  "-": [0, 0, 0, 31, 0, 0, 0],
  "+": [0, 4, 4, 31, 4, 4, 0],
  "/": [1, 1, 2, 4, 8, 16, 16],
  "%": [24, 25, 2, 4, 8, 19, 3],
  "=": [0, 0, 31, 0, 31, 0, 0],
  "#": [10, 10, 31, 10, 31, 10, 10],
  "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8],
  _: [0, 0, 0, 0, 0, 0, 31],
  ">": [8, 4, 2, 1, 2, 4, 8],
  "<": [2, 4, 8, 16, 8, 4, 2],
};
