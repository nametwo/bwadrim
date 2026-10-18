"""README 움짤 합치기: 엔지니어 폰·고객 폰 녹화 프레임을 나란히 붙여 GIF 하나로.

녹화는 npm run readme:media (e2e/readme/call.media.ts) → test-results/readme/<장면>/{eng,cust}/<ms>.jpg
쓰는 법: python3 scripts/readme-media/make-gif.py <장면> <저장할 gif> [--fps 10] [--width 360]
"""

import argparse
import bisect
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
BG = (242, 244, 246)  # --color-bg-muted 근처
INK = (51, 61, 75)


def frames(d: Path):
    files = sorted(d.glob("*.jpg"), key=lambda p: int(p.stem))
    return [int(p.stem) for p in files], files


def pick(times, files, t):
    i = bisect.bisect_right(times, t) - 1
    return files[max(i, 0)]


def rounded(img: Image.Image, r: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *img.size), r, fill=255)
    out = Image.new("RGB", img.size, BG)
    out.paste(img, mask=mask)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scene")
    ap.add_argument("out")
    ap.add_argument("--fps", type=int, default=8)
    ap.add_argument("--width", type=int, default=260, help="폰 한 대의 너비(px)")
    ap.add_argument("--trim-start", type=float, default=0.0)
    args = ap.parse_args()

    root = Path("test-results/readme") / args.scene
    lanes = [("엔지니어 폰", *frames(root / "eng")), ("고객 폰", *frames(root / "cust"))]
    start = max(t[0] for _, t, _ in lanes) + int(args.trim_start * 1000)
    end = max(t[-1] for _, t, _ in lanes)  # 멈춘 화면은 프레임이 안 와서 한쪽이 먼저 끝난다

    w = args.width
    sample = Image.open(lanes[0][2][0])
    h = round(sample.height * w / sample.width)
    gap, pad, label_h = 28, 24, 40
    W = pad * 2 + w * 2 + gap
    H = pad + label_h + h + pad
    font = ImageFont.truetype(FONT, 20, index=6)

    out = []
    step = 1000 // args.fps
    for t in range(start, end, step):
        canvas = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(canvas)
        for i, (label, times, files) in enumerate(lanes):
            x = pad + i * (w + gap)
            d.text((x + w // 2, pad + label_h // 2 - 4), label, font=font, fill=INK, anchor="mm")
            img = Image.open(pick(times, files, t)).convert("RGB").resize((w, h), Image.LANCZOS)
            canvas.paste(rounded(img, 22), (x, pad + label_h))
        out.append(canvas)

    # 마지막 장면은 조금 오래 보여 준다
    durations = [step] * len(out)
    durations[-1] = 1800
    pal = [f.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in out]
    pal[0].save(args.out, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"{args.out}: {len(out)} frames, {Path(args.out).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
