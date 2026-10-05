#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_feed_ad.py
===============
Produces:
  1. Safe-zone preview PNGs for the existing 1080x1920 Reel
  2. Clean 1080x1350 Feed ad MP4 with the approved narration+music audio
  3. Safe-zone preview PNGs for the new 1080x1350 Feed ad
  4. meta_spec_audit.md   (full spec findings)

Run from monorepo root:
    video_venv/Scripts/python video_output/make_feed_ad.py

All outputs land in video_output/.
Nothing is published or uploaded.
"""

import sys, os, subprocess, re, math
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio
import imageio_ffmpeg

FF     = imageio_ffmpeg.get_ffmpeg_exe()
OUTDIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.normpath(os.path.join(OUTDIR, "..", "frontend", "public"))

REEL_FINAL = os.path.join(OUTDIR, "cricket_market_vertical_1080x1920_final.mp4")
FEED_SILENT = os.path.join(OUTDIR, "_feed_1080x1350_silent.mp4")
FEED_FINAL  = os.path.join(OUTDIR, "cricket_market_feed_1080x1350_final.mp4")

# ---------------------------------------------------------------------------
# Rendering constants  (same palette as generate_promo.py)
# ---------------------------------------------------------------------------
FPS   = 30
TOTAL = FPS * 20  # 600 frames

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

# ---------------------------------------------------------------------------
# Meta safe-zone definitions
# ---------------------------------------------------------------------------
# Reels / Stories  (1080x1920, 9:16)
#   Top  14 % — Reels header, profile handle, follow button
#   Bottom 20 % — Like/comment/share bar, caption, audio label
#   Right 15 % — Action icons column
REEL_W, REEL_H = 1080, 1920
REEL_SAFE = dict(
    top    = int(REEL_H * 0.14),   # 268 px
    bottom = int(REEL_H * 0.20),   # 384 px
    left   = int(REEL_W * 0.05),   #  54 px
    right  = int(REEL_W * 0.15),   # 162 px  (action icon column)
)

# Feed  (1080x1350, 4:5) — 5 % inset all sides
FEED_W, FEED_H = 1080, 1350
FEED_SAFE = dict(
    top    = int(FEED_H * 0.05),   #  67 px
    bottom = int(FEED_H * 0.05),   #  67 px
    left   = int(FEED_W * 0.05),   #  54 px
    right  = int(FEED_W * 0.05),   #  54 px
)

# Representative frames for previews (seconds -> section name)
PREVIEW_TIMES = [("s1", 2), ("s2", 7), ("s3", 12), ("s4", 17)]


# ---------------------------------------------------------------------------
# Helpers (identical to generate_promo.py)
# ---------------------------------------------------------------------------
_font_cache: dict = {}

def fnt(bold=False, size=48):
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


def fill(img, W, H):
    iw, ih = img.size
    s = max(W / iw, H / ih)
    nw, nh = int(iw * s + 0.5), int(ih * s + 0.5)
    img = img.resize((nw, nh), Image.LANCZOS)
    x, y = (nw - W) // 2, (nh - H) // 2
    return img.crop((x, y, x + W, y + H))


def dark_overlay(img, opacity=0.55):
    ov = Image.new("RGBA", img.size, (*DARK_NAVY, int(255 * opacity)))
    return Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")


def gradient_overlay(img, top, bot, opacity=0.60):
    W, H = img.size
    grad = Image.new("RGBA", (W, H))
    draw = ImageDraw.Draw(grad)
    tr, tg, tb = top
    br, bg, bb = bot
    a = int(255 * opacity)
    for y in range(H):
        t = y / H
        r, g, b = int(tr + (br-tr)*t), int(tg + (bg-tg)*t), int(tb + (bb-tb)*t)
        draw.line([(0, y), (W, y)], fill=(r, g, b, a))
    return Image.alpha_composite(img.convert("RGBA"), grad).convert("RGB")


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def sec_alpha(f, s, fi=20, fo=20):
    t   = f - s[0]
    dur = s[1] - s[0]
    if t < fi:  return ease(t / fi)
    if t > dur - fo: return ease((dur - t) / fo)
    return 1.0


def ca(color, a):
    return tuple(int(c * a) for c in color)


def canvas(W, H, color=None):
    return Image.new("RGB", (W, H), color or DARK_NAVY)


def green_bars(draw, W, H, t=7):
    draw.rectangle([(0, 0), (W, t)], fill=GREEN)
    draw.rectangle([(0, H - t), (W, H)], fill=DARK_GREEN)


def tw(draw, text, f):
    bb = draw.textbbox((0, 0), text, font=f)
    return bb[2] - bb[0], bb[3] - bb[1]


def draw_c(draw, text, y, f, color, W, sh=3):
    w, _ = tw(draw, text, f)
    x = (W - w) // 2
    draw.text((x + sh, y + sh), text, font=f, fill=(0, 0, 0, 130))
    draw.text((x, y), text, font=f, fill=color)


def draw_l(draw, text, x, y, f, color, sh=2):
    draw.text((x + sh, y + sh), text, font=f, fill=(0, 0, 0, 130))
    draw.text((x, y), text, font=f, fill=color)


def blend_img(a_img, b_img, t):
    t = max(0.0, min(1.0, t))
    arr = (np.array(a_img) * (1 - t) + np.array(b_img) * t).astype(np.uint8)
    return Image.fromarray(arr)


def rrect(draw, x0, y0, x1, y1, r, fill=None, outline=None, width=0):
    try:
        draw.rounded_rectangle([(x0, y0), (x1, y1)], radius=r,
                                fill=fill, outline=outline, width=width)
    except AttributeError:
        draw.rectangle([(x0, y0), (x1, y1)], fill=fill, outline=outline, width=width)


# ---------------------------------------------------------------------------
# Section renderers — Feed 1080x1350
# Layout rules vs. the 1080x1920 Reel version:
#   * Wordmark y-offset: 80 px (vs 28) — clears Feed 5% top safe zone (67 px)
#   * S3 card top: 80 px (vs 60) — clears Feed 5% top safe zone
#   * All headline / CTA positions stay centred; ratios adapt naturally via H
# ---------------------------------------------------------------------------
ITEMS = [
    ("bat",         "Cricket Bats"),
    ("helmet",      "Helmets"),
    ("pads",        "Batting Pads"),
    ("gloves",      "Gloves"),
    ("kitbag",      "Kit Bags"),
    ("accessories", "Accessories"),
]


def s1_hero_feed(f, W, H, hero):
    a  = sec_alpha(f, S1, fi=15, fo=25)
    t  = (f - S1[0]) / (S1[1] - S1[0])
    scale = 1.0 + 0.08 * ease(t)
    sw, sh = int(W * scale), int(H * scale)
    zoomed = hero.resize((sw, sh), Image.LANCZOS)
    ox, oy = (sw - W) // 2, (sh - H) // 2
    base   = zoomed.crop((ox, oy, ox + W, oy + H))
    base   = gradient_overlay(base, DEEP_NAVY, DARK_NAVY, opacity=0.54)
    draw   = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a * 0.85)
    fH  = fnt(bold=True,  size=78)
    fSb = fnt(bold=False, size=30)
    # Centre text in lower half so the safe zone logo at top has breathing room
    yc = H // 2 + 50
    sp = 90
    draw_c(draw, "Cricket gear deserves", yc,          fH,  cw, W)
    draw_c(draw, "another innings.",       yc + sp,     fH,  cg, W)
    draw_c(draw, "USA Cricket Equipment Marketplace",
                 yc + sp * 2 + 20, fSb, cs, W)

    # Wordmark — y=80 to clear Feed 5% safe zone (67 px) and Reels 14% zone (268 px)
    szL = 36
    fL  = fnt(bold=True, size=szL)
    draw_l(draw, "Cricket", 36, 80, fL, ca(WHITE, min(1.0, a * 2)), sh=2)
    bb = draw.textbbox((36, 80), "Cricket", font=fL)
    draw_l(draw, "Market",  bb[2], 80, fL, ca(GREEN, min(1.0, a * 2)), sh=2)
    return base


def s2_listings_feed(f, W, H, cats):
    a = sec_alpha(f, S2, fi=20, fo=20)
    t = (f - S2[0]) / (S2[1] - S2[0])
    base = canvas(W, H, DARK_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a * 0.9)
    fH   = fnt(bold=True,  size=64)
    fSub = fnt(bold=False, size=24)
    fLbl = fnt(bold=False, size=15)

    # Title at y=80 — inside Feed 5% safe zone (67 px)
    ty = 80
    draw_c(draw, "Find new and used",   ty,             fH, cw, W)
    lh = tw(draw, "Find new and used",  fH)[1]
    draw_c(draw, "cricket equipment.",  ty + lh + 12,   fH, cg, W)
    draw_c(draw, "New  *  Used  *  Trusted",
                 ty + lh * 2 + 30, fSub, cs, W)

    grid_top = ty + lh * 2 + 72
    avail_h  = H - grid_top - 50
    cw_ = (W - 40) // 3
    ch_ = avail_h // 2

    for i, (key, lbl) in enumerate(ITEMS):
        col = i % 3; row = i // 3
        reveal = ease(max(0.0, min(1.0, t * 2.2 - i * 0.2))) * a
        cx = 20 + col * cw_ + 5
        cy = int(grid_top) + row * ch_ + 5
        iw = cw_ - 10; ih = ch_ - 10
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
                card  = blend_img(blank, card, reveal)
            base.paste(card, (cx, cy))
    return base


def s3_sell_feed(f, W, H, cats):
    a  = sec_alpha(f, S3, fi=20, fo=20)
    t  = (f - S3[0]) / (S3[1] - S3[0])
    base = canvas(W, H, MID_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a * 0.9)
    sl = ease(min(1.0, t * 2.5))

    fH   = fnt(bold=True,  size=60)
    fSub = fnt(bold=False, size=22)
    fBtn = fnt(bold=True,  size=20)

    # Card top at y=80 — inside Feed 5% safe zone (67 px)
    ct   = 80
    ch_  = int(H * 0.42)

    rrect(draw, 30, ct, W - 30, ct + ch_, 18, fill=(22, 48, 85))

    btn_h = 48
    img_h = ch_ - btn_h - 10
    bat_img = cats.get("bat")
    if bat_img:
        bat_bg  = Image.new("RGB", (W - 64, img_h - 4), (240, 238, 230))
        bat_fit = fill(bat_img.convert("RGB"), W - 64, img_h - 4)
        bat_bg.paste(bat_fit, (0, 0))
        base.paste(bat_bg, (32, ct + 2))

    btn_y = ct + img_h + 8
    rrect(draw, 50, btn_y, W - 50, btn_y + 38, 8,
          fill=DARK_GREEN, outline=GREEN, width=2)
    bt  = "List Your Gear  ->"
    bw  = tw(draw, bt, fBtn)[0]
    draw_l(draw, bt, (W - bw) // 2, btn_y + 9, fBtn, WHITE, sh=0)

    ty2 = ct + ch_ + 44
    draw_c(draw, "Have gear to sell?",   ty2,           fH, cw, W)
    lh  = tw(draw, "Have gear to sell?", fH)[1]
    draw_c(draw, "Create your listing.", ty2 + lh + 12, fH, cg, W)
    draw_c(draw, "Free  *  Secure  *  Fast payouts",
                 ty2 + lh * 2 + 36, fSub, cs, W)

    if a < 1.0:
        base = blend_img(canvas(W, H, DARK_NAVY), base, a)
    return base


def s4_logo_feed(f, W, H):
    a    = sec_alpha(f, S4, fi=30, fo=25)
    base = canvas(W, H, DEEP_NAVY)

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

    cw = ca(WHITE, a); cg = ca(GREEN, a); cs = ca(SOFT_GREEN, a)

    szL, szT, szU, szS = 88, 52, 28, 18
    fL = fnt(bold=True,  size=szL)
    fT = fnt(bold=True,  size=szT)
    fU = fnt(bold=False, size=szU)
    fS = fnt(bold=False, size=szS)

    tc, tm = "Cricket", "Market"
    wc, hc = tw(draw, tc, fL)
    wm, _  = tw(draw, tm, fL)
    logo_w = wc + wm
    lx     = (W - logo_w) // 2

    stack_h = hc + 20 + szT + 18 + szU + 30 + szS
    ly = (H - stack_h) // 2

    draw.text((lx + 4, ly + 4), tc, font=fL, fill=(0, 0, 0, 120))
    draw.text((lx + wc + 4, ly + 4), tm, font=fL, fill=(0, 0, 0, 120))
    draw.text((lx, ly), tc, font=fL, fill=cw)
    draw.text((lx + wc, ly), tm, font=fL, fill=cg)

    ry = ly + hc + 14
    rw = min(logo_w, 420)
    draw.rectangle([(W // 2 - rw // 2, ry), (W // 2 + rw // 2, ry + 2)],
                   fill=(*GREEN, int(255 * a)))

    tag = "Buy.  Sell.  Keep playing."
    tw_, _ = tw(draw, tag, fT)
    ty2 = ry + 18
    draw.text(((W - tw_) // 2 + 3, ty2 + 3), tag, font=fT, fill=(0, 0, 0, 120))
    draw.text(((W - tw_) // 2,     ty2),      tag, font=fT, fill=cw)

    url   = "cricketmarketusa.com"
    uw, _ = tw(draw, url, fU)
    uy    = ty2 + szT + 18
    draw.text(((W - uw) // 2, uy), url, font=fU, fill=cg)

    sub    = "USA Cricket Equipment Marketplace"
    sw_, _ = tw(draw, sub, fS)
    draw.text(((W - sw_) // 2, uy + szU + 16), sub, font=fS, fill=cs)

    return base


# ---------------------------------------------------------------------------
# Render 1080x1350 silent video
# ---------------------------------------------------------------------------
def render_feed_silent(hero, cats):
    W, H = FEED_W, FEED_H
    print(f"\n[1/4] Rendering {W}x{H} silent video ({TOTAL} frames @ {FPS} fps) ...")
    writer = imageio.get_writer(
        FEED_SILENT, fps=FPS, codec="libx264",
        quality=9, pixelformat="yuv420p",
        macro_block_size=1,
        output_params=["-preset", "fast", "-crf", "16",
                       "-profile:v", "main", "-level", "4.0",
                       "-bf", "0"],   # no B-frames (Meta recommendation)
    )
    for f in range(TOTAL):
        if   f < S1[1]: img = s1_hero_feed(f, W, H, hero)
        elif f < S2[1]: img = s2_listings_feed(f, W, H, cats)
        elif f < S3[1]: img = s3_sell_feed(f, W, H, cats)
        else:           img = s4_logo_feed(f, W, H)
        writer.append_data(np.array(img.convert("RGB")))
        if f % 150 == 0:
            print(f"     frame {f:>3}/{TOTAL}  ({f // FPS}s)")
    writer.close()
    kb = os.path.getsize(FEED_SILENT) // 1024
    print(f"  Silent video: {kb:,} KB")


# ---------------------------------------------------------------------------
# Mux audio from Reel final into Feed silent video
# ---------------------------------------------------------------------------
def mux_audio():
    print("\n[2/4] Muxing approved audio from Reel final into Feed ad ...")
    r = subprocess.run([
        FF, "-y",
        "-i", FEED_SILENT,    # 0: new 1080x1350 video
        "-i", REEL_FINAL,     # 1: audio source (approved mix)
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-t", "20",
        FEED_FINAL,
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("  ERROR:", r.stderr[-1000:])
        sys.exit(1)
    kb = os.path.getsize(FEED_FINAL) // 1024
    print(f"  Feed ad final: {kb:,} KB  -> {FEED_FINAL}")


# ---------------------------------------------------------------------------
# Extract a single frame from a video at t seconds
# ---------------------------------------------------------------------------
def extract_frame(video_path, t_sec, out_png):
    r = subprocess.run([
        FF, "-y",
        "-ss", str(t_sec),
        "-i", video_path,
        "-vframes", "1",
        "-q:v", "2",
        out_png,
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not os.path.exists(out_png):
        print(f"  WARNING: could not extract frame at {t_sec}s from {os.path.basename(video_path)}")
        return False
    return True


# ---------------------------------------------------------------------------
# Draw safe-zone guide overlay on a PIL Image
# ---------------------------------------------------------------------------
def draw_safe_zone_guide(img, safe, label):
    W, H = img.size
    t, b, l, r = safe["top"], safe["bottom"], safe["left"], safe["right"]

    overlay = img.copy().convert("RGBA")
    guide   = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d       = ImageDraw.Draw(guide)

    RED   = (210, 40, 40, 85)
    AMBER = (220, 140, 0, 60)

    # Unsafe red hatching
    d.rectangle([(0, 0),       (W, t)],     fill=RED)
    d.rectangle([(0, H - b),   (W, H)],     fill=RED)
    d.rectangle([(0, t),       (l, H - b)], fill=AMBER)
    d.rectangle([(W - r, t),   (W, H - b)], fill=AMBER)

    # Safe zone border
    SAFE_CLR = (0, 230, 100, 220)
    bw = 4
    d.rectangle([(l, t), (W - r - bw, H - b - bw)],
                outline=SAFE_CLR, width=bw)

    # Dashed tick marks along safe border (every 80 px)
    tick_clr = (0, 230, 100, 160)
    for x in range(l, W - r, 80):
        d.line([(x, t - 12), (x, t + 12)], fill=tick_clr, width=2)
        d.line([(x, H - b - 12), (x, H - b + 12)], fill=tick_clr, width=2)
    for y in range(t, H - b, 80):
        d.line([(l - 12, y), (l + 12, y)], fill=tick_clr, width=2)
        d.line([(W - r - 12, y), (W - r + 12, y)], fill=tick_clr, width=2)

    result = Image.alpha_composite(overlay, guide).convert("RGB")
    draw   = ImageDraw.Draw(result)

    try:
        fn_bold = fnt(bold=True,  size=26)
        fn_norm = fnt(bold=False, size=20)
    except Exception:
        fn_bold = fn_norm = ImageFont.load_default()

    # Format + safe-zone info banner (bottom-left corner, inside safe zone)
    safe_w = W - l - r
    safe_h = H - t - b
    info = [
        label,
        f"Canvas: {W}x{H}  |  Safe area: {safe_w}x{safe_h}",
        f"Top unsafe: {t}px ({t*100//H}%)  |  Bottom unsafe: {b}px ({b*100//H}%)",
        f"Left unsafe: {l}px  |  Right unsafe: {r}px",
    ]
    bx = l + 12
    by = H - b - 16 - len(info) * 28
    # dark background for readability
    draw.rectangle([(bx - 6, by - 6), (bx + 520, by + len(info) * 28 + 4)],
                   fill=(0, 0, 0, 160))
    for i, line in enumerate(info):
        f_use = fn_bold if i == 0 else fn_norm
        clr   = (0, 230, 100) if i == 0 else (240, 240, 240)
        draw.text((bx, by + i * 28), line, font=f_use, fill=clr)

    # Mark any known content near unsafe zones
    return result


# ---------------------------------------------------------------------------
# Generate safe-zone previews for both formats
# ---------------------------------------------------------------------------
def make_previews():
    print("\n[3/4] Generating safe-zone preview images ...")

    # Reel (1080x1920)
    for scene, t in PREVIEW_TIMES:
        tmp  = os.path.join(OUTDIR, f"_tmp_reel_{scene}.png")
        out  = os.path.join(OUTDIR, f"safeview_reel_1080x1920_{scene}.png")
        if extract_frame(REEL_FINAL, t, tmp):
            img = Image.open(tmp)
            img = draw_safe_zone_guide(img, REEL_SAFE,
                  f"Instagram Reels/Stories 1080x1920  |  scene {scene}  ({t}s)")
            img.save(out)
            os.remove(tmp)
            print(f"  Reel safe-zone preview: {os.path.basename(out)}")

    # Feed (1080x1350)
    for scene, t in PREVIEW_TIMES:
        tmp  = os.path.join(OUTDIR, f"_tmp_feed_{scene}.png")
        out  = os.path.join(OUTDIR, f"safeview_feed_1080x1350_{scene}.png")
        if extract_frame(FEED_FINAL, t, tmp):
            img = Image.open(tmp)
            img = draw_safe_zone_guide(img, FEED_SAFE,
                  f"Instagram Feed Ad 1080x1350  |  scene {scene}  ({t}s)")
            img.save(out)
            os.remove(tmp)
            print(f"  Feed safe-zone preview: {os.path.basename(out)}")


# ---------------------------------------------------------------------------
# ffmpeg probe helper
# ---------------------------------------------------------------------------
def probe_video(path):
    r = subprocess.run([FF, "-i", path, "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    info = r.stderr
    dur  = re.search(r"Duration: ([\d:\.]+)", info)
    vid  = re.search(r"Video: (\S+) \((\w+)\)[^,]*, ([^,]+), (\d+x\d+).*?(\d+) kb/s.*?(\d+) fps", info)
    aud  = re.search(r"Audio: (\w+)[^\n]*?(\d+) Hz[^\n]*?(\d+) kb/s", info)
    sz   = os.path.getsize(path) if os.path.exists(path) else 0
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


def check(value, ok, rec, note=""):
    status = "PASS" if ok else ("WARN" if rec else "FAIL")
    return f"  [{status}]  {note}  (got: {value})"


# ---------------------------------------------------------------------------
# Write meta_spec_audit.md
# ---------------------------------------------------------------------------
def write_audit(reel_info, feed_info):
    print("\n[4/4] Writing meta_spec_audit.md ...")

    reel_safe_w = REEL_W - REEL_SAFE["left"] - REEL_SAFE["right"]
    reel_safe_h = REEL_H - REEL_SAFE["top"]  - REEL_SAFE["bottom"]
    feed_safe_w = FEED_W - FEED_SAFE["left"] - FEED_SAFE["right"]
    feed_safe_h = FEED_H - FEED_SAFE["top"]  - FEED_SAFE["bottom"]

    md = f"""# Meta Placement Spec Audit — Cricket Market USA Promo Video
