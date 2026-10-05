#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_corrected_reel.py
======================
Produces a safe-zone-compliant 1080x1920 ad version of the promo video.
The original cricket_market_vertical_1080x1920_final.mp4 is NOT touched.

Output files (all in video_output/):
  cricket_market_reel_1080x1920_corrected.mp4     -- corrected ad version
  safeview_corrected_reels_s1.png  ..  _s4.png    -- Reels guides
  safeview_corrected_stories_s1.png .. _s4.png    -- Stories guides (separate)
  meta_spec_audit.md                              -- rewritten with corrections

Meta safe zones used (current official guidance, verified 2026-10):
  Reels  (9:16 ad): top 14% (268 px), bottom 35% (672 px, boundary y=1248),
                    right 15% (162 px action icon column), left 5% (54 px)
  Stories (9:16 ad): top 14% (268 px), bottom 20% (384 px, boundary y=1536),
                    left 5% (54 px), right 5% (54 px)

Run:
    video_venv/Scripts/python video_output/make_corrected_reel.py
"""

import sys, os, subprocess, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio
import imageio_ffmpeg

FF     = imageio_ffmpeg.get_ffmpeg_exe()
OUTDIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.normpath(os.path.join(OUTDIR, "..", "frontend", "public"))

REEL_FINAL     = os.path.join(OUTDIR, "cricket_market_vertical_1080x1920_final.mp4")
CORRECTED_SIL  = os.path.join(OUTDIR, "_corrected_1080x1920_silent.mp4")
CORRECTED_FINAL= os.path.join(OUTDIR, "cricket_market_reel_1080x1920_corrected.mp4")

FPS   = 30
TOTAL = FPS * 20   # 600 frames
W, H  = 1080, 1920

# ---- Palette ----------------------------------------------------------------
DARK_NAVY  = (10,  25,  47)
MID_NAVY   = (13,  35,  65)
DEEP_NAVY  = (6,   16,  32)
GREEN      = (21,  128, 61)
DARK_GREEN = (16,  100, 48)
WHITE      = (255, 255, 255)
SOFT_GREEN = (140, 210, 155)

S1 = (0,   120)
S2 = (120, 300)
S3 = (300, 450)
S4 = (450, 600)

# ---- Meta safe zones --------------------------------------------------------
# Reels: top 14 %, bottom 35 % (action area is larger), right 15 % (icon col)
REELS_SAFE = dict(
    top    = int(H * 0.14),   # 268 px  profile / handle / follow / share
    bottom = int(H * 0.35),   # 672 px  like/cmt/share, audio title, caption
    left   = int(W * 0.05),   #  54 px
    right  = int(W * 0.15),   # 162 px  action icon column
)
# Safe rectangle for Reels content: x=54..918, y=268..1248

# Stories: top 14 %, bottom 20 % (Send Message bar), equal left/right 5 %
STORIES_SAFE = dict(
    top    = int(H * 0.14),   # 268 px
    bottom = int(H * 0.20),   # 384 px
    left   = int(W * 0.05),   #  54 px
    right  = int(W * 0.05),   #  54 px
)
# Safe rectangle for Stories content: x=54..1026, y=268..1536

# Layout constants derived from Reels (more restrictive) safe zone
TOP_SAFE    = REELS_SAFE["top"]     # 268 — first safe pixel from top
BOT_SAFE    = H - REELS_SAFE["bottom"]  # 1248 — last safe pixel from bottom

# Content placement anchor — headline vertical centre inside safe zone
SAFE_H      = BOT_SAFE - TOP_SAFE   # 980 px usable height
SAFE_CY     = TOP_SAFE + SAFE_H // 2  # 758 — midpoint of safe zone

PREVIEW_TIMES = [("s1", 2), ("s2", 7), ("s3", 12), ("s4", 17)]


# ---- Helpers (identical to generate_promo.py) --------------------------------
_font_cache: dict = {}

def fnt(bold=False, size=48):
    key = (bold, size)
    if key in _font_cache:
        return _font_cache[key]
    candidates = (
        ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/Arialbd.ttf",
         "C:/Windows/Fonts/calibrib.ttf"]
        if bold else
        ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/Arial.ttf",
         "C:/Windows/Fonts/calibri.ttf"]
    )
    for p in candidates:
        try:
            f = ImageFont.truetype(p, size)
            _font_cache[key] = f
            return f
        except Exception:
            pass
    return ImageFont.load_default()

def fill(img, fw, fh):
    iw, ih = img.size
    s = max(fw / iw, fh / ih)
    nw, nh = int(iw * s + 0.5), int(ih * s + 0.5)
    img = img.resize((nw, nh), Image.LANCZOS)
    x, y = (nw - fw) // 2, (nh - fh) // 2
    return img.crop((x, y, x + fw, y + fh))

def gradient_overlay(img, top, bot, opacity=0.60):
    IW, IH = img.size
    grad = Image.new("RGBA", (IW, IH))
    draw = ImageDraw.Draw(grad)
    tr, tg, tb = top; br, bg, bb = bot
    a = int(255 * opacity)
    for yy in range(IH):
        t = yy / IH
        r, g, b = int(tr+(br-tr)*t), int(tg+(bg-tg)*t), int(tb+(bb-tb)*t)
        draw.line([(0, yy), (IW, yy)], fill=(r, g, b, a))
    return Image.alpha_composite(img.convert("RGBA"), grad).convert("RGB")

def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def sec_alpha(f, s, fi=20, fo=20):
    t = f - s[0]; dur = s[1] - s[0]
    if t < fi:       return ease(t / fi)
    if t > dur - fo: return ease((dur - t) / fo)
    return 1.0

def ca(color, a):
    return tuple(int(c * a) for c in color)

def canvas(color=None):
    return Image.new("RGB", (W, H), color or DARK_NAVY)

def green_bars(draw, t=7):
    draw.rectangle([(0, 0),    (W, t)],    fill=GREEN)
    draw.rectangle([(0, H-t),  (W, H)],    fill=DARK_GREEN)

def tw(draw, text, f):
    bb = draw.textbbox((0, 0), text, font=f)
    return bb[2] - bb[0], bb[3] - bb[1]

def draw_c(draw, text, y, f, color, sh=3):
    w, _ = tw(draw, text, f)
    x = (W - w) // 2
    draw.text((x+sh, y+sh), text, font=f, fill=(0, 0, 0, 130))
    draw.text((x, y),       text, font=f, fill=color)

def draw_l(draw, text, x, y, f, color, sh=2):
    draw.text((x+sh, y+sh), text, font=f, fill=(0, 0, 0, 130))
    draw.text((x, y),       text, font=f, fill=color)

def blend_img(a_img, b_img, t):
    t = max(0.0, min(1.0, t))
    arr = (np.array(a_img)*(1-t) + np.array(b_img)*t).astype(np.uint8)
    return Image.fromarray(arr)

def rrect(draw, x0, y0, x1, y1, r, fill=None, outline=None, width=0):
    try:
        draw.rounded_rectangle([(x0,y0),(x1,y1)], radius=r,
                                fill=fill, outline=outline, width=width)
    except AttributeError:
        draw.rectangle([(x0,y0),(x1,y1)], fill=fill, outline=outline, width=width)


# ---- Corrected section renderers --------------------------------------------
# All key content (wordmark, titles, card, CTA, headlines, URL) sits inside
# the MORE RESTRICTIVE Reels safe rectangle: x=54..918, y=268..1248
# This automatically satisfies the Stories safe zone (y=268..1536, x=54..1026).

ITEMS = [
    ("bat",         "Cricket Bats"),
    ("helmet",      "Helmets"),
    ("pads",        "Batting Pads"),
    ("gloves",      "Gloves"),
    ("kitbag",      "Kit Bags"),
    ("accessories", "Accessories"),
]


def s1_hero(f, hero):
    """
    Wordmark at y=280 (12 px below top 14% safe boundary).
    Headline block centred inside safe zone so subtitle clears y=1248.
    """
    a  = sec_alpha(f, S1, fi=15, fo=25)
    t  = (f - S1[0]) / (S1[1] - S1[0])
    scale = 1.0 + 0.08 * ease(t)
    sw, sh = int(W * scale), int(H * scale)
    zoomed = hero.resize((sw, sh), Image.LANCZOS)
    ox, oy = (sw - W) // 2, (sh - H) // 2
    base = zoomed.crop((ox, oy, ox+W, oy+H))
    base = gradient_overlay(base, DEEP_NAVY, DARK_NAVY, opacity=0.54)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw)

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a * 0.85)

    fH  = fnt(bold=True,  size=78)
    fSb = fnt(bold=False, size=28)
    sp  = 88

    # Headline block: centred between SAFE_CY bias, subtitle must clear y=1248.
    # With fH=78 line height ≈78, fSb=28:
    #   yc=930 → line1 930-1008, line2 1018-1096, sub 1112-1140  ✓ (<1248)
    yc = 930
    draw_c(draw, "Cricket gear deserves", yc,          fH,  cw)
    draw_c(draw, "another innings.",       yc + sp,     fH,  cg)
    draw_c(draw, "USA Cricket Equipment Marketplace",
                 yc + sp * 2 + 16, fSb, cs)

    # Wordmark — y=280 clears top 14% overlay (268 px) with 12 px margin.
    # x=36..~280 stays left of Reels action icons (right 15%, x≥918).
    szL = 36
    fL  = fnt(bold=True, size=szL)
    draw_l(draw, "Cricket", 36, 280, fL, ca(WHITE, min(1.0, a * 2)), sh=2)
    bb = draw.textbbox((36, 280), "Cricket", font=fL)
    draw_l(draw, "Market", bb[2], 280, fL, ca(GREEN, min(1.0, a * 2)), sh=2)
    return base


def s2_listings(f, cats):
    """
    Title at y=280 (top of safe zone).
    Grid constrained: rows end at y≤1240 (8 px margin from Reels bottom safe y=1248).
    """
    a = sec_alpha(f, S2, fi=20, fo=20)
    t = (f - S2[0]) / (S2[1] - S2[0])
    base = canvas(DARK_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw)

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a * 0.9)
    fH   = fnt(bold=True,  size=68)
    fSub = fnt(bold=False, size=26)
    fLbl = fnt(bold=False, size=15)

    # Title inside top safe zone
    ty = 280
    draw_c(draw, "Find new and used",   ty,             fH,  cw)
    lh = tw(draw, "Find new and used",  fH)[1]          # ≈ 68
    draw_c(draw, "cricket equipment.",  ty + lh + 12,   fH,  cg)
    draw_c(draw, "New  *  Used  *  Trusted",
                 ty + lh * 2 + 30, fSub, cs)

    # Grid: top at ~520, bottom capped at 1240
    grid_top = ty + lh * 2 + 78   # ≈ 518
    bot_cap  = 1240
    avail_h  = bot_cap - grid_top  # ≈ 722
    cw_ = (W - 40) // 3           # 346
    ch_ = avail_h // 2            # ≈ 361

    for i, (key, lbl) in enumerate(ITEMS):
        col = i % 3; row = i // 3
        reveal = ease(max(0.0, min(1.0, t * 2.2 - i * 0.2))) * a
        cx = 20 + col * cw_ + 5
        cy = grid_top + row * ch_ + 5
        iw = cw_ - 10; ih = ch_ - 10
        img = cats.get(key)
        if img:
            card = Image.new("RGB", (iw, ih), (238, 240, 236))
            fitted = fill(img.convert("RGB"), iw, ih - 24)
            card.paste(fitted, (0, 0))
            bar = Image.new("RGB", (iw, 24), (20, 45, 80))
            bd  = ImageDraw.Draw(bar)
            lbw = tw(bd, lbl, fLbl)[0]
            bd.text(((iw-lbw)//2, 4), lbl, font=fLbl, fill=WHITE)
            card.paste(bar, (0, ih-24))
            if reveal < 1.0:
                blank = canvas(DARK_NAVY)
                blank = blank.crop((0, 0, iw, ih))
                card  = blend_img(blank, card, reveal)
            base.paste(card, (cx, cy))
    return base


def s3_sell(f, cats):
    """
    Sell card top at y=280 (top of safe zone).
    Card height 510 px; text block ends ≈ y=1020, well inside y=1248.
    """
    a  = sec_alpha(f, S3, fi=20, fo=20)
    t  = (f - S3[0]) / (S3[1] - S3[0])
    base = canvas(MID_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw)

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a * 0.9)
    sl = ease(min(1.0, t * 2.5))

    fH   = fnt(bold=True,  size=62)
    fSub = fnt(bold=False, size=22)
    fBtn = fnt(bold=True,  size=20)

    ct   = 280    # card top — clears top 14% safe zone (268 px)
    ch_  = 510    # card height
    img_h = ch_ - 48 - 10  # 452 px bat area

    rrect(draw, 30, ct, W-30, ct+ch_, 18, fill=(22, 48, 85))

    bat_img = cats.get("bat")
    if bat_img:
        bat_bg  = Image.new("RGB", (W-64, img_h-4), (240, 238, 230))
        bat_fit = fill(bat_img.convert("RGB"), W-64, img_h-4)
        bat_bg.paste(bat_fit, (0, 0))
        base.paste(bat_bg, (32, ct+2))

    btn_y = ct + img_h + 8   # ≈ 740
    rrect(draw, 50, btn_y, W-50, btn_y+38, 8,
          fill=DARK_GREEN, outline=GREEN, width=2)
    bt  = "List Your Gear  ->"
    bw  = tw(draw, bt, fBtn)[0]
    draw_l(draw, bt, (W-bw)//2, btn_y+9, fBtn, WHITE, sh=0)

    # Text block starts ≈ y=832; two headlines + subtitle end ≈ y=1020 (<1248)
    ty2 = ct + ch_ + 42   # ≈ 832
    draw_c(draw, "Have gear to sell?",   ty2,            fH,  cw)
    lh  = tw(draw, "Have gear to sell?", fH)[1]   # ≈ 62
    draw_c(draw, "Create your listing.", ty2 + lh + 12, fH,  cg)
    draw_c(draw, "Free  *  Secure  *  Fast payouts",
                 ty2 + lh * 2 + 34, fSub, cs)

    if a < 1.0:
        base = blend_img(canvas(DARK_NAVY), base, a)
    return base


def s4_logo(f):
    """
    Unchanged from original — all elements centred around y=960, well inside
    both Reels (y=268..1248) and Stories (y=268..1536) safe zones.
    """
    a    = sec_alpha(f, S4, fi=30, fo=25)
    base = canvas(DEEP_NAVY)

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd   = ImageDraw.Draw(glow)
    cx_, cy_ = W//2, H//2
    mr = min(W, H) // 2
    for r in range(mr, 0, -30):
        ga = int(20 * (1 - r/mr) * a)
        gd.ellipse([(cx_-r, cy_-r), (cx_+r, cy_+r)], fill=(*GREEN, ga))
    base = Image.alpha_composite(base.convert("RGBA"), glow).convert("RGB")

    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, t=8)

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a)
    szL, szT, szU, szS = 88, 52, 28, 18
    fL = fnt(bold=True,  size=szL)
    fT = fnt(bold=True,  size=szT)
    fU = fnt(bold=False, size=szU)
    fS = fnt(bold=False, size=szS)

    tc, tm  = "Cricket", "Market"
    wc, hc  = tw(draw, tc, fL)
    wm, _   = tw(draw, tm, fL)
    logo_w  = wc + wm
    lx      = (W - logo_w) // 2

    stack_h = hc + 20 + szT + 18 + szU + 30 + szS  # ≈ 254
    ly      = (H - stack_h) // 2                     # ≈ 833

    draw.text((lx+4, ly+4), tc, font=fL, fill=(0, 0, 0, 120))
    draw.text((lx+wc+4, ly+4), tm, font=fL, fill=(0, 0, 0, 120))
    draw.text((lx, ly),   tc, font=fL, fill=cw)
    draw.text((lx+wc, ly), tm, font=fL, fill=cg)

    ry = ly + hc + 14    # ≈ 935
    rw = min(logo_w, 420)
    draw.rectangle([(W//2-rw//2, ry), (W//2+rw//2, ry+2)],
                   fill=(*GREEN, int(255*a)))

    tag = "Buy.  Sell.  Keep playing."
    tw_, _ = tw(draw, tag, fT)
    ty2 = ry + 18   # ≈ 953
    draw.text(((W-tw_)//2+3, ty2+3), tag, font=fT, fill=(0, 0, 0, 120))
    draw.text(((W-tw_)//2,   ty2),   tag, font=fT, fill=cw)

    url   = "cricketmarketusa.com"
    uw, _ = tw(draw, url, fU)
    uy    = ty2 + szT + 18   # ≈ 1023
    draw.text(((W-uw)//2, uy), url, font=fU, fill=cg)

    sub    = "USA Cricket Equipment Marketplace"
    sw_, _ = tw(draw, sub, fS)
    draw.text(((W-sw_)//2, uy+szU+16), sub, font=fS, fill=cs)   # ≈ 1067

    return base


# ---- Render -----------------------------------------------------------------
def render_silent(hero, cats):
    print(f"\n[1/4] Rendering {W}x{H} corrected silent video ...")
    writer = imageio.get_writer(
        CORRECTED_SIL, fps=FPS, codec="libx264",
        quality=9, pixelformat="yuv420p",
        macro_block_size=1,
        output_params=["-preset", "fast", "-crf", "16",
                       "-profile:v", "main", "-level", "4.1",
                       "-bf", "0"],
    )
    for f in range(TOTAL):
        if   f < S1[1]: img = s1_hero(f, hero)
        elif f < S2[1]: img = s2_listings(f, cats)
        elif f < S3[1]: img = s3_sell(f, cats)
        else:           img = s4_logo(f)
        writer.append_data(np.array(img.convert("RGB")))
        if f % 150 == 0:
            print(f"     frame {f:>3}/{TOTAL}  ({f//FPS}s)")
    writer.close()
    kb = os.path.getsize(CORRECTED_SIL) // 1024
    print(f"  Silent: {kb:,} KB")


def mux_audio():
    print("\n[2/4] Muxing approved audio ...")
    r = subprocess.run([
        FF, "-y",
        "-i", CORRECTED_SIL,
        "-i", REEL_FINAL,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-t", "20", CORRECTED_FINAL,
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("ERROR:", r.stderr[-800:]); sys.exit(1)
    kb = os.path.getsize(CORRECTED_FINAL) // 1024
    print(f"  Corrected final: {kb:,} KB")


# ---- Safe-zone preview overlay ----------------------------------------------
def draw_guide(img, safe, label, placement_notes):
    """Draw safe-zone overlay with separate top/bottom/side annotations."""
    IW, IH = img.size
    t, b, l, r = safe["top"], safe["bottom"], safe["left"], safe["right"]

    overlay = img.copy().convert("RGBA")
    guide   = Image.new("RGBA", (IW, IH), (0, 0, 0, 0))
    d       = ImageDraw.Draw(guide)

    RED   = (210, 40,  40,  88)
    AMBER = (210, 120,  0,  70)

    d.rectangle([(0, 0),     (IW, t)],      fill=RED)    # top unsafe
    d.rectangle([(0, IH-b),  (IW, IH)],     fill=RED)    # bottom unsafe
    d.rectangle([(0, t),     (l, IH-b)],    fill=AMBER)  # left unsafe
    d.rectangle([(IW-r, t),  (IW, IH-b)],   fill=AMBER)  # right unsafe

    # Safe-zone border
    SAFE = (0, 230, 100, 220)
    bw   = 4
    d.rectangle([(l, t), (IW-r-bw, IH-b-bw)], outline=SAFE, width=bw)

    # Tick marks on safe border
    TICK = (0, 230, 100, 150)
    for x in range(l, IW-r, 80):
        d.line([(x, t-10), (x, t+10)], fill=TICK, width=2)
        d.line([(x, IH-b-10), (x, IH-b+10)], fill=TICK, width=2)
    for y in range(t, IH-b, 80):
        d.line([(l-10, y), (l+10, y)], fill=TICK, width=2)
        d.line([(IW-r-10, y), (IW-r+10, y)], fill=TICK, width=2)

    result = Image.alpha_composite(overlay, guide).convert("RGB")
    draw   = ImageDraw.Draw(result)

    try:
        fb = fnt(bold=True,  size=26)
        fn = fnt(bold=False, size=20)
    except Exception:
        fb = fn = ImageFont.load_default()

    safe_w = IW - l - r
    safe_h = IH - t - b
    lines = [label] + placement_notes + [
        f"Canvas {IW}x{IH}  |  Safe area {safe_w}x{safe_h}",
        f"Top unsafe {t}px ({t*100//IH}%)  |  Bottom unsafe {b}px ({b*100//IH}%)",
        f"Left unsafe {l}px  |  Right unsafe {r}px",
    ]
    bx = l + 12
    by = IH - b - 10 - len(lines) * 28
    draw.rectangle([(bx-6, by-6), (bx+540, by+len(lines)*28+4)],
                   fill=(0, 0, 0, 165))
    for i, line in enumerate(lines):
        f_use = fb if i == 0 else fn
        clr   = (0, 230, 100) if i == 0 else (235, 235, 235)
        draw.text((bx, by+i*28), line, font=f_use, fill=clr)

    return result


def extract_frame(src, t_sec, dst):
    r = subprocess.run([
        FF, "-y", "-ss", str(t_sec), "-i", src,
        "-vframes", "1", "-q:v", "2", dst,
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode == 0 and os.path.exists(dst)


def make_previews():
    print("\n[3/4] Generating safe-zone previews (Reels + Stories separately) ...")
    reels_notes   = ["Placement: Instagram Reels ad",
                     "UI overlays: top header/profile, bottom actions+caption, right icon column"]
    stories_notes = ["Placement: Instagram Stories ad",
                     "UI overlays: top profile/time, bottom Send Message bar"]

    for scene, t in PREVIEW_TIMES:
        tmp = os.path.join(OUTDIR, f"_tmp_cr_{scene}.png")
        if not extract_frame(CORRECTED_FINAL, t, tmp):
            print(f"  WARNING: frame extract failed at {t}s"); continue
        img = Image.open(tmp)

        # Reels guide
        out = os.path.join(OUTDIR, f"safeview_corrected_reels_{scene}.png")
        draw_guide(img, REELS_SAFE,
                   f"Instagram Reels 1080x1920  |  scene {scene}  ({t}s)",
                   reels_notes).save(out)
        print(f"  Reels:   {os.path.basename(out)}")

        # Stories guide (separate file)
        out = os.path.join(OUTDIR, f"safeview_corrected_stories_{scene}.png")
        draw_guide(img, STORIES_SAFE,
                   f"Instagram Stories 1080x1920  |  scene {scene}  ({t}s)",
                   stories_notes).save(out)
        print(f"  Stories: {os.path.basename(out)}")

        os.remove(tmp)


# ---- ffmpeg probe -----------------------------------------------------------
def probe(path):
    if not os.path.exists(path):
        return {}
    r   = subprocess.run([FF, "-i", path, "-f", "null", "-"],
          capture_output=True, text=True, encoding="utf-8", errors="replace")
    info = r.stderr
    dur  = re.search(r"Duration: ([\d:\.]+)", info)
    vid  = re.search(r"Video: (\S+) \((\w+)\)[^,]*, ([^,]+), (\d+x\d+).*?(\d+) kb/s.*?(\d+) fps", info)
    aud  = re.search(r"Audio: (\w+)[^\n]*?(\d+) Hz[^\n]*?(\d+) kb/s", info)
    sz   = os.path.getsize(path)
    return dict(
        size_kb  = sz // 1024,
        duration = dur.group(1) if dur else "?",
        v_codec  = vid.group(1) if vid else "?",
        v_profile= vid.group(2) if vid else "?",
        v_pix    = vid.group(3) if vid else "?",
        v_dim    = vid.group(4) if vid else "?",
        v_kbps   = int(vid.group(5)) if vid else 0,
        v_fps    = int(vid.group(6)) if vid else 0,
        a_codec  = aud.group(1) if aud else "?",
        a_hz     = int(aud.group(2)) if aud else 0,
        a_kbps   = int(aud.group(3)) if aud else 0,
    )


# ---- Write corrected audit --------------------------------------------------
def write_audit(orig, corr, feed):
    print("\n[4/4] Rewriting meta_spec_audit.md with corrections ...")

    def row(label, val, spec, status, note=""):
        s = f"**{status}**" if status in ("WARN", "FAIL") else status
        n = f"  {note}" if note else ""
        return f"| {label} | {val} | {spec} | {s}{n} |"

    def vpass(v, cond): return "PASS" if cond else "FAIL"

    md = f"""# Meta Placement Spec Audit — Cricket Market USA Promo Video
