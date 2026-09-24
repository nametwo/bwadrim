// 입체(부조): 키·버튼·포트가 판 평면에서 2~6mm 튀어나오거나 들어간다. 텍스처 위 높이 지도(텍셀 해상도)로 두고
// 렌더러가 픽셀마다 광선을 따라가 첫 표면(윗면·바닥·옆벽)을 찾는다 → 시점에 따라 시차·가림·옆벽이 생긴다.
//
// 높이는 +가 카메라 쪽(돌출), −가 안쪽(함몰). 월드 좌표에서 표면 z = −h (대상 평면 Z=0, 카메라는 Z<0).
// 상자 목록은 칠하는 순서 — 나중 상자가 앞 상자를 덮는다 (예: 차단기 몸체 +3mm 위에 레버 +6mm).
import type { TextureId } from "./textures";

export interface ReliefBox {
  /** 텍스처 픽셀 (좌상단, 가장자리 규약) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 모서리 반경 (px). ellipse면 무시 */
  r?: number;
  ellipse?: boolean;
  /** 높이 mm (+돌출, −함몰) — 판 평면 기준 절대값 */
  mm: number;
}

const circle = (cx: number, cy: number, r: number, mm: number): ReliefBox => ({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, ellipse: true, mm });

function posRelief(): ReliefBox[] {
  const b: ReliefBox[] = [];
  b.push({ x: 80, y: 80, w: 850, h: 400, r: 26, mm: -1.5 }); // LCD 창 (베젤 안으로)
  for (const x of [90, 270, 450, 630]) b.push({ x, y: 530, w: 150, h: 64, r: 22, mm: 2.5 }); // F1~F4
  b.push({ x: 810, y: 530, w: 190, h: 64, r: 22, mm: 2.5 }); // 메뉴
  for (const y of [630, 760, 890, 1020]) for (const x of [90, 320, 550]) b.push({ x, y, w: 200, h: 108, r: 22, mm: 3 }); // 숫자 키
  b.push({ x: 800, y: 630, w: 200, h: 108, r: 22, mm: 3 }); // 취소
  b.push({ x: 800, y: 760, w: 200, h: 108, r: 22, mm: 3 }); // 정정
  b.push({ x: 800, y: 890, w: 200, h: 238, r: 22, mm: 3 }); // 확인
  b.push({ x: 1060, y: 520, w: 470, h: 610, r: 30, mm: 1.5 }); // 프린터 덮개
  b.push({ x: 1100, y: 548, w: 390, h: 22, r: 11, mm: -3.5 }); // 영수증 배출구
  b.push({ x: 230, y: 1150, w: 560, h: 30, r: 15, mm: -6 }); // IC 슬롯
  return b;
}

function routerRelief(): ReliefBox[] {
  const b: ReliefBox[] = [];
  const cy = 480;
  b.push({ x: 40, y: 360, w: 1520, h: 300, r: 14, mm: -2 }); // 포트 패널 (움푹)
  b.push(circle(110, cy, 40, 6)); // 안테나 커넥터 (육각 너트)
  b.push(circle(1490, cy, 40, 6));
  b.push(circle(215, cy, 34, -2.5)); // DC 잭 테두리
  b.push(circle(215, cy, 13, -6)); // DC 잭 구멍
  b.push(circle(215, cy, 5, -3)); // 가운데 핀
  b.push({ x: 292, y: cy - 44, w: 60, h: 88, r: 8, mm: -1 }); // 로커 스위치 틀
  b.push({ x: 300, y: cy - 36, w: 44, h: 72, r: 5, mm: 1.5 }); // 로커
  b.push(circle(418, cy, 6, -5)); // 리셋 구멍
  b.push({ x: 484, y: cy - 14, w: 72, h: 28, mm: -6 }); // USB 구멍
  b.push({ x: 488, y: cy - 12, w: 64, h: 12, mm: -4 }); // USB 혀
  for (const x of [680, 850, 1000, 1150, 1300]) {
    // RJ45: 구멍(82x58 + 아래 걸쇠 홈 30x18), 패널보다 4mm 더 깊게
    b.push({ x: x - 41, y: cy - 37, w: 82, h: 58, mm: -6 });
    b.push({ x: x - 15, y: cy + 21, w: 30, h: 18, mm: -6 });
  }
  return b;
}

function boilerRelief(): ReliefBox[] {
  const b: ReliefBox[] = [];
  b.push({ x: 190, y: 170, w: 1220, h: 480, r: 30, mm: 1 }); // LCD 베젤
  b.push({ x: 222, y: 202, w: 1156, h: 416, r: 14, mm: 0 }); // LCD 유리 (본체와 같은 높이)
  for (const x of [250, 480, 710, 940, 1170]) {
    b.push(circle(x, 790, 88, -1)); // 버튼 홈
    b.push(circle(x, 790, 78, 2.5)); // 둥근 버튼
  }
  b.push({ x: 1330, y: 670, w: 170, h: 330, r: 85, mm: -1 }); // ▲▼ 홈
  b.push({ x: 1342, y: 682, w: 146, h: 150, r: 40, mm: 2.5 }); // ▲
  b.push({ x: 1342, y: 838, w: 146, h: 150, r: 40, mm: 2.5 }); // ▼
  return b;
}

