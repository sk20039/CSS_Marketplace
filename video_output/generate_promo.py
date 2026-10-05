#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cricket Market USA -- 20-second promotional video generator.
Outputs: wide_1920x1080.mp4  and  vertical_1080x1920.mp4
Deps (isolated venv only): imageio[ffmpeg], Pillow, numpy
"""

import sys
import os
import math
import numpy as np
import imageio
from PIL import Image, ImageDraw, ImageFont

# Force UTF-8 output so Windows cp1252 does not crash on box-drawing chars
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
FPS   = 30
TOTAL = FPS * 20   # 600 frames

DARK_NAVY  = (10,  25,  47)
MID_NAVY   = (13,  35,  65)
DEEP_NAVY  = (6,   16,  32)
GREEN      = (21,  128, 61)
DARK_GREEN = (16,  100, 48)
WHITE      = (255, 255, 255)
SOFT_GREEN = (140, 210, 155)

# Section frame boundaries
S1 = (0,   120)   # 0-4 s   hero
S2 = (120, 300)   # 4-10 s  listings grid
S3 = (300, 450)   # 10-15 s selling card
S4 = (450, 600)   # 15-20 s logo / CTA

ASSETS = os.path.normpath(os.path.join(os.path.dirname(__file__),
                                        "..", "frontend", "public"))
OUTDIR = os.path.dirname(__file__)


# ---------------------------------------------------------------------------
# Font loader
# ---------------------------------------------------------------------------
_font_cache: dict = {}

def fnt(bold: bool = False, size: int = 48) -> ImageFont.FreeTypeFont:
    key = (bold, size)
    if key in _font_cache:
        return _font_cache[key]
    candidates = (
        ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/Arialbd.ttf",
         "C:/Windows/Fonts/calibrib.ttf", "C:/Windows/Fonts/Verdanab.ttf"]
        if bold else
        ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/Arial.ttf",
         "C:/Windows/Fonts/calibri.ttf", "C:/Windows/Fonts/Verdana.ttf"]
    )
    for p in candidates:
        try:
            f = ImageFont.truetype(p, size)
            _font_cache[key] = f
            return f
        except Exception:
            pass
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Image / drawing helpers
# ---------------------------------------------------------------------------
def fill(img: Image.Image, W: int, H: int) -> Image.Image:
    """Scale-crop img to exactly W x H."""
    iw, ih = img.size
    s = max(W / iw, H / ih)
    nw, nh = int(iw * s + 0.5), int(ih * s + 0.5)
    img = img.resize((nw, nh), Image.LANCZOS)
    x, y = (nw - W) // 2, (nh - H) // 2
    return img.crop((x, y, x + W, y + H))


def dark_overlay(img: Image.Image, opacity: float = 0.55) -> Image.Image:
    ov = Image.new("RGBA", img.size, (*DARK_NAVY, int(255 * opacity)))
    return Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")


def gradient_overlay(img: Image.Image,
                     top: tuple, bot: tuple,
                     opacity: float = 0.60) -> Image.Image:
    W, H = img.size
    grad = Image.new("RGBA", (W, H))
    draw = ImageDraw.Draw(grad)
    tr, tg, tb = top
    br, bg, bb = bot
    a = int(255 * opacity)
    for y in range(H):
        t = y / H
        r = int(tr + (br - tr) * t)
        g = int(tg + (bg - tg) * t)
        b = int(tb + (bb - tb) * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b, a))
    return Image.alpha_composite(img.convert("RGBA"), grad).convert("RGB")


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def sec_alpha(f: int, s: tuple, fi: int = 20, fo: int = 20) -> float:
    t   = f - s[0]
    dur = s[1] - s[0]
    if t < fi:
        return ease(t / fi)
    if t > dur - fo:
        return ease((dur - t) / fo)
    return 1.0


def ca(color: tuple, a: float) -> tuple:
    """Multiply color by alpha 0-1."""
    return tuple(int(c * a) for c in color)


def canvas(W: int, H: int, color: tuple = None) -> Image.Image:
    return Image.new("RGB", (W, H), color or DARK_NAVY)


def green_bars(draw: ImageDraw.Draw, W: int, H: int, t: int = 7) -> None:
    draw.rectangle([(0, 0), (W, t)], fill=GREEN)
    draw.rectangle([(0, H - t), (W, H)], fill=DARK_GREEN)


def tw(draw: ImageDraw.Draw, text: str, f: ImageFont.FreeTypeFont) -> tuple:
    bb = draw.textbbox((0, 0), text, font=f)
    return bb[2] - bb[0], bb[3] - bb[1]


def draw_c(draw: ImageDraw.Draw, text: str, y: int,
           f: ImageFont.FreeTypeFont, color: tuple, W: int,
           sh: int = 3) -> None:
    """Draw text centered horizontally at y."""
    w, _ = tw(draw, text, f)
    x = (W - w) // 2
    draw.text((x + sh, y + sh), text, font=f, fill=(0, 0, 0, 130))
    draw.text((x, y), text, font=f, fill=color)


def draw_l(draw: ImageDraw.Draw, text: str, x: int, y: int,
           f: ImageFont.FreeTypeFont, color: tuple, sh: int = 2) -> None:
    """Draw text left-aligned at x, y."""
    draw.text((x + sh, y + sh), text, font=f, fill=(0, 0, 0, 130))
    draw.text((x, y), text, font=f, fill=color)


def blend_img(a_img: Image.Image, b_img: Image.Image, t: float) -> Image.Image:
    t = max(0.0, min(1.0, t))
    arr = (np.array(a_img) * (1 - t) + np.array(b_img) * t).astype(np.uint8)
    return Image.fromarray(arr)


def rrect(draw: ImageDraw.Draw, x0: int, y0: int, x1: int, y1: int,
          r: int, fill=None, outline=None, width: int = 0) -> None:
    try:
        draw.rounded_rectangle([(x0, y0), (x1, y1)],
                                radius=r, fill=fill, outline=outline, width=width)
    except AttributeError:
        draw.rectangle([(x0, y0), (x1, y1)], fill=fill, outline=outline, width=width)


# ---------------------------------------------------------------------------
# Section 1  (0-4 s): Hero + tagline
# ---------------------------------------------------------------------------
def s1_hero(f: int, W: int, H: int, hero: Image.Image) -> Image.Image:
    a = sec_alpha(f, S1, fi=15, fo=25)
    t = (f - S1[0]) / (S1[1] - S1[0])

    # Ken Burns: zoom 1.0 -> 1.08
    scale = 1.0 + 0.08 * ease(t)
    sw, sh = int(W * scale), int(H * scale)
    zoomed = hero.resize((sw, sh), Image.LANCZOS)
    ox, oy = (sw - W) // 2, (sh - H) // 2
    base = zoomed.crop((ox, oy, ox + W, oy + H))

    base = gradient_overlay(base, DEEP_NAVY, DARK_NAVY, opacity=0.54)

    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)

    cw = ca(WHITE, a)
    cg = ca(GREEN, a)
    cs = ca(SOFT_GREEN, a * 0.85)

    if W > H:   # wide
        fH  = fnt(bold=True,  size=92)
        fSb = fnt(bold=False, size=34)
        yc  = H // 2 - 70
        sp  = 102
    else:       # vertical
        fH  = fnt(bold=True,  size=78)
        fSb = fnt(bold=False, size=30)
        yc  = H // 2 + 70
        sp  = 90

    draw_c(draw, "Cricket gear deserves", yc,      fH,  cw, W)
    draw_c(draw, "another innings.",       yc + sp, fH,  cg, W)
    draw_c(draw, "USA Cricket Equipment Marketplace",
           yc + sp * 2 + 20, fSb, cs, W)

    # Top-left wordmark
    szL = 44 if W > H else 36
    fL  = fnt(bold=True, size=szL)
    draw_l(draw, "Cricket", 36, 28, fL, ca(WHITE, min(1.0, a * 2)), sh=2)
    bb = draw.textbbox((36, 28), "Cricket", font=fL)
    draw_l(draw, "Market", bb[2], 28, fL, ca(GREEN, min(1.0, a * 2)), sh=2)

    return base


# ---------------------------------------------------------------------------
# Section 2  (4-10 s): Listings grid
# ---------------------------------------------------------------------------
ITEMS = [
    ("bat",         "Cricket Bats"),
    ("helmet",      "Helmets"),
    ("pads",        "Batting Pads"),
    ("gloves",      "Gloves"),
    ("kitbag",      "Kit Bags"),
    ("accessories", "Accessories"),
]


def s2_listings(f: int, W: int, H: int, cats: dict) -> Image.Image:
    a = sec_alpha(f, S2, fi=20, fo=20)
    t = (f - S2[0]) / (S2[1] - S2[0])

    base = canvas(W, H, DARK_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)

    cw = ca(WHITE, a)
    cg = ca(GREEN, a)
    cs = ca(SOFT_GREEN, a * 0.9)

    if W > H:   # ----- wide layout -----
        fH   = fnt(bold=True,  size=76)
        fSub = fnt(bold=False, size=26)
        fLbl = fnt(bold=False, size=16)

        tx, ty = 72, H // 2 - 80
        draw_l(draw, "Find new and used",    tx, ty,      fH,  cw)
        lh = tw(draw, "Find new and used",   fH)[1]
        draw_l(draw, "cricket equipment.",   tx, ty + lh + 14, fH, cg)
        draw_l(draw, "Browse bats, helmets, pads, gloves & bags",
               tx, ty + lh * 2 + 42, fSub, cs)

        # 3x2 grid on right half
        gx  = W // 2 + 30
        cw_ = (W - gx - 40) // 3
        ch_ = (H - 40) // 2

        for i, (key, lbl) in enumerate(ITEMS):
            col = i % 3
            row = i // 3
            reveal = ease(max(0.0, min(1.0, t * 2.2 - i * 0.2))) * a
            cx = gx + col * cw_ + 8
            cy = 20 + row * ch_ + 8
            iw = cw_ - 16
            ih = ch_ - 16

            img = cats.get(key)
            if img:
                card = Image.new("RGB", (iw, ih), (238, 240, 236))
                fitted = fill(img.convert("RGB"), iw, ih - 28)
                card.paste(fitted, (0, 0))
                bar = Image.new("RGB", (iw, 28), (20, 45, 80))
                bd  = ImageDraw.Draw(bar)
                lbw = tw(bd, lbl, fLbl)[0]
                bd.text(((iw - lbw) // 2, 5), lbl, font=fLbl, fill=WHITE)
                card.paste(bar, (0, ih - 28))
                if reveal < 1.0:
                    blank = canvas(iw, ih, DARK_NAVY)
                    card = blend_img(blank, card, reveal)
                base.paste(card, (cx, cy))
                if reveal > 0.3:
                    d2 = ImageDraw.Draw(base, "RGBA")
                    d2.rectangle([(cx, cy), (cx + iw, cy + 2)], fill=GREEN)

    else:       # ----- vertical layout -----
        fH   = fnt(bold=True,  size=70)
        fSub = fnt(bold=False, size=26)
        fLbl = fnt(bold=False, size=15)

        ty = 110
        draw_c(draw, "Find new and used",   ty,           fH, cw, W)
        lh = tw(draw, "Find new and used",  fH)[1]
        draw_c(draw, "cricket equipment.",  ty + lh + 14, fH, cg, W)
        draw_c(draw, "New  *  Used  *  Trusted",
               ty + lh * 2 + 34, fSub, cs, W)

        grid_top = ty + lh * 2 + 80
        avail_h  = H - grid_top - 50
        cw_ = (W - 40) // 3
        ch_ = avail_h // 2

        for i, (key, lbl) in enumerate(ITEMS):
            col = i % 3
            row = i // 3
            reveal = ease(max(0.0, min(1.0, t * 2.2 - i * 0.2))) * a
            cx = 20 + col * cw_ + 5
            cy = int(grid_top) + row * ch_ + 5
            iw = cw_ - 10
            ih = ch_ - 10

            img = cats.get(key)
            if img:
                card = Image.new("RGB", (iw, ih), (238, 240, 236))
                fitted = fill(img.convert("RGB"), iw, ih - 24)
                card.paste(fitted, (0, 0))
                bar = Image.new("RGB", (iw, 24), (20, 45, 80))
                bd  = ImageDraw.Draw(bar)
                lbw = tw(bd, lbl, fLbl)[0]
                bd.text(((iw - lbw) // 2, 4), lbl, font=fLbl, fill=WHITE)
                card.paste(bar, (0, ih - 24))
                if reveal < 1.0:
                    blank = canvas(iw, ih, DARK_NAVY)
                    card = blend_img(blank, card, reveal)
                base.paste(card, (cx, cy))

    return base


# ---------------------------------------------------------------------------
# Section 3  (10-15 s): Sell / listing card
# ---------------------------------------------------------------------------
def s3_sell(f: int, W: int, H: int, cats: dict) -> Image.Image:
    a = sec_alpha(f, S3, fi=20, fo=20)
    t = (f - S3[0]) / (S3[1] - S3[0])

    base = canvas(W, H, MID_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)

    cw  = ca(WHITE, a)
    cg  = ca(GREEN, a)
    cs  = ca(SOFT_GREEN, a * 0.9)
    sl  = ease(min(1.0, t * 2.5))   # slide progress

    bat_img = cats.get("bat")
    kit_img = cats.get("kitbag")

    if W > H:   # ----- wide layout -----
        fH   = fnt(bold=True,  size=70)
        fSub = fnt(bold=False, size=24)
        fBtn = fnt(bold=True,  size=20)

        # Card slides in from left
        off = int(-340 * (1 - sl))
        cx0, cy0 = 60 + off, 70
        cw_ = W // 2 - 100
        ch_ = H - 140

        # Shadow
        draw.rectangle([(cx0 + 6, cy0 + 6), (cx0 + cw_ + 6, cy0 + ch_ + 6)],
                        fill=(0, 0, 0, 70))
        rrect(draw, cx0, cy0, cx0 + cw_, cy0 + ch_, 18, fill=(22, 48, 85))

        # Bat image fills most of the card; leave room only for the CTA button
        btn_h  = 56
        img_h  = ch_ - btn_h - 20
        if bat_img:
            bat_bg  = Image.new("RGB", (cw_ - 4, img_h - 4), (240, 238, 230))
            bat_fit = fill(bat_img.convert("RGB"), cw_ - 4, img_h - 4)
            bat_bg.paste(bat_fit, (0, 0))
            base.paste(bat_bg, (cx0 + 2, cy0 + 2))

        fy    = cy0 + img_h + 10
        btn_w = cw_ - 40
        rrect(draw, cx0 + 20, fy, cx0 + 20 + btn_w, fy + btn_h - 10, 10,
              fill=DARK_GREEN, outline=GREEN, width=2)
        bt = "List Your Gear  ->"
        bw = tw(draw, bt, fBtn)[0]
        draw_l(draw, bt, cx0 + 20 + (btn_w - bw) // 2, fy + 13, fBtn, WHITE, sh=0)

        # Right text
        tx = W // 2 + 60
        ty = H // 2 - 78
        draw_l(draw, "Have gear to sell?",  tx, ty,      fH, cw)
        lh = tw(draw, "Have gear to sell?", fH)[1]
        draw_l(draw, "Create your listing.", tx, ty + lh + 12, fH, cg)
        draw_l(draw, "Free to list  *  Secure payments  *  Fast payouts",
               tx, ty + lh * 2 + 38, fSub, cs)

        # Kit bag thumbnail bottom-right
        if kit_img:
            kr = 180
            kit_fit  = fill(kit_img.convert("RGB"), kr, kr)
            kit_fade = blend_img(canvas(kr, kr, MID_NAVY), kit_fit,
                                 min(1.0, sl * 1.4) * a)
            base.paste(kit_fade, (W - kr - 30, H - kr - 30))

    else:       # ----- vertical layout -----
        fH   = fnt(bold=True,  size=68)
        fSub = fnt(bold=False, size=24)
        fBtn = fnt(bold=True,  size=20)

        ct   = 60
        ch_  = int(H * 0.43)

        rrect(draw, 30, ct, W - 30, ct + ch_, 18, fill=(22, 48, 85))

        # Bat image fills the card; only CTA button below
        btn_h = 52
        img_h = ch_ - btn_h - 10
        if bat_img:
            bat_bg  = Image.new("RGB", (W - 64, img_h - 4), (240, 238, 230))
            bat_fit = fill(bat_img.convert("RGB"), W - 64, img_h - 4)
            bat_bg.paste(bat_fit, (0, 0))
            base.paste(bat_bg, (32, ct + 2))

        btn_y = ct + img_h + 8
        rrect(draw, 50, btn_y, W - 50, btn_y + 42, 8,
              fill=DARK_GREEN, outline=GREEN, width=2)
        bt  = "List Your Gear  ->"
        bw  = tw(draw, bt, fBtn)[0]
        draw_l(draw, bt, (W - bw) // 2, btn_y + 11, fBtn, WHITE, sh=0)

        ty2 = ct + ch_ + 52
        draw_c(draw, "Have gear to sell?",   ty2,           fH, cw, W)
        lh  = tw(draw, "Have gear to sell?", fH)[1]
        draw_c(draw, "Create your listing.", ty2 + lh + 14, fH, cg, W)
        draw_c(draw, "Free  *  Secure  *  Fast payouts",
               ty2 + lh * 2 + 42, fSub, cs, W)

    if a < 1.0:
        base = blend_img(canvas(W, H, DARK_NAVY), base, a)

    return base


# ---------------------------------------------------------------------------
# Section 4  (15-20 s): Logo + CTA
# ---------------------------------------------------------------------------
def s4_logo(f: int, W: int, H: int) -> Image.Image:
    a = sec_alpha(f, S4, fi=30, fo=25)

    base = canvas(W, H, DEEP_NAVY)

    # Radial green glow
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd   = ImageDraw.Draw(glow)
    cx_, cy_ = W // 2, H // 2
    mr = min(W, H) // 2
    for r in range(mr, 0, -30):
        ga = int(20 * (1 - r / mr) * a)
        gd.ellipse([(cx_ - r, cy_ - r), (cx_ + r, cy_ + r)], fill=(*GREEN, ga))
    base = Image.alpha_composite(base.convert("RGBA"), glow).convert("RGB")

    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H, t=8)

    cw  = ca(WHITE, a)
    cg  = ca(GREEN, a)
    cs  = ca(SOFT_GREEN, a)

    szL, szT, szU, szS = (
        (104, 54, 30, 20) if W > H else (88, 52, 28, 18)
    )

    fL = fnt(bold=True,  size=szL)
    fT = fnt(bold=True,  size=szT)
    fU = fnt(bold=False, size=szU)
    fS = fnt(bold=False, size=szS)

    # Logo "CricketMarket"
    tc, tm    = "Cricket", "Market"
    wc, hc    = tw(draw, tc, fL)
    wm, _     = tw(draw, tm, fL)
    logo_w    = wc + wm
    lx        = (W - logo_w) // 2

    # Vertical stack centre point
    stack_h = hc + 20 + szT + 18 + szU + 30 + szS
    ly      = (H - stack_h) // 2

    # Shadow + draw logo
    draw.text((lx + 4, ly + 4), tc, font=fL, fill=(0, 0, 0, 120))
    draw.text((lx + wc + 4, ly + 4), tm, font=fL, fill=(0, 0, 0, 120))
    draw.text((lx, ly), tc, font=fL, fill=cw)
    draw.text((lx + wc, ly), tm, font=fL, fill=cg)

    # Rule
    ry = ly + hc + 14
    rw = min(logo_w, 420)
    draw.rectangle([(W // 2 - rw // 2, ry), (W // 2 + rw // 2, ry + 2)],
                   fill=(*GREEN, int(255 * a)))

    # Tagline
    tag = "Buy.  Sell.  Keep playing."
    tw_, _ = tw(draw, tag, fT)
    ty2    = ry + 18
    draw.text(((W - tw_) // 2 + 3, ty2 + 3), tag, font=fT, fill=(0, 0, 0, 120))
    draw.text(((W - tw_) // 2, ty2),          tag, font=fT, fill=cw)

    # URL
    url    = "cricketmarketusa.com"
    uw, _  = tw(draw, url, fU)
    uy     = ty2 + szT + 18
    draw.text(((W - uw) // 2, uy), url, font=fU, fill=cg)

    # Sub
    sub    = "USA Cricket Equipment Marketplace"
    sw_, _ = tw(draw, sub, fS)
    draw.text(((W - sw_) // 2, uy + szU + 16), sub, font=fS, fill=cs)

    return base


# ---------------------------------------------------------------------------
# Renderer
# ---------------------------------------------------------------------------
def render(label: str, W: int, H: int,
           hero: Image.Image, cats: dict) -> str:
    out = os.path.join(OUTDIR, f"cricket_market_{label}.mp4")
    print(f"\n  >> {label}  ({W}x{H})")
    print(f"     -> {out}")
    sys.stdout.flush()

    writer = imageio.get_writer(
        out, fps=FPS, codec="libx264",
        quality=8, pixelformat="yuv420p",
        macro_block_size=1,
        output_params=["-preset", "fast", "-crf", "18"]
    )

    for f in range(TOTAL):
        if   f < S1[1]: img = s1_hero(f, W, H, hero)
        elif f < S2[1]: img = s2_listings(f, W, H, cats)
        elif f < S3[1]: img = s3_sell(f, W, H, cats)
        else:           img = s4_logo(f, W, H)

        writer.append_data(np.array(img.convert("RGB")))

        if f % 90 == 0:
            print(f"     frame {f:>3}/{TOTAL}  ({f // FPS}s)")
            sys.stdout.flush()

    writer.close()
    kb = os.path.getsize(out) // 1024
    print(f"  OK  {label}: {kb:,} KB")
    sys.stdout.flush()
    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    print("=" * 56)
    print("  Cricket Market USA -- Promo Video Generator")
    print("=" * 56)
    sys.stdout.flush()

    print("\nLoading assets ...")
    hero = Image.open(os.path.join(ASSETS, "hero-cricket-bg.png")).convert("RGB")
    print(f"  hero  {hero.size}")

    cats: dict = {}
    for k in ("bat", "helmet", "pads", "gloves", "kitbag", "accessories"):
        p = os.path.join(ASSETS, "categories", f"{k}.webp")
        img = Image.open(p).convert("RGB")
        cats[k] = img
        print(f"  {k:<16} {img.size}")
    sys.stdout.flush()

    outputs = []
    outputs.append(render("wide_1920x1080",     1920, 1080, hero, cats))
    outputs.append(render("vertical_1080x1920", 1080, 1920, hero, cats))

    print("\n" + "=" * 56)
    print("  OUTPUT FILES")
    print("=" * 56)
    for p in outputs:
        kb = os.path.getsize(p) // 1024
        print(f"  {p}")
        print(f"  {kb:,} KB  ({kb / 1024:.1f} MB)")
        print()
    sys.stdout.flush()


if __name__ == "__main__":
    main()