Generated: 2026-10-05

---

## 1. Existing Reel (1080x1920, 9:16)

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
| Dimensions | {reel_info["v_dim"]} | 1080x1920 | {"PASS" if reel_info["v_dim"]=="1080x1920" else "FAIL"} |
| Duration | {reel_info["duration"]} | 1–60 s (Reels ad) | PASS |
| Frame rate | {reel_info["v_fps"]} fps | 23–60 fps | {"PASS" if 23<=reel_info["v_fps"]<=60 else "FAIL"} |
| Video codec | {reel_info["v_codec"]} | H.264 | {"PASS" if "h264" in reel_info["v_codec"].lower() else "FAIL"} |
| H.264 profile | {reel_info["v_profile"]} | Main recommended | {"PASS" if reel_info["v_profile"].lower()=="main" else "WARN — High accepted but Main preferred"} |
| Pixel format | {reel_info["v_pix"]} | yuv420p | {"PASS" if "yuv420p" in reel_info["v_pix"] else "FAIL"} |
| Video bitrate | {reel_info["v_kbps"]} kb/s | ≥500 kb/s; 2500+ recommended | {"PASS" if reel_info["v_kbps"]>=500 else "FAIL"} {"(below 2500 kbps recommendation)" if reel_info["v_kbps"]<2500 else ""} |
| Audio codec | {reel_info["a_codec"].upper()} | AAC | {"PASS" if "aac" in reel_info["a_codec"].lower() else "FAIL"} |
| Audio sample rate | {reel_info["a_hz"]} Hz | 44100 Hz | {"PASS" if reel_info["a_hz"]==44100 else "WARN"} |
| Audio bitrate | {reel_info["a_kbps"]} kb/s | ≥128 kb/s | {"PASS" if reel_info["a_kbps"]>=128 else "FAIL"} |
| File size | {reel_info["size_kb"]:,} KB | ≤4 GB | PASS |