function breakerRelief(): ReliefBox[] {
  const b: ReliefBox[] = [];
  for (const [x, y] of [
    [70, 70],
    [1530, 70],
    [70, 1130],
    [1530, 1130],
    [160, 360],
    [1450, 360],
  ])
    b.push(circle(x, y, x === 160 || x === 1450 ? 13 : 20, 1.5)); // 나사 머리
  b.push({ x: 110, y: 400, w: 1390, h: 410, r: 8, mm: -6 }); // 차단기 창 (뒤는 DIN 레일)
  // 주 누전차단기
  b.push({ x: 140, y: 420, w: 260, h: 370, r: 8, mm: 3 });
  b.push({ x: 220, y: 520, w: 100, h: 170, r: 8, mm: 1.5 });
  b.push({ x: 232, y: 528, w: 76, h: 96, r: 6, mm: 6 });
  b.push(circle(188, 592, 22, 4.5)); // TEST 버튼
  // 분기 차단기 8개: 몸체 +3, 레버 홈 +1.5, 레버 +6
  for (let i = 0; i < 8; i++) {
    const x = 450 + i * 128;
    b.push({ x, y: 440, w: 118, h: 330, r: 6, mm: 3 });
    b.push({ x: x + 24, y: 526, w: 70, h: 174, r: 6, mm: 1.5 });
    b.push({ x: x + 36, y: 536, w: 46, h: 92, r: 5, mm: 6 });
  }
  return b;
}

function applianceRelief(): ReliefBox[] {
  return [{ x: 0, y: 879, w: 1600, h: 6, mm: -1.5 }]; // 문 이음매 홈
}

/** 기존(개발용) 텍스처의 부조. HTML 레이아웃 상수를 그대로 옮겼다. 명판은 스티커라 평평하다 */
export const BASE_RELIEF: Partial<Record<TextureId, () => ReliefBox[]>> = {
  pos: posRelief,
  router: routerRelief,
  boiler: boilerRelief,
  breaker: breakerRelief,
  appliance: applianceRelief,
};

// ───────────────────────── 높이 지도 ─────────────────────────

export interface ReliefMap {
  /** 텍셀 격자 = 텍스처 크기 */
  w: number;
  h: number;
  /** 높이 (평면 단위 = 텍셀, +돌출) */
  hgt: Float32Array;
  /** 가장 가까운 '높이≠0' 텍셀까지 거리 (텍셀, 체임퍼 근사) */
  dist: Float32Array;
  /** 평면 단위 */
  hMax: number;
  hMin: number;
  /** 입력 상자 (진단용) */
  boxes: ReliefBox[];
}

function inside(bx: ReliefBox, px: number, py: number): boolean {
  if (bx.ellipse) {
    const rx = bx.w / 2;
    const ry = bx.h / 2;
    const dx = (px - bx.x - rx) / rx;
    const dy = (py - bx.y - ry) / ry;
    return dx * dx + dy * dy <= 1;
  }
  const r = Math.min(bx.r ?? 0, bx.w / 2, bx.h / 2);
  const qx = Math.abs(px - bx.x - bx.w / 2) - (bx.w / 2 - r);
  const qy = Math.abs(py - bx.y - bx.h / 2) - (bx.h / 2 - r);
  if (qx > r || qy > r) return false;
  if (qx <= 0 || qy <= 0) return true;
  return qx * qx + qy * qy <= r * r;
}

const reliefCache = new Map<string, ReliefMap>();

/** 상자 목록 → 높이 지도. unitsPerMm = 1/mmPerPx, scale = 높이 배율 */
export function buildReliefMap(key: string, boxes: ReliefBox[], w: number, h: number, unitsPerMm: number, scale = 1): ReliefMap {
  const ck = `${key}|${w}x${h}|${unitsPerMm}|${scale}|${boxes.length}`;
  const hit = reliefCache.get(ck);
  if (hit) return hit;
  const hgt = new Float32Array(w * h);
  for (const bx of boxes) {
    const v = bx.mm * unitsPerMm * scale;
    const x0 = Math.max(0, Math.floor(bx.x));
    const x1 = Math.min(w - 1, Math.ceil(bx.x + bx.w));
    const y0 = Math.max(0, Math.floor(bx.y));
    const y1 = Math.min(h - 1, Math.ceil(bx.y + bx.h));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(bx, x + 0.5, y + 0.5)) hgt[y * w + x] = v;
  }
  let hMax = 0;
  let hMin = 0;
  for (let i = 0; i < hgt.length; i++) {
    if (hgt[i] > hMax) hMax = hgt[i];
    if (hgt[i] < hMin) hMin = hgt[i];
  }
  // 체임퍼(3-4) 거리 변환
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < dist.length; i++) dist[i] = hgt[i] !== 0 ? 0 : INF;
  const a = 1;
  const d = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = dist[i];
      if (x > 0) v = Math.min(v, dist[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, dist[i - w] + a);
        if (x > 0) v = Math.min(v, dist[i - w - 1] + d);
        if (x < w - 1) v = Math.min(v, dist[i - w + 1] + d);
      }
      dist[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = dist[i];
      if (x < w - 1) v = Math.min(v, dist[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, dist[i + w] + a);
        if (x < w - 1) v = Math.min(v, dist[i + w + 1] + d);
        if (x > 0) v = Math.min(v, dist[i + w - 1] + d);
      }
      dist[i] = v;
    }
  }
  const m: ReliefMap = { w, h, hgt, dist, hMax, hMin, boxes };
  if (reliefCache.size > 16) reliefCache.clear();
  reliefCache.set(ck, m);
  return m;
}