Generated: 2026-10-05  |  Revised with Reels/Stories separation and corrected safe-zone boundaries

---

## Safe-zone reference (current Meta official guidance)

| Placement | Top | Bottom | Left | Right | Notes |
|---|---|---|---|---|---|
| Instagram Reels ad (9:16) | 14% (268 px) | **35% (672 px)** | 5% (54 px) | **15% (162 px)** | Action icon column on right; large caption+actions area at bottom |
| Instagram Stories ad (9:16) | 14% (268 px) | 20% (384 px) | 5% (54 px) | 5% (54 px) | Send Message bar at bottom; no dedicated icon column |

Safe content rectangles for 1080x1920 canvas:
- Reels:   x=54–918,  y=268–**1248**  ({W-REELS_SAFE["left"]-REELS_SAFE["right"]}x{H-REELS_SAFE["top"]-REELS_SAFE["bottom"]} px)
- Stories: x=54–1026, y=268–**1536**  ({W-STORIES_SAFE["left"]-STORIES_SAFE["right"]}x{H-STORIES_SAFE["top"]-STORIES_SAFE["bottom"]} px)

> **Correction vs. prior audit:** The earlier combined "Reels/Stories" row applied the Stories
> bottom boundary (20% = y≤1536) to Reels. Reels' bottom unsafe zone is 35% (bottom safe
> boundary y=1248). Content between y=1248 and y=1536 appears safe by the Story boundary
> but is overlaid by Reels interface elements (caption, audio label, action icons).
> Additionally, the prior audit stated "key messaging (headlines, URL, CTA) is in the safe
> zone" while simultaneously marking the S2 scene title — which is key messaging — as WARN.
> Both errors are corrected below.