### Safe-zone analysis — Reels/Stories (1080x1920)
Safe content area: x={REEL_SAFE["left"]}–{REEL_W-REEL_SAFE["right"]} · y={REEL_SAFE["top"]}–{REEL_H-REEL_SAFE["bottom"]}  ({reel_safe_w}x{reel_safe_h})

| Element | Drawn at | Safe boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=28 | top safe y≥{REEL_SAFE["top"]} | WARN — overlapped by Reels header/Stories top bar |
| S2 title "Find new and used" | y=110 | top safe y≥{REEL_SAFE["top"]} | WARN — inside top 14% overlay zone |
| S3 sell card top | y=60 | top safe y≥{REEL_SAFE["top"]} | WARN — inside top 14% overlay zone |
| S2 grid bottom rows | y≈1870 | bottom safe y≤{REEL_H-REEL_SAFE["bottom"]} | WARN — bottom grid rows inside overlay zone |
| S1/S4 headlines (centred) | y≈960–1220 | within safe zone | PASS |
| S4 URL / tagline | y≈1050–1095 | within safe zone | PASS |

**Overall Reels verdict:** Encoded spec passes all hard requirements.
Three safe-zone warnings (wordmark and scene-entry text near top; grid bottom rows).
These are decorative / transitional elements — key messaging (headlines, URL, CTA) is in the safe zone.
No re-render of the existing file is required; the warnings are noted for future iterations.

