"""畫 APU Prospector 的圖示：暗色天空、Hα 紅色星雲、星點，加上程式裡的構圖框和方向三角形。

    pip install pillow
    python packaging/make_icon.py

輸出 packaging/app.ico（Windows／PyInstaller 用，Mac 打包時會自動轉成 .icns）與 docs/icon.png。
"""

import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
S = 1024


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius, fill=255)
    return m


def nebula(size, rng):
    """幾團模糊的橢圓疊出不規則的發射星雲。"""
    layer = Image.new("RGB", (size, size), (0, 0, 0))
    for color, count, blur, spread in [
        ((150, 18, 30), 9, 90, 300),
        ((230, 50, 45), 14, 45, 230),
        ((255, 130, 95), 8, 22, 150),
    ]:
        blob = Image.new("RGB", (size, size), (0, 0, 0))
        d = ImageDraw.Draw(blob)
        for _ in range(count):
            cx = size * 0.52 + rng.gauss(0, spread * 0.55)
            cy = size * 0.55 + rng.gauss(0, spread * 0.45)
            rx, ry = rng.uniform(40, spread * 0.6), rng.uniform(30, spread * 0.45)
            d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=color)
        layer = ImageChops.add(layer, blob.filter(ImageFilter.GaussianBlur(blur)), scale=1.0)
    # 中間挖一道暗帶，像星雲裡的塵埃
    dust = Image.new("L", (size, size), 0)
    ImageDraw.Draw(dust).line([(size * 0.2, size * 0.78), (size * 0.55, size * 0.5), (size * 0.85, size * 0.42)],
                              fill=170, width=70)
    dust = dust.filter(ImageFilter.GaussianBlur(40))
    return Image.composite(Image.new("RGB", (size, size)), layer, dust)


def main():
    rng = random.Random(7)
    # 背景：深藍漸層
    bg = Image.new("RGB", (S, S))
    px = bg.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = (int(10 + 8 * t), int(14 + 10 * t), int(30 + 22 * t))
    img = ImageChops.add(bg, nebula(S, rng))

    # 星點
    stars = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(stars)
    for _ in range(140):
        x, y, r = rng.uniform(0, S), rng.uniform(0, S), rng.choice([1.5, 2, 2.5, 3, 4])
        v = rng.randint(150, 255)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(v, v, min(255, v + 20)))
    img = ImageChops.add(img, stars.filter(ImageFilter.GaussianBlur(0.8)))

    # 構圖框（四角括號）與上方的方向三角形
    d = ImageDraw.Draw(img)
    blue, w = (90, 175, 255), 34
    x0, y0, x1, y1 = 210, 300, 814, 760
    arm = 150
    for (cx, cy, dx, dy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
        d.line([(cx, cy + dy * arm), (cx, cy), (cx + dx * arm, cy)], fill=blue, width=w, joint="curve")
    mid = (x0 + x1) / 2
    d.polygon([(mid - 70, y0 - 40), (mid, y0 - 120), (mid + 70, y0 - 40)], fill=blue)

    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), rounded_mask(S, 210))
    (ROOT / "docs").mkdir(exist_ok=True)
    out.resize((512, 512), Image.LANCZOS).save(ROOT / "docs" / "icon.png")
    out.save(ROOT / "packaging" / "app.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("packaging/app.ico、docs/icon.png")


if __name__ == "__main__":
    main()