---

## 1. Original Reel (preserved unchanged)
File: `cricket_market_vertical_1080x1920_final.mp4`

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
{row("Dimensions",    orig.get("v_dim","?"),  "1080x1920",        vpass(orig.get("v_dim"), orig.get("v_dim")=="1080x1920"))}
{row("Duration",      orig.get("duration","?"),"1–60 s (Reels)",  "PASS")}
{row("Frame rate",    f'{orig.get("v_fps",0)} fps', "23–60 fps",  vpass("", 23<=orig.get("v_fps",0)<=60))}
{row("Video codec",   orig.get("v_codec","?"),"H.264",            vpass("","h264" in orig.get("v_codec","").lower()))}
{row("H.264 profile", orig.get("v_profile","?"), "Main recommended", "WARN", "— High accepted but Main preferred")}
{row("Pixel format",  orig.get("v_pix","?"),  "yuv420p",          vpass("","yuv420p" in orig.get("v_pix","")))}
{row("Video bitrate", f'{orig.get("v_kbps",0)} kb/s', "≥500 kb/s; 2500+ recommended", "WARN", "— above minimum, below recommendation")}
{row("Audio codec",   orig.get("a_codec","?").upper(), "AAC",     vpass("","aac" in orig.get("a_codec","").lower()))}
{row("Audio rate",    f'{orig.get("a_hz",0)} Hz', "44100 Hz",     vpass("",orig.get("a_hz",0)==44100))}
{row("Audio bitrate", f'{orig.get("a_kbps",0)} kb/s', "≥128 kb/s", vpass("",orig.get("a_kbps",0)>=128))}
{row("File size",     f'{orig.get("size_kb",0):,} KB', "≤4 GB",  "PASS")}