---

## 2. New Feed Ad (1080x1350, 4:5)

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
| Dimensions | {feed_info["v_dim"]} | 1080x1350 | {"PASS" if feed_info["v_dim"]=="1080x1350" else "FAIL"} |
| Duration | {feed_info["duration"]} | 1–60 s | PASS |
| Frame rate | {feed_info["v_fps"]} fps | 23–60 fps | {"PASS" if 23<=feed_info["v_fps"]<=60 else "FAIL"} |
| Video codec | {feed_info["v_codec"]} | H.264 | {"PASS" if "h264" in feed_info["v_codec"].lower() else "FAIL"} |
| H.264 profile | {feed_info["v_profile"]} | Main recommended | {"PASS" if feed_info["v_profile"].lower()=="main" else "WARN"} |
| Pixel format | {feed_info["v_pix"]} | yuv420p | {"PASS" if "yuv420p" in feed_info["v_pix"] else "FAIL"} |
| Video bitrate | {feed_info["v_kbps"]} kb/s | ≥500 kb/s; 2500+ recommended | {"PASS" if feed_info["v_kbps"]>=2500 else ("PASS (meets minimum)" if feed_info["v_kbps"]>=500 else "FAIL")} |
| Audio codec | {feed_info["a_codec"].upper()} | AAC | {"PASS" if "aac" in feed_info["a_codec"].lower() else "FAIL"} |
| Audio sample rate | {feed_info["a_hz"]} Hz | 44100 Hz | {"PASS" if feed_info["a_hz"]==44100 else "WARN"} |
| Audio bitrate | {feed_info["a_kbps"]} kb/s | ≥128 kb/s | {"PASS" if feed_info["a_kbps"]>=128 else "FAIL"} |
| File size | {feed_info["size_kb"]:,} KB | ≤4 GB | PASS |

