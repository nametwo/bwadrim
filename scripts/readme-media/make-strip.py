"""README 정지 화면 묶음: 화면 카탈로그(npm run screens → screens/img) 캡처 몇 장을 캡션과 함께 가로로 붙인다.

쓰는 법: python3 scripts/readme-media/make-strip.py <저장할 png> "<캡션>=<screens/img 파일>" ...
폰 화면은 첫 화면 높이(390×844)로 자르고, PC 화면은 폰 두 대 너비로 줄인다.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
BG = (242, 244, 246)
INK = (51, 61, 75)
PHONE_W, PHONE_H = 300, 649  # 390×844 비율
GAP, PAD, LABEL = 24, 28, 52


def rounded(img: Image.Image, r: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *img.size), r, fill=255)
    out = Image.new("RGB", img.size, BG)
    out.paste(img, mask=mask)
    return out


def tile(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGB")
    if img.width < img.height:  # 폰: 첫 화면만
        img = img.crop((0, 0, img.width, round(img.width * 844 / 390)))
        return rounded(img.resize((PHONE_W, PHONE_H), Image.LANCZOS), 24)
    w = PHONE_W * 2 + GAP
    return rounded(img.resize((w, round(img.height * w / img.width)), Image.LANCZOS), 14)


def main():
    out, *items = sys.argv[1:]
    tiles = []
    for it in items:
        caption, name = it.split("=", 1)
        tiles.append((caption, tile(Path("screens/img") / name)))
    W = PAD * 2 + sum(t.width for _, t in tiles) + GAP * (len(tiles) - 1)
    H = PAD + LABEL + max(t.height for _, t in tiles) + PAD
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT, 22, index=6)
    x = PAD
    for caption, t in tiles:
        d.text((x + t.width // 2, PAD + LABEL // 2 - 6), caption, font=font, fill=INK, anchor="mm")
        canvas.paste(t, (x, PAD + LABEL))
        x += t.width + GAP
    canvas.save(out, optimize=True)
    print(out, canvas.size, f"{Path(out).stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