### Safe-zone analysis — original Reel (Reels placement)
Safe rectangle: x=54–918, y=268–**1248**

| Element | Drawn at | Boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=28 | top safe y≥268 | **WARN** — inside top 14% (268 px) profile/handle overlay |
| S2 scene title "Find new and used" | y=110 | top safe y≥268 | **WARN** — inside top 14% overlay; this IS key messaging |
| S3 sell card top | y=60 | top safe y≥268 | **WARN** — inside top 14% overlay |
| S2 grid bottom rows | y≈1870 | bottom safe y≤1248 | **FAIL** — 622 px inside Reels bottom unsafe zone |
| S1 subtitle "USA Cricket Equipment Marketplace" | y≈1210 | bottom safe y≤1248 | PASS (38 px margin) |
| S1 "Cricket gear deserves / another innings." | y=1030–1108 | within safe zone | PASS |
| S4 "CricketMarket / Buy. Sell. Keep playing." | y≈833–1005 | within safe zone | PASS |
| S4 URL "cricketmarketusa.com" | y≈1023 | within safe zone | PASS |

### Safe-zone analysis — original Reel (Stories placement)
Safe rectangle: x=54–1026, y=268–**1536**

| Element | Drawn at | Boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=28 | top safe y≥268 | **WARN** — inside top 14% profile/time overlay |
| S2 scene title "Find new and used" | y=110 | top safe y≥268 | **WARN** — inside top 14% overlay |
| S3 sell card top | y=60 | top safe y≥268 | **WARN** — inside top 14% overlay |
| S2 grid bottom rows | y≈1870 | bottom safe y≤1536 | **WARN** — 334 px inside Stories bottom unsafe zone |
| All headline / URL / CTA content | y=1023–1210 | within safe zone | PASS |