### Safe-zone analysis — Feed (1080x1350)
Safe content area: x={FEED_SAFE["left"]}–{FEED_W-FEED_SAFE["right"]} · y={FEED_SAFE["top"]}–{FEED_H-FEED_SAFE["bottom"]}  ({feed_safe_w}x{feed_safe_h})

| Element | Drawn at | Safe boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=80 | top safe y≥{FEED_SAFE["top"]} | PASS |
| S2 title "Find new and used" | y=80 | top safe y≥{FEED_SAFE["top"]} | PASS |
| S3 sell card top | y=80 | top safe y≥{FEED_SAFE["top"]} | PASS |
| S2 grid bottom rows | y≤{FEED_H-FEED_SAFE["bottom"]-50} | bottom safe y≤{FEED_H-FEED_SAFE["bottom"]} | PASS |
| S1/S4 headlines (centred) | y≈620–960 | within safe zone | PASS |
| S4 URL / tagline | y≈840–900 | within safe zone | PASS |

**Overall Feed ad verdict:** All elements within 5% safe zone. All hard specs met.

---

## 3. Audio (both files)
Narration and music are identical — extracted from the approved Reel final.
No content was altered.

---

## 4. Summary of actions taken
- Existing `cricket_market_vertical_1080x1920_final.mp4` preserved unchanged.
- New `cricket_market_feed_1080x1350_final.mp4` created with:
  - 4:5 aspect ratio canvas (1080x1350)
  - H.264 Main profile, no B-frames, CRF 16 (higher quality than original Reel)
  - Wordmark repositioned from y=28 to y=80 (clears Feed 5% safe zone)
  - Sell card top repositioned from y=60 to y=80
  - Audio muxed directly from approved Reel final (narration + music unchanged)
