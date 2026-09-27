import type { GrayImage } from "../types";

/**
 * RGBA(캔버스 getImageData) → 8비트 그레이 (BT.601 근사, 정수 연산).
 * out을 넘기면 재사용한다 (프레임마다 할당하지 않기 위해).
 */
export function rgbaToGray(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  out?: Uint8Array,
): GrayImage {
  const n = width * height;
  const data = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // (77R + 150G + 29B) / 256
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { width, height, data };
}