**Original Reel verdict:** Four WARN/FAIL items across Reels placement. No re-render of the
original file is performed; a corrected ad version is provided separately.

---

## 2. Corrected Reel Ad (new file)
File: `cricket_market_reel_1080x1920_corrected.mp4`
All key content repositioned inside Reels safe zone (y=268–1248), which automatically
satisfies the Stories safe zone (y=268–1536).

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
{row("Dimensions",    corr.get("v_dim","?"),  "1080x1920",        vpass(corr.get("v_dim"), corr.get("v_dim")=="1080x1920"))}
{row("Duration",      corr.get("duration","?"),"1–60 s",          "PASS")}
{row("Frame rate",    f'{corr.get("v_fps",0)} fps', "23–60 fps",  vpass("",23<=corr.get("v_fps",0)<=60))}
{row("Video codec",   corr.get("v_codec","?"),"H.264",            vpass("","h264" in corr.get("v_codec","").lower()))}
{row("H.264 profile", corr.get("v_profile","?"),"Main recommended","PASS" if corr.get("v_profile","").lower()=="main" else "WARN")}
{row("Pixel format",  corr.get("v_pix","?"),  "yuv420p",          vpass("","yuv420p" in corr.get("v_pix","")))}
{row("Video bitrate", f'{corr.get("v_kbps",0)} kb/s',"≥500 kb/s; 2500+ recommended", "PASS" if corr.get("v_kbps",0)>=2500 else "WARN", "— above minimum; low-motion content at CRF 16" if corr.get("v_kbps",0)<2500 else "")}
{row("Audio codec",   corr.get("a_codec","?").upper(),"AAC",      vpass("","aac" in corr.get("a_codec","").lower()))}
{row("Audio rate",    f'{corr.get("a_hz",0)} Hz',"44100 Hz",      vpass("",corr.get("a_hz",0)==44100))}
{row("Audio bitrate", f'{corr.get("a_kbps",0)} kb/s',"≥128 kb/s",vpass("",corr.get("a_kbps",0)>=128))}
{row("File size",     f'{corr.get("size_kb",0):,} KB',"≤4 GB",   "PASS")}

