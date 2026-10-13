"""Procedural app + tray icons: aurora gradient orb with a shield."""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def orb(size, colors, glow=True):
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    c0, c1, c2 = colors
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            wave = 0.5 + 0.5 * math.sin((x / S) * 6.0 + (y / S) * 3.0)
            col = lerp(c0, c1, t) if t < 0.5 else lerp(c1, c2, (t - 0.5) * 2)
            col = lerp(col, c2, wave * 0.25)
            px[x, y] = col + (255,)
    mask = Image.new("L", (S, S), 0)
    m = int(S * 0.04)
    ImageDraw.Draw(mask).rounded_rectangle([m, m, S - m, S - m], radius=int(S * 0.26), fill=255)
    img.paste(grad, (0, 0), mask)

    # soft inner highlight
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse([int(S * 0.1), int(-S * 0.35), int(S * 0.9), int(S * 0.45)], fill=(255, 255, 255, 50))
    hl = hl.filter(ImageFilter.GaussianBlur(S * 0.05))
    img = Image.alpha_composite(img, Image.composite(hl, Image.new("RGBA", (S, S)), mask))

    # shield
    d = ImageDraw.Draw(img)
    cx, top, w, h = S / 2, S * 0.22, S * 0.46, S * 0.58
    pts = []
    for i in range(41):
        a = i / 40
        x = cx - w / 2 + w * a
        pts.append((x, top + S * 0.03 * math.sin(a * math.pi)))
    for i in range(41):
        a = i / 40
        ang = math.pi * a
        x = cx + (w / 2) * math.cos(ang)
        y = top + h * 0.45 + (h * 0.55) * math.sin(ang) ** 1.2
        pts.append((x, y))
    if glow:
        g = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(g).polygon(pts, fill=(255, 255, 255, 140))
        g = g.filter(ImageFilter.GaussianBlur(S * 0.03))
        img = Image.alpha_composite(img, g)
        d = ImageDraw.Draw(img)
    d.polygon(pts, fill=(255, 255, 255, 240))
    # aurora wave cut through the shield
    wave = []
    for i in range(61):
        a = i / 60
        x = cx - w / 2 + w * a
        y = top + h * 0.48 + S * 0.05 * math.sin(a * math.pi * 2.2 + 0.6)
        wave.append((x, y))
    d.line(wave, fill=colors[0] + (255,), width=int(S * 0.045), joint="curve")
    return img.resize((size, size), Image.LANCZOS)


aurora = ((40, 230, 190), (90, 120, 255), (200, 80, 255))
grey = ((90, 100, 120), (70, 78, 98), (110, 100, 130))

orb(1024, aurora).save(os.path.join(ROOT, "tools", "icon-src.png"))
orb(64, aurora).save(os.path.join(OUT, "tray-on.png"))
orb(64, grey, glow=False).save(os.path.join(OUT, "tray-off.png"))
print("ok")