/** (u,v) 텍스처 좌표의 높이 (평면 단위). 텍스처 밖이면 −∞ (표면 없음 → 배경) */
export function heightAt(R: ReliefMap, u: number, v: number): number {
  if (!(u >= 0 && v >= 0 && u < R.w && v < R.h)) return -Infinity;
  return R.hgt[(v | 0) * R.w + (u | 0)];
}

export interface ReliefHit {
  u: number;
  v: number;
  /** 표면 z (월드, = −높이) */
  z: number;
  /** 옆벽에 맞음 */
  wall: boolean;
}

/**
 * 월드 광선(원점 C, 방향 d, dz>0)과 부조 표면의 첫 교점. 대상 텍스처 밖이면 false (→ 배경).
 * 평평한 곳(거리 지도로 판정)은 바로 z=0 교점. 아니면 z = −hMax…−hMin 구간을 1.5텍셀 간격으로 걷고 이분법으로 다듬는다.
 */
export function traceRelief(
  R: ReliefMap,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
  out: ReliefHit,
): boolean {
  if (!(dz > 1e-12)) return false;
  const kx = dx / dz;
  const ky = dy / dz;
  const u0 = cx - cz * kx;
  const v0 = cy - cz * ky;
  const zTop = -R.hMax;
  const zBot = -R.hMin;
  const slope = Math.sqrt(kx * kx + ky * ky);
  const Lh = slope * (zBot - zTop);
  if (u0 >= 0 && v0 >= 0 && u0 < R.w && v0 < R.h) {
    if (R.dist[(v0 | 0) * R.w + (u0 | 0)] > Lh + 2) {
      out.u = u0;
      out.v = v0;
      out.z = 0;
      out.wall = false;
      return true;
    }
  } else if (Lh < 1) {
    return false;
  }
  const n = Math.max(1, Math.ceil(Lh / 1.5));
  const step = (zBot - zTop) / n;
  let za = zTop;
  for (let j = 0; j <= n; j++) {
    const z = zTop + j * step;
    const u = cx + (z - cz) * kx;
    const v = cy + (z - cz) * ky;
    const hs = heightAt(R, u, v);
    if (hs === -Infinity) {
      za = z;
      continue;
    }
    if (z < -hs - 1e-9) {
      za = z;
      continue;
    }
    if (j === 0) {
      out.u = u;
      out.v = v;
      out.z = -hs;
      out.wall = false;
      return true;
    }
    // 이분법: za(표면 위) ~ zb(표면 아래)
    let zb = z;
    for (let it = 0; it < 10; it++) {
      const zm = 0.5 * (za + zb);
      const hm = heightAt(R, cx + (zm - cz) * kx, cy + (zm - cz) * ky);
      if (hm !== -Infinity && zm >= -hm - 1e-9) zb = zm;
      else za = zm;
    }
    const ub = cx + (zb - cz) * kx;
    const vb = cy + (zb - cz) * ky;
    const hb = heightAt(R, ub, vb);
    const zf = -hb;
    if (zf >= za - 1e-6) {
      // 면(윗면·바닥)을 z = −hb에서 뚫음
      out.u = cx + (zf - cz) * kx;
      out.v = cy + (zf - cz) * ky;
      out.z = zf;
      out.wall = false;
    } else {
      out.u = ub;
      out.v = vb;
      out.z = zb;
      out.wall = true;
    }
    return true;
  }
  return false;
}

/**
 * 표면 점(u,v,높이 hh)이 더 높은 부조에 가려 그늘지는 정도 (0 = 빛, 1 = 완전 그늘).
 * 광원 쪽(−L)으로 올라가며 4점 확인.
 */
export function reliefShadow(R: ReliefMap, u: number, v: number, hh: number, lx: number, ly: number, lz: number): number {
  const rise = R.hMax - hh;
  if (rise <= 1e-6) return 0;
  const sx = lx / lz;
  const sy = ly / lz;
  const reach = rise * Math.sqrt(sx * sx + sy * sy);
  if (u >= 0 && v >= 0 && u < R.w && v < R.h && R.dist[(v | 0) * R.w + (u | 0)] > reach + 1.5) return 0;
  let blocked = 0;
  for (let i = 1; i <= 4; i++) {
    const dzu = (rise * i) / 4;
    const hb = heightAt(R, u - dzu * sx, v - dzu * sy);
    if (hb >= hh + dzu - 1e-6) blocked++;
  }
  return blocked / 4;
}