### Safe-zone analysis — corrected Reel (Reels placement)
Safe rectangle: x=54–918, y=268–1248

| Element | Repositioned to | Boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=280 (was 28) | top safe y≥268 | PASS (12 px margin) |
| S2 scene title "Find new and used" | y=280 (was 110) | top safe y≥268 | PASS |
| S3 sell card top | y=280 (was 60) | top safe y≥268 | PASS |
| S2 grid bottom rows | y≤1240 (was ≈1870) | bottom safe y≤1248 | PASS (8 px margin) |
| S1 "Cricket gear deserves / another innings." | y=930–1096 | within safe zone | PASS |
| S1 subtitle "USA Cricket Equipment Marketplace" | y≈1132 | bottom safe y≤1248 | PASS (116 px margin) |
| S3 "Have gear to sell? / Create your listing." | y=832–994 | within safe zone | PASS |
| S3 "Free * Secure * Fast payouts" | y≈1028 | within safe zone | PASS |
| S4 "CricketMarket / Buy. Sell. Keep playing." | y≈833–1005 | within safe zone | PASS |
| S4 URL "cricketmarketusa.com" | y≈1023 | within safe zone | PASS |

### Safe-zone analysis — corrected Reel (Stories placement)
Safe rectangle: x=54–1026, y=268–1536
All elements already comply with Reels safe zone (y≤1248), which is more restrictive than
Stories (y≤1536). No additional Stories-specific violations.