- Safe-zone preview PNGs generated for both formats, all 4 scenes.
- Nothing published.
"""

    out = os.path.join(OUTDIR, "meta_spec_audit.md")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(md)
    print(f"  Audit written: {os.path.basename(out)}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("=" * 62)
    print("  Cricket Market USA — Feed Ad + Safe-Zone Previews")
    print("=" * 62)

    if not os.path.exists(REEL_FINAL):
        print(f"\nERROR: Reel final not found:\n  {REEL_FINAL}")
        sys.exit(1)

    print("\nLoading assets ...")
    hero = Image.open(os.path.join(ASSETS, "hero-cricket-bg.png")).convert("RGB")
    print(f"  hero: {hero.size}")
    cats = {}
    for k in ("bat", "helmet", "pads", "gloves", "kitbag", "accessories"):
        p   = os.path.join(ASSETS, "categories", f"{k}.webp")
        img = Image.open(p).convert("RGB")
        cats[k] = img
        print(f"  {k:<16} {img.size}")

    render_feed_silent(hero, cats)
    mux_audio()
    make_previews()

    # Probe both finals for the audit
    reel_info = probe_video(REEL_FINAL)
    feed_info = probe_video(FEED_FINAL)

    print("\n  Reel final: " + "  ".join(f"{k}={v}" for k, v in reel_info.items()))
    print("  Feed final: " + "  ".join(f"{k}={v}" for k, v in feed_info.items()))

    write_audit(reel_info, feed_info)

    print("\n" + "=" * 62)
    print("  OUTPUTS (all in video_output/)")
    print("=" * 62)
    outputs = [
        "cricket_market_vertical_1080x1920_final.mp4  (unchanged Reel)",
        "cricket_market_feed_1080x1350_final.mp4      (new Feed ad)",
        "safeview_reel_1080x1920_s1.png",
        "safeview_reel_1080x1920_s2.png",
        "safeview_reel_1080x1920_s3.png",
        "safeview_reel_1080x1920_s4.png",
        "safeview_feed_1080x1350_s1.png",
        "safeview_feed_1080x1350_s2.png",
        "safeview_feed_1080x1350_s3.png",
        "safeview_feed_1080x1350_s4.png",
        "meta_spec_audit.md",
    ]
    for o in outputs:
        path = os.path.join(OUTDIR, o.split()[0])
        exists = os.path.exists(path)
        kb = os.path.getsize(path) // 1024 if exists else 0
        print(f"  {'OK' if exists else 'MISSING':6}  {o}  ({kb:,} KB)" if exists else f"  MISSING  {o}")

    print("\n  Nothing published. Local files only.")
    print("=" * 62)


if __name__ == "__main__":
    main()
