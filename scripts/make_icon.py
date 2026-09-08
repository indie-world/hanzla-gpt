"""
Generates the Hanzla-GPT application icon.

Draws at 8x resolution and downsamples with LANCZOS so every edge is smooth,
then writes a multi-resolution .ico plus PNG assets for the installer and UI.
"""

import os
import math
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
os.makedirs(OUT_DIR, exist_ok=True)

S = 1024          # final master size
SS = 4            # supersample factor
N = S * SS        # working size

# Warm terracotta palette, matched to the app's accent colour.
C_TOP = (240, 142, 84)     # #F08E54
C_BOT = (176, 70, 48)      # #B04630
WHITE = (255, 255, 255)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def diagonal_gradient(size, c0, c1):
    """Smooth 135-degree linear gradient without needing numpy."""
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    # Build a small gradient then resize — far faster than per-pixel on 4096px.
    small = 512
    tmp = Image.new("RGB", (small, small))
    tp = tmp.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2.0 * (small - 1))
            tp[x, y] = (
                int(c0[0] + (c1[0] - c0[0]) * t),
                int(c0[1] + (c1[1] - c0[1]) * t),
                int(c0[2] + (c1[2] - c0[2]) * t),
            )
    return tmp.resize((size, size), Image.LANCZOS)


def build_master():
    radius = int(N * 0.225)

    # --- base plate -------------------------------------------------------
    base = diagonal_gradient(N, C_TOP, C_BOT).convert("RGBA")

    # soft top-left sheen for depth
    sheen = Image.new("L", (N, N), 0)
    sd = ImageDraw.Draw(sheen)
    sd.ellipse([-N * 0.35, -N * 0.55, N * 0.85, N * 0.45], fill=46)
    sheen = sheen.filter(ImageFilter.GaussianBlur(N * 0.06))
    base = Image.composite(Image.new("RGBA", (N, N), (255, 255, 255, 255)), base, sheen)

    icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    icon.paste(base, (0, 0), rounded_mask(N, radius))

    # --- monogram ---------------------------------------------------------
    d = ImageDraw.Draw(icon)

    bar_w = int(N * 0.115)          # stroke thickness
    bar_r = bar_w // 2              # rounded cap radius
    top = int(N * 0.275)
    bot = int(N * 0.725)
    left_x = int(N * 0.315)
    right_x = int(N * 0.685)

    def vbar(cx):
        d.rounded_rectangle(
            [cx - bar_w // 2, top, cx + bar_w // 2, bot],
            radius=bar_r, fill=WHITE,
        )

    vbar(left_x)
    vbar(right_x)

    # crossbar
    cy = int(N * 0.50)
    d.rounded_rectangle(
        [left_x - bar_w // 2, cy - bar_w // 2, right_x + bar_w // 2, cy + bar_w // 2],
        radius=bar_r, fill=WHITE,
    )

    # --- accent node: a small orbiting dot, suggesting a model connection --
    node_r = int(N * 0.052)
    node_cx = int(N * 0.685)
    node_cy = int(N * 0.275)
    # punch a gap around the node so it reads as a separate element
    d.ellipse(
        [node_cx - node_r * 1.95, node_cy - node_r * 1.95,
         node_cx + node_r * 1.95, node_cy + node_r * 1.95],
        fill=(0, 0, 0, 0),
    )
    # re-fill that hole with the plate colour so the bar looks cleanly cut
    hole = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hole)
    hd.ellipse(
        [node_cx - node_r * 1.95, node_cy - node_r * 1.95,
         node_cx + node_r * 1.95, node_cy + node_r * 1.95],
        fill=255,
    )
    icon.paste(base, (0, 0), hole.split()[3])
    d = ImageDraw.Draw(icon)
    d.ellipse(
        [node_cx - node_r, node_cy - node_r, node_cx + node_r, node_cy + node_r],
        fill=WHITE,
    )

    return icon.resize((S, S), Image.LANCZOS)


def main():
    master = build_master()

    png = os.path.join(OUT_DIR, "icon.png")
    master.save(png)
    print("wrote", png)

    for sz in (512, 256, 128, 64):
        p = os.path.join(OUT_DIR, "icon-%d.png" % sz)
        master.resize((sz, sz), Image.LANCZOS).save(p)
        print("wrote", p)

    ico = os.path.join(OUT_DIR, "icon.ico")
    master.save(ico, format="ICO",
                sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("wrote", ico)


if __name__ == "__main__":
    main()