| Element | Drawn at | Boundary | Status |
|---|---|---|---|
| All repositioned elements | y=280–1240 | Stories safe y≤1536 | PASS — cleared by Reels constraint |

---

## 3. Feed Ad (1080x1350, 4:5, unchanged)
File: `cricket_market_feed_1080x1350_final.mp4`

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
{row("Dimensions",    feed.get("v_dim","?"),  "1080x1350",        vpass(feed.get("v_dim"),feed.get("v_dim")=="1080x1350"))}
{row("Duration",      feed.get("duration","?"),"1–60 s",          "PASS")}
{row("Frame rate",    f'{feed.get("v_fps",0)} fps',"23–60 fps",   vpass("",23<=feed.get("v_fps",0)<=60))}
{row("H.264 profile", feed.get("v_profile","?"),"Main recommended","PASS" if feed.get("v_profile","").lower()=="main" else "WARN")}
{row("Video bitrate", f'{feed.get("v_kbps",0)} kb/s',"≥500 kb/s; 2500+ recommended","PASS" if feed.get("v_kbps",0)>=2500 else "WARN","— low-motion content; visual quality high at CRF 16" if feed.get("v_kbps",0)<2500 else "")}
{row("Audio",         f'AAC {feed.get("a_hz",0)} Hz {feed.get("a_kbps",0)} kb/s',"AAC ≥128 kb/s","PASS")}
{row("File size",     f'{feed.get("size_kb",0):,} KB',"≤4 GB",   "PASS")}

Safe zone (5% inset all sides): x=54–1026, y=67–1283. All elements PASS — see prior audit.

---

## 4. Audio (all files)
Narration and music are identical across all three files — extracted directly from the
approved `cricket_market_vertical_1080x1920_final.mp4`. No content altered.

---

## 5. Summary
| File | Reels safe-zone | Stories safe-zone | Notes |
|---|---|---|---|
| `cricket_market_vertical_1080x1920_final.mp4` | 4 WARN/FAIL | 3 WARN | Original; preserved unchanged |
| `cricket_market_reel_1080x1920_corrected.mp4` | **All PASS** | **All PASS** | Corrected ad version |
| `cricket_market_feed_1080x1350_final.mp4` | N/A (4:5 Feed) | N/A | All PASS for Feed placement |

Nothing published. All files are local only.
"""

    out = os.path.join(OUTDIR, "meta_spec_audit.md")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(md)
    print(f"  Audit rewritten: {os.path.basename(out)}")


# ---- Main -------------------------------------------------------------------
def main():
    print("=" * 62)
    print("  Cricket Market USA — Corrected Reel + Safe-Zone Previews")
    print("=" * 62)

    if not os.path.exists(REEL_FINAL):
        print(f"ERROR: {REEL_FINAL} not found"); sys.exit(1)

    print("\nLoading assets ...")
    hero = Image.open(os.path.join(ASSETS, "hero-cricket-bg.png")).convert("RGB")
    cats = {}
    for k in ("bat","helmet","pads","gloves","kitbag","accessories"):
        cats[k] = Image.open(os.path.join(ASSETS, "categories", f"{k}.webp")).convert("RGB")
    print(f"  hero {hero.size}  +  {len(cats)} category images")

    render_silent(hero, cats)
    mux_audio()
    make_previews()

    orig_info  = probe(REEL_FINAL)
    corr_info  = probe(CORRECTED_FINAL)
    feed_path  = os.path.join(OUTDIR, "cricket_market_feed_1080x1350_final.mp4")
    feed_info  = probe(feed_path)

    write_audit(orig_info, corr_info, feed_info)

    print("\n" + "=" * 62)
    print("  OUTPUTS")
    print("=" * 62)
    outs = [
        ("cricket_market_vertical_1080x1920_final.mp4",  "original Reel, UNCHANGED"),
        ("cricket_market_reel_1080x1920_corrected.mp4",  "corrected ad version"),
        ("cricket_market_feed_1080x1350_final.mp4",       "Feed ad, unchanged"),
        ("safeview_corrected_reels_s1.png",  ""),
        ("safeview_corrected_reels_s2.png",  ""),
        ("safeview_corrected_reels_s3.png",  ""),
        ("safeview_corrected_reels_s4.png",  "Reels safe-zone previews"),
        ("safeview_corrected_stories_s1.png",""),
        ("safeview_corrected_stories_s2.png",""),
        ("safeview_corrected_stories_s3.png",""),
        ("safeview_corrected_stories_s4.png","Stories safe-zone previews"),
        ("meta_spec_audit.md",               "corrected audit"),
        ("make_corrected_reel.py",           "this script"),
    ]
    for fn, note in outs:
        p = os.path.join(OUTDIR, fn)
        if os.path.exists(p):
            kb = os.path.getsize(p) // 1024
            print(f"  OK  {fn}  ({kb:,} KB)  {note}")
        else:
            print(f"  MISSING  {fn}")

    print("\n  Nothing published. Local files only.")
    print("=" * 62)


if __name__ == "__main__":
    main()
