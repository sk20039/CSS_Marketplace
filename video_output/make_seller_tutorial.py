#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cricket Market USA -- Seller Tutorial Video Generator
42 s · 30 fps · 1920x1080 (wide) + 1080x1920 (vertical)

Steps from actual code:
  S1  0-5 s    Hero intro
  S2  5-13 s   /register  (role toggle → form → email check screen)
  S3  13-18 s  Email verified → /login
  S4  18-27 s  /dashboard/seller  (Stripe Connect + ship-from address)
  S5  27-36 s  /listings/new  (category, condition, price, photos)
  S6  36-42 s  Publish Selected → listing Active

Demo data (fictional only):
  Name: Alex Chen · Email: alex@example.com
  Listing: Kookaburra Pro 750 Cricket Bat · Used – Good · $85.00
  Ship-from: 123 Cricket Lane, Houston, TX 77001

No production data, no real accounts, no network calls.
"""

import sys, os
import numpy as np
import imageio
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Palette ───────────────────────────────────────────────────────────────────
DARK_NAVY  = (10,  25,  47)
MID_NAVY   = (13,  35,  65)
DEEP_NAVY  = (6,   16,  32)
GREEN      = (21,  128, 61)
DARK_GREEN = (16,  100, 48)
WHITE      = (255, 255, 255)
SOFT_GREEN = (140, 210, 155)
LIGHT_GRAY = (248, 249, 250)
GRAY_100   = (243, 244, 246)
GRAY_200   = (229, 231, 235)
GRAY_300   = (209, 213, 219)
GRAY_500   = (107, 114, 128)
GRAY_700   = (55,  65,  81)
GRAY_900   = (17,  24,  39)
AMBER_50   = (255, 251, 235)
AMBER_200  = (253, 230, 138)
AMBER_700  = (180, 83,  9)
AMBER_900  = (120, 53,  15)

# ── Timing (30 fps) ───────────────────────────────────────────────────────────
FPS   = 30
TOTAL = 42 * FPS   # 1260 frames

S1 = (0,    150)
S2 = (150,  390)
S3 = (390,  540)
S4 = (540,  810)
S5 = (810,  1080)
S6 = (1080, 1260)

OUTDIR = os.path.dirname(os.path.abspath(__file__))

# ── Font loader ───────────────────────────────────────────────────────────────
_fc: dict = {}

def fnt(bold=False, size=32):
    key = (bold, size)
    if key in _fc:
        return _fc[key]
    cands = (
        ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/Arialbd.ttf",
         "C:/Windows/Fonts/calibrib.ttf", "C:/Windows/Fonts/Verdanab.ttf"]
        if bold else
        ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/Arial.ttf",
         "C:/Windows/Fonts/calibri.ttf", "C:/Windows/Fonts/Verdana.ttf"]
    )
    for p in cands:
        try:
            f = ImageFont.truetype(p, size)
            _fc[key] = f
            return f
        except Exception:
            pass
    return ImageFont.load_default()

# ── Core helpers ──────────────────────────────────────────────────────────────

def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def sec_alpha(f, s, fi=18, fo=18):
    t   = f - s[0]
    dur = s[1] - s[0]
    if t < fi:        return ease(t / fi)
    if t > dur - fo:  return ease((dur - t) / fo)
    return 1.0

def sub_t(t, a, b):
    """Remap t from [a,b] → [0,1], clamped."""
    if t <= a: return 0.0
    if t >= b: return 1.0
    return (t - a) / (b - a)

def ca(c, a):
    a = max(0.0, min(1.0, a))
    return tuple(int(x * a) for x in c)

def canvas(W, H, c=None):
    return Image.new("RGB", (W, H), c or DARK_NAVY)

def tw(draw, text, f):
    bb = draw.textbbox((0, 0), text, font=f)
    return bb[2] - bb[0], bb[3] - bb[1]

def draw_c(draw, text, y, f, color, W, sh=3):
    w, _ = tw(draw, text, f)
    x = (W - w) // 2
    draw.text((x + sh, y + sh), text, font=f, fill=(0, 0, 0, 100))
    draw.text((x, y), text, font=f, fill=color)

def draw_l(draw, text, x, y, f, color, sh=2):
    draw.text((x + sh, y + sh), text, font=f, fill=(0, 0, 0, 70))
    draw.text((x, y), text, font=f, fill=color)

def blend_img(a, b, t):
    t = max(0.0, min(1.0, t))
    return Image.fromarray(
        (np.array(a) * (1 - t) + np.array(b) * t).astype(np.uint8)
    )

def rrect(draw, x0, y0, x1, y1, r, fill=None, outline=None, width=0):
    try:
        draw.rounded_rectangle([(x0, y0), (x1, y1)],
                                radius=r, fill=fill, outline=outline, width=width)
    except AttributeError:
        draw.rectangle([(x0, y0), (x1, y1)], fill=fill, outline=outline, width=width)

def green_bars(draw, W, H, t=6):
    draw.rectangle([(0, 0), (W, t)], fill=GREEN)
    draw.rectangle([(0, H - t), (W, H)], fill=DARK_GREEN)

def gradient_bg(W, H, top_c, bot_c):
    img = canvas(W, H)
    draw = ImageDraw.Draw(img)
    tr, tg, tb = top_c
    br, bg_c, bb = bot_c
    for y in range(H):
        t = y / H
        r = int(tr + (br - tr) * t)
        g = int(tg + (bg_c - tg) * t)
        b = int(tb + (bb - tb) * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))
    return img

# ── UI building blocks (draw into an existing ImageDraw) ──────────────────────

def ui_nav(draw, W, y0=0, h=52, url="cricketmarketusa.com"):
    draw.rectangle([(0, y0), (W, y0 + h)], fill=WHITE)
    draw.rectangle([(0, y0 + h - 1), (W, y0 + h)], fill=GRAY_200)
    fL = fnt(bold=True, size=18)
    draw.text((18, y0 + (h - 20) // 2), "Cricket", font=fL, fill=GRAY_900)
    bb = draw.textbbox((18, y0 + (h - 20) // 2), "Cricket", font=fL)
    draw.text((bb[2], y0 + (h - 20) // 2), "Market", font=fL, fill=GREEN)
    # URL bar
    uw = 240
    ux = (W - uw) // 2
    rrect(draw, ux, y0 + 9, ux + uw, y0 + h - 9, 4, fill=GRAY_100, outline=GRAY_300, width=1)
    fU = fnt(size=11)
    draw.text((ux + 8, y0 + 17), url, font=fU, fill=GRAY_500)


def ui_field(draw, x, y, w, label, value, focused=False, is_pw=False):
    fL = fnt(size=11)
    fV = fnt(size=13)
    draw.text((x, y), label, font=fL, fill=GRAY_700)
    border_col = GREEN if focused else GRAY_200
    bw = 2 if focused else 1
    rrect(draw, x, y + 16, x + w, y + 44, 6, fill=WHITE, outline=border_col, width=bw)
    if value:
        disp = "\u2022" * min(len(value), 10) if is_pw else value
        # Truncate if too wide
        fV_tmp = fV
        while len(disp) > 2:
            bb = draw.textbbox((0,0), disp, font=fV_tmp)
            if bb[2] - bb[0] < w - 20:
                break
            disp = disp[:-3] + "\u2026"
        draw.text((x + 10, y + 25), disp, font=fV, fill=GRAY_900)


def ui_btn(draw, x, y, w, h=40, text="", bg=GREEN, fg=WHITE, r=8):
    rrect(draw, x, y, x + w, y + h, r, fill=bg)
    f = fnt(bold=True, size=13)
    tw_, th_ = tw(draw, text, f)
    draw.text((x + (w - tw_) // 2, y + (h - th_) // 2), text, font=f, fill=fg)


def ui_toggle(draw, x, y, w, h=44, seller=True):
    """Buyer/seller role toggle."""
    rrect(draw, x, y, x + w, y + h, 10, fill=WHITE, outline=GRAY_200, width=1)
    half = (w - 12) // 2
    f = fnt(bold=True, size=12)
    # Buyer (left)
    bx, by = x + 4, y + 4
    bh = h - 8
    if seller:
        tw_, th_ = tw(draw, "I'm buying", f)
        draw.text((bx + (half - tw_) // 2, by + (bh - th_) // 2),
                  "I'm buying", font=f, fill=GRAY_500)
    else:
        rrect(draw, bx, by, bx + half, by + bh, 7, fill=GREEN)
        tw_, th_ = tw(draw, "I'm buying", f)
        draw.text((bx + (half - tw_) // 2, by + (bh - th_) // 2),
                  "I'm buying", font=f, fill=WHITE)
    # Seller (right)
    sx = x + 8 + half
    if seller:
        rrect(draw, sx, by, sx + half, by + bh, 7, fill=GREEN)
        tw_, th_ = tw(draw, "I'm selling", f)
        draw.text((sx + (half - tw_) // 2, by + (bh - th_) // 2),
                  "I'm selling", font=f, fill=WHITE)
    else:
        tw_, th_ = tw(draw, "I'm selling", f)
        draw.text((sx + (half - tw_) // 2, by + (bh - th_) // 2),
                  "I'm selling", font=f, fill=GRAY_500)


def ui_banner(draw, x, y, w, text_main, text_sub, btn_text, color="amber"):
    """Amber or green info/action banner."""
    bg   = AMBER_50   if color == "amber" else (240, 253, 244)
    bdr  = AMBER_200  if color == "amber" else (134, 239, 172)
    t1c  = AMBER_900  if color == "amber" else (20, 83, 45)
    t2c  = AMBER_700  if color == "amber" else (22, 101, 52)
    btnb = AMBER_700  if color == "amber" else GREEN
    h    = 70
    rrect(draw, x, y, x + w, y + h, 10, fill=bg, outline=bdr, width=1)
    fM = fnt(bold=True, size=13)
    fS = fnt(size=11)
    draw.text((x + 14, y + 12), text_main, font=fM, fill=t1c)
    draw.text((x + 14, y + 30), text_sub,  font=fS, fill=t2c)
    if btn_text:
        bw = max(100, len(btn_text) * 9)
        rrect(draw, x + w - bw - 12, y + 17, x + w - 12, y + 53, 6, fill=btnb)
        f = fnt(bold=True, size=11)
        tw_, th_ = tw(draw, btn_text, f)
        bx = x + w - bw - 12
        draw.text((bx + (bw - tw_) // 2, y + 17 + (36 - th_) // 2),
                  btn_text, font=f, fill=WHITE)


def ui_step_chip(draw, x, y, num, label, done=False):
    """Small step indicator chip."""
    bg = GREEN if done else GRAY_200
    fg = WHITE if done else GRAY_500
    rrect(draw, x, y, x + 22, y + 22, 11, fill=bg)
    f = fnt(bold=True, size=11)
    draw.text((x + 6, y + 5), str(num), font=f, fill=fg)
    f2 = fnt(size=11)
    draw.text((x + 28, y + 5), label, font=f2, fill=GRAY_500)


def ui_category_pill(draw, x, y, label, active=False):
    w = max(80, len(label) * 8 + 20)
    bg = GREEN if active else WHITE
    fg = WHITE if active else GRAY_700
    ol = GREEN if active else GRAY_200
    rrect(draw, x, y, x + w, y + 30, 15, fill=bg, outline=ol, width=1)
    f = fnt(size=12)
    tw_, th_ = tw(draw, label, f)
    draw.text((x + (w - tw_) // 2, y + (30 - th_) // 2), label, font=f, fill=fg)
    return w


def ui_condition_badge(draw, x, y, label, desc, active=False):
    bdr = (134, 239, 172) if active else GRAY_200
    bg  = (240, 253, 244) if active else WHITE
    w   = 160
    rrect(draw, x, y, x + w, y + 54, 8, fill=bg, outline=bdr, width=2 if active else 1)
    fL = fnt(bold=True, size=12)
    fD = fnt(size=10)
    draw.text((x + 10, y + 10), label, font=fL, fill=GRAY_900 if active else GRAY_700)
    draw.text((x + 10, y + 30), desc,  font=fD, fill=GRAY_500)


def ui_photo_thumb(draw, img, x, y, size=80, color=(230, 238, 230)):
    """Draw a placeholder photo thumbnail."""
    rrect(draw, x, y, x + size, y + size, 6, fill=color, outline=GRAY_200, width=1)
    # Camera icon placeholder
    cx, cy = x + size // 2, y + size // 2
    draw.ellipse([(cx - 14, cy - 10), (cx + 14, cy + 10)], outline=GRAY_300, width=2)
    draw.ellipse([(cx - 5, cy - 4), (cx + 5, cy + 4)], fill=GRAY_300)


def type_str(full, t, start=0.0, end=1.0):
    """Return prefix of `full` based on typing progress."""
    p = ease(sub_t(t, start, end))
    n = int(len(full) * p)
    return full[:n]

# ── UI screen composers (return Image) ────────────────────────────────────────

def make_register_ui(W, H, t):
    """Register page mockup."""
    img = Image.new("RGB", (W, H), LIGHT_GRAY)
    draw = ImageDraw.Draw(img, "RGBA")
    ui_nav(draw, W, url="cricketmarketusa.com/register")

    # Centre column (max 400px)
    col_w = min(400, W - 40)
    col_x = (W - col_w) // 2
    y = 70

    # Wordmark + heading
    fH = fnt(bold=True, size=20)
    fS = fnt(size=12)
    draw.text((col_x + (col_w - tw(draw, "CricketMarket", fH)[0]) // 2, y),
              "CricketMarket", font=fH, fill=GRAY_900)
    y += 28
    heading = "Create your account"
    tw_, _ = tw(draw, heading, fnt(bold=True, size=14))
    draw.text((col_x + (col_w - tw_) // 2, y), heading, font=fnt(bold=True, size=14), fill=GRAY_900)
    y += 22

    # Role toggle
    seller_sel = ease(sub_t(t, 0.05, 0.20)) > 0.5
    ui_toggle(draw, col_x, y, col_w, h=42, seller=seller_sel)
    y += 54

    # Card background
    rrect(draw, col_x - 4, y - 8, col_x + col_w + 4, y + 178, 12, fill=WHITE,
          outline=GRAY_200, width=1)

    # Fields animate in
    name_val  = type_str("Alex Chen",         t, 0.22, 0.45)
    email_val = type_str("alex@example.com",  t, 0.46, 0.66)
    pw_val    = type_str("securepass1",        t, 0.67, 0.82)

    ui_field(draw, col_x + 8, y,      col_w - 16, "Full name",      name_val,
             focused=(0.22 <= t < 0.46))
    ui_field(draw, col_x + 8, y + 52, col_w - 16, "Email address",  email_val,
             focused=(0.46 <= t < 0.67))
    ui_field(draw, col_x + 8, y + 104, col_w - 16, "Password",      pw_val,
             focused=(0.67 <= t < 0.83), is_pw=True)
    y += 156

    # Turnstile placeholder
    rrect(draw, col_x + 8, y, col_x + col_w - 8, y + 22, 4,
          fill=GRAY_100, outline=GRAY_200, width=1)
    fT = fnt(size=10)
    draw.text((col_x + 16, y + 5), "Human verification \u2022 Cloudflare Turnstile", font=fT, fill=GRAY_500)
    y += 30

    # Submit button — brightens after pw typed
    btn_alpha = ease(sub_t(t, 0.83, 0.95))
    btn_col = ca(GREEN, 0.4 + 0.6 * btn_alpha)
    ui_btn(draw, col_x + 8, y, col_w - 16, h=38,
           text="Create seller account", bg=btn_col)

    return img


def make_email_ui(W, H):
    """Email verification confirmation screen."""
    img = Image.new("RGB", (W, H), LIGHT_GRAY)
    draw = ImageDraw.Draw(img, "RGBA")
    ui_nav(draw, W, url="cricketmarketusa.com/register")

    card_w = min(380, W - 40)
    cx = (W - card_w) // 2
    cy = (H - 200) // 2

    rrect(draw, cx, cy, cx + card_w, cy + 200, 16, fill=WHITE, outline=GRAY_200, width=1)

    # Envelope icon (circle + simplified envelope)
    ic_cx = cx + card_w // 2
    draw.ellipse([(ic_cx - 28, cy + 16), (ic_cx + 28, cy + 72)], fill=(240, 253, 244))
    # Simplified envelope shape
    env_x, env_y = ic_cx - 18, cy + 30
    draw.rectangle([(env_x, env_y), (env_x + 36, env_y + 22)], outline=GREEN, width=2)
    draw.line([(env_x, env_y), (ic_cx, env_y + 12), (env_x + 36, env_y)], fill=GREEN, width=2)

    fH = fnt(bold=True, size=16)
    fS = fnt(size=12)
    fXS = fnt(size=10)
    draw_c(draw, "Check your email", cy + 80, fH, GRAY_900, card_w, sh=0)
    draw_c(draw, "We sent a verification link to", cy + 104, fS, GRAY_500, card_w, sh=0)
    draw_c(draw, "alex@example.com", cy + 120, fnt(bold=True, size=12), GRAY_900, card_w, sh=0)
    draw_c(draw, "Click the link to activate your account. Expires in 24 hours.",
           cy + 142, fXS, GRAY_500, card_w, sh=0)

    # Button
    bw = 140
    bx = cx + (card_w - bw) // 2
    ui_btn(draw, bx, cy + 163, bw, h=30, text="Go to sign in", r=6)

    return img


def make_login_ui(W, H, t):
    """Login page mockup."""
    img = Image.new("RGB", (W, H), LIGHT_GRAY)
    draw = ImageDraw.Draw(img, "RGBA")
    ui_nav(draw, W, url="cricketmarketusa.com/login")

    col_w = min(380, W - 40)
    col_x = (W - col_w) // 2
    y = 80

    fH = fnt(bold=True, size=16)
    tw_,_ = tw(draw, "Sign in to your account", fH)
    draw.text((col_x + (col_w - tw_) // 2, y), "Sign in to your account", font=fH, fill=GRAY_900)
    y += 28

    rrect(draw, col_x - 4, y - 8, col_x + col_w + 4, y + 120, 12, fill=WHITE,
          outline=GRAY_200, width=1)

    email_val = type_str("alex@example.com", t, 0.1, 0.5)
    pw_val    = type_str("securepass1",       t, 0.5, 0.85)

    ui_field(draw, col_x + 8, y,       col_w - 16, "Email address", email_val,
             focused=(0.1 <= t < 0.5))
    ui_field(draw, col_x + 8, y + 52,  col_w - 16, "Password",      pw_val,
             focused=(0.5 <= t < 0.86), is_pw=True)
    y += 112

    btn_a = ease(sub_t(t, 0.86, 0.98))
    ui_btn(draw, col_x + 8, y, col_w - 16, h=38,
           text="Sign in", bg=ca(GREEN, 0.4 + 0.6 * btn_a))

    return img


def make_dashboard_ui(W, H, t):
    """Seller dashboard with Stripe + address banners (t drives which is prominent)."""
    img = Image.new("RGB", (W, H), LIGHT_GRAY)
    draw = ImageDraw.Draw(img, "RGBA")
    ui_nav(draw, W, url="cricketmarketusa.com/dashboard/seller")

    col_w = min(600, W - 40)
    col_x = (W - col_w) // 2
    y = 62

    fH = fnt(bold=True, size=18)
    draw.text((col_x, y), "Seller Dashboard", font=fH, fill=GRAY_900)
    # "New Listing" button top-right
    ui_btn(draw, col_x + col_w - 108, y - 4, 108, h=34, text="+ New Listing")
    y += 34

    # Stripe banner
    stripe_done  = t > 0.55
    stripe_color = "green" if stripe_done else "amber"
    stripe_main  = "Stripe Connected \u2713" if stripe_done else "Connect Stripe to receive payouts"
    stripe_sub   = "You will receive payouts when orders are released." if stripe_done \
                   else "Complete onboarding to receive funds when buyers confirm receipt."
    stripe_btn   = "" if stripe_done else "Connect Stripe"
    ui_banner(draw, col_x, y, col_w, stripe_main, stripe_sub, stripe_btn, color=stripe_color)
    y += 80

    # Ship-from address banner
    addr_done  = t > 0.75
    addr_color = "green" if addr_done else "amber"
    addr_main  = "Ship-from Address Set \u2713" if addr_done else "Add a Ship-from Address"
    addr_sub   = "123 Cricket Lane, Houston, TX 77001" if addr_done \
                 else "Required before you can publish listings."
    addr_btn   = "" if addr_done else "Add Address"
    ui_banner(draw, col_x, y, col_w, addr_main, addr_sub, addr_btn, color=addr_color)
    y += 80

    # Stats row (static placeholders)
    sw = (col_w - 18) // 4
    for i, (lbl, val) in enumerate([("Active Listings","0"),("Published","0"),
                                     ("Active Orders","0"),("Total Earned","$0.00")]):
        sx = col_x + i * (sw + 6)
        rrect(draw, sx, y, sx + sw, y + 60, 10, fill=WHITE, outline=GRAY_200, width=1)
        f1 = fnt(size=9)
        f2 = fnt(bold=True, size=18)
        draw.text((sx + 10, y + 8),  lbl, font=f1, fill=GRAY_500)
        draw.text((sx + 10, y + 26), val, font=f2, fill=GRAY_900)
    y += 74

    # Prompt to create first listing
    fP = fnt(size=12)
    draw.text((col_x, y + 6), "No listings yet.  Create your first listing \u2192",
              font=fP, fill=GRAY_500)

    return img


def make_listing_ui(W, H, t):
    """New listing form mockup."""
    img = Image.new("RGB", (W, H), LIGHT_GRAY)
    draw = ImageDraw.Draw(img, "RGBA")
    ui_nav(draw, W, url="cricketmarketusa.com/listings/new")

    col_w = min(560, W - 40)
    col_x = (W - col_w) // 2
    y = 62

    fH = fnt(bold=True, size=18)
    draw.text((col_x, y), "New Listing", font=fH, fill=GRAY_900)
    y += 30

    # Category pills
    fS = fnt(size=11)
    draw.text((col_x, y), "Category", font=fS, fill=GRAY_700)
    y += 16
    cats = ["Cricket Bat", "Helmet", "Batting Pads", "Gloves", "Kit Bag", "Accessories"]
    active_idx = 0  # always show Cricket Bat selected
    px = col_x
    for i, c in enumerate(cats):
        w_pill = ui_category_pill(draw, px, y,
                                  label=c, active=(i == active_idx and t > 0.10))
        px += w_pill + 6
        if px > col_x + col_w - 80:
            px = col_x
            y += 36
    y += 40

    # Condition badges
    draw.text((col_x, y), "Condition", font=fS, fill=GRAY_700)
    y += 16
    conds = [("New","Unused, original pkg"), ("Used \u2013 Good","Light use, minor wear"),
             ("Used \u2013 Fair","Visible wear, functional")]
    for i, (lbl, desc) in enumerate(conds):
        cx = col_x + i * 170
        active = (i == 1 and t > 0.25)  # "Used – Good" selected
        ui_condition_badge(draw, cx, y, lbl, desc, active=active)
    y += 66

    # Title + price
    title_val = type_str("Kookaburra Pro 750 Cricket Bat", t, 0.35, 0.65)
    price_val = type_str("85.00", t, 0.66, 0.80)
    ui_field(draw, col_x, y, col_w - 10, "Title", title_val,
             focused=(0.35 <= t < 0.66))
    ui_field(draw, col_x, y + 52, 100, "Price ($)", price_val,
             focused=(0.66 <= t < 0.81))
    y += 104

    # Photos section
    draw.text((col_x, y), "Photos", font=fS, fill=GRAY_700)
    y += 16
    # Show thumbnails appearing
    n_photos = int(ease(sub_t(t, 0.81, 1.0)) * 3)
    thumb_colors = [(200, 230, 210), (210, 225, 235), (225, 215, 200)]
    for i in range(3):
        tx = col_x + i * 90
        if i < n_photos:
            ui_photo_thumb(draw, img, tx, y, size=76, color=thumb_colors[i])
        else:
            # Upload placeholder
            rrect(draw, tx, y, tx + 76, y + 76, 6, fill=WHITE, outline=GRAY_200, width=1)
            fT = fnt(size=9)
            draw.text((tx + 22, y + 30), "Upload", font=fT, fill=GRAY_300)
    # Add photo button
    rrect(draw, col_x + 3 * 90, y + 18, col_x + 3 * 90 + 60, y + 58, 6,
          fill=GRAY_100, outline=GRAY_200, width=1)
    draw.text((col_x + 3 * 90 + 18, y + 32), "+", font=fnt(bold=True, size=18), fill=GRAY_300)

    # Demonstration data notice
    notice = "\u2014  DEMONSTRATION DATA  \u2014  not a real listing  \u2014"
    fN = fnt(size=10)
    nw, nh = tw(draw, notice, fN)
    nx = (W - nw) // 2
    ny = H - nh - 12
    rrect(draw, nx - 10, ny - 5, nx + nw + 10, ny + nh + 5, 4, fill=(254, 243, 199))
    draw.text((nx, ny), notice, font=fN, fill=AMBER_700)

    return img


def make_publish_ui(W, H, t):
    """Dashboard drafts section with publish flow."""
    img = Image.new("RGB", (W, H), LIGHT_GRAY)
    draw = ImageDraw.Draw(img, "RGBA")
    ui_nav(draw, W, url="cricketmarketusa.com/dashboard/seller")

    col_w = min(560, W - 40)
    col_x = (W - col_w) // 2
    y = 62

    fH = fnt(bold=True, size=15)
    draw.text((col_x, y), "Seller Dashboard", font=fH, fill=GRAY_900)
    y += 28

    published = t > 0.60

    if not published:
        # Drafts section
        fS2 = fnt(bold=True, size=13)
        draw.text((col_x, y), f"Drafts (1)", font=fS2, fill=GRAY_900)

        # Publish button (highlighted after t=0.3)
        btn_highlight = ease(sub_t(t, 0.3, 0.55))
        btn_col = tuple(int(GREEN[i] * btn_highlight + GRAY_300[i] * (1 - btn_highlight))
                        for i in range(3))
        ui_btn(draw, col_x + col_w - 145, y - 4, 145, h=34,
               text="Publish Selected (1)", bg=btn_col)
        y += 42

        # Draft row
        checked = t > 0.20
        rrect(draw, col_x, y, col_x + col_w, y + 64, 10,
              fill=WHITE, outline=(253, 230, 138), width=1)
        # Checkbox
        rrect(draw, col_x + 14, y + 22, col_x + 30, y + 38, 3,
              fill=GREEN if checked else WHITE, outline=GRAY_300 if not checked else GREEN, width=2)
        if checked:
            draw.text((col_x + 17, y + 20), "\u2713", font=fnt(bold=True, size=13), fill=WHITE)
        # Photo placeholder
        rrect(draw, col_x + 40, y + 8, col_x + 94, y + 56, 6, fill=(230, 245, 235))
        # Title
        fT = fnt(bold=True, size=13)
        draw.text((col_x + 104, y + 14), "Kookaburra Pro 750 Cricket Bat", font=fT, fill=GRAY_900)
        fX = fnt(size=11)
        # Draft badge
        rrect(draw, col_x + 104, y + 34, col_x + 148, y + 50, 10, fill=(254, 243, 199))
        draw.text((col_x + 110, y + 37), "Draft", font=fX, fill=AMBER_700)
        draw.text((col_x + 158, y + 37), "$85.00", font=fX, fill=GRAY_500)
        y += 74

        # Edit link
        draw.text((col_x + col_w - 60, y - 10), "Edit", font=fX, fill=GREEN)

    else:
        # Published! Show active listing
        fBig = fnt(bold=True, size=15)
        draw.text((col_x, y), "My Listings", font=fBig, fill=GRAY_900)
        y += 30

        live_a = ease(sub_t(t, 0.60, 0.85))
        # Listing row with green Active badge
        rrect(draw, col_x, y, col_x + col_w, y + 64, 10,
              fill=WHITE, outline=ca((134, 239, 172), live_a), width=2)
        rrect(draw, col_x + 14, y + 8, col_x + 68, y + 56, 6, fill=(230, 245, 235))
        fT = fnt(bold=True, size=13)
        fX = fnt(size=11)
        draw.text((col_x + 80, y + 14), "Kookaburra Pro 750 Cricket Bat", font=fT,
                  fill=ca(GRAY_900, live_a))
        draw.text((col_x + col_w - 100, y + 14), "$85.00",
                  font=fnt(bold=True, size=14), fill=ca(GRAY_900, live_a))
        # Active badge
        badge_x = col_x + col_w - 160
        rrect(draw, badge_x, y + 34, badge_x + 56, y + 52, 10,
              fill=ca((220, 252, 231), live_a))
        draw.text((badge_x + 8, y + 38), "Active", font=fX, fill=ca(GREEN, live_a))

    # Demonstration data notice
    notice = "\u2014  DEMONSTRATION DATA  \u2014  not a real listing  \u2014"
    fN = fnt(size=10)
    nw, nh = tw(draw, notice, fN)
    nx = (W - nw) // 2
    ny = H - nh - 12
    rrect(draw, nx - 10, ny - 5, nx + nw + 10, ny + nh + 5, 4, fill=(254, 243, 199))
    draw.text((nx, ny), notice, font=fN, fill=AMBER_700)

    return img

# ── Section render functions ───────────────────────────────────────────────────

LEFT_W = 660  # width of explanatory text panel in wide mode

def left_panel(W, H, step_n, step_total, headline, sublines, a):
    """Render the left dark-navy text panel for wide format."""
    panel = canvas(LEFT_W, H, DEEP_NAVY)
    draw  = ImageDraw.Draw(panel, "RGBA")

    # Vertical green accent bar
    draw.rectangle([(0, 0), (5, H)], fill=GREEN)

    y = H // 2 - 120

    # Step chip
    chip = f"STEP {step_n} OF {step_total}"
    fC = fnt(bold=True, size=11)
    cw = tw(draw, chip, fC)[0] + 20
    rrect(draw, 32, y, 32 + cw, y + 22, 11, fill=ca(GREEN, a * 0.25), outline=ca(GREEN, a * 0.5), width=1)
    draw.text((42, y + 5), chip, font=fC, fill=ca(SOFT_GREEN, a))
    y += 34

    # Headline
    fH = fnt(bold=True, size=40)
    # Word-wrap at ~22 chars
    words = headline.split()
    lines_h = []
    cur = ""
    for w_word in words:
        test = cur + (" " if cur else "") + w_word
        if tw(draw, test, fH)[0] > LEFT_W - 64:
            lines_h.append(cur)
            cur = w_word
        else:
            cur = test
    if cur:
        lines_h.append(cur)

    for i, ln in enumerate(lines_h):
        col = ca(GREEN, a) if i > 0 else ca(WHITE, a)
        draw.text((32, y), ln, font=fH, fill=col)
        y += tw(draw, ln, fH)[1] + 6

    y += 14

    # Sublines (bullet points)
    fS = fnt(size=16)
    for sub in sublines:
        draw.text((44, y), "\u2022  " + sub, font=fS, fill=ca(GRAY_300, a))
        y += 26

    # CricketMarket wordmark bottom
    fL = fnt(bold=True, size=18)
    draw.text((32, H - 48), "Cricket", font=fL, fill=ca(WHITE, a * 0.6))
    bb = draw.textbbox((32, H - 48), "Cricket", font=fL)
    draw.text((bb[2], H - 48), "Market", font=fL, fill=ca(GREEN, a * 0.6))
    draw.text((32, H - 28), "cricketmarketusa.com", font=fnt(size=11), fill=ca(GRAY_500, a * 0.7))

    return panel


def make_wide_frame(left_panel_img, right_ui_img, W, H, a):
    """Combine left panel + right UI panel into a 1920×1080 frame."""
    base = canvas(W, H, LIGHT_GRAY)
    base.paste(left_panel_img, (0, 0))
    base.paste(right_ui_img, (LEFT_W, 0))
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)
    # Vertical separator
    draw.rectangle([(LEFT_W, 0), (LEFT_W + 3, H)], fill=ca(GREEN, 0.3 * a))
    return base


def make_vert_focused(ui_img, label, caption, W, H, a, crop_box=None):
    """
    Vertical format: focused UI crop placed inside the Instagram Reels safe zone.

    Safe-zone constants match make_corrected_reel.py (most restrictive placement):
      Top unsafe   14%  → top    safe boundary y = 268 px
      Bottom unsafe 35% → bottom safe boundary y = 1248 px
      Left unsafe   5%  → left   safe boundary x = 54 px
      Right unsafe  15% → right  safe boundary x = 918 px  (action icon column)
      Safe content rect: x=54..918, y=268..1248  (864×980 px)

    Label sits at y=280 (12 px below top-safe boundary, matching corrected reel wordmark).
    Caption sits at y=1214 (34 px above bottom-safe boundary at 1248).
    UI content is centred inside x=54..918, y=338..1194.
    """
    TOP_SAFE   = int(H * 0.14)        # 268 — first safe pixel from top
    BOT_MARGIN = int(H * 0.35)        # 672 — bottom unsafe height
    BOT_SAFE   = H - BOT_MARGIN       # 1248 — last safe pixel from bottom
    LEFT_SAFE  = int(W * 0.05)        # 54
    RIGHT_UNS  = int(W * 0.15)        # 162 — right action-icon column
    SAFE_X0    = LEFT_SAFE            # 54
    SAFE_X1    = W - RIGHT_UNS        # 918
    SAFE_W     = SAFE_X1 - SAFE_X0   # 864

    base = canvas(W, H, DARK_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H, t=8)

    # Step label — y=TOP_SAFE+12=280 (matches corrected reel wordmark y=280)
    fL = fnt(bold=True, size=22)
    draw_c(draw, label, TOP_SAFE + 12, fL, ca(WHITE, a), W)

    # Content zone: y=TOP_SAFE+70..BOT_SAFE-54  (338..1194)
    content_y0 = TOP_SAFE + 70
    content_y1 = BOT_SAFE - 54
    content_h  = content_y1 - content_y0

    if crop_box is not None:
        cx0, cy0, cx1, cy1 = crop_box
        crop_w = cx1 - cx0
        crop_h = cy1 - cy0
        cropped = ui_img.crop((cx0, cy0, cx1, cy1))
        scale  = min(SAFE_W / crop_w, content_h / crop_h)
        new_w  = int(crop_w * scale)
        new_h  = int(crop_h * scale)
        zoomed = cropped.resize((new_w, new_h), Image.LANCZOS)
        px = SAFE_X0 + (SAFE_W - new_w) // 2
        py = content_y0 + (content_h - new_h) // 2
    else:
        ui_w, ui_h = ui_img.size
        scale  = min(SAFE_W / ui_w, content_h / ui_h)
        new_w  = int(ui_w * scale)
        new_h  = int(ui_h * scale)
        zoomed = ui_img.resize((new_w, new_h), Image.LANCZOS)
        px = SAFE_X0 + (SAFE_W - new_w) // 2
        py = content_y0 + (content_h - new_h) // 2

    # White backing with 8 px padding for subtle border
    backing = Image.new("RGB", (new_w + 16, new_h + 16), DARK_NAVY)
    backing.paste(zoomed, (8, 8))
    base.paste(backing, (px - 8, py - 8))

    # Caption — y=BOT_SAFE-34=1214 (inside safe zone, clears bottom unsafe at y=1248)
    fC = fnt(size=18)
    draw_c(draw, caption, BOT_SAFE - 34, fC, ca(SOFT_GREEN, a), W)

    return base


# ── Section functions ─────────────────────────────────────────────────────────

def s1_hero(f, W, H):
    a  = sec_alpha(f, S1, fi=15, fo=25)
    t  = (f - S1[0]) / (S1[1] - S1[0])

    base = gradient_bg(W, H, DEEP_NAVY, MID_NAVY)
    draw = ImageDraw.Draw(base, "RGBA")
    green_bars(draw, W, H)

    cw = ca(WHITE, a)
    cg = ca(GREEN, a)
    cs = ca(SOFT_GREEN, a * 0.85)

    if W > H:
        fH  = fnt(bold=True, size=86)
        fSb = fnt(bold=False, size=32)
        fSm = fnt(bold=False, size=20)
        yc  = H // 2 - 80
        sp  = 96
    else:
        fH  = fnt(bold=True, size=72)
        fSb = fnt(bold=False, size=28)
        fSm = fnt(bold=False, size=18)
        yc  = H // 2 - 60
        sp  = 82

    draw_c(draw, "Sell your cricket gear", yc,       fH, cw, W)
    draw_c(draw, "in 3 easy steps.",       yc + sp,  fH, cg, W)
    draw_c(draw, "USA Cricket Equipment Marketplace",
           yc + sp * 2 + 20, fSb, cs, W)

    # Step chips
    steps = ["1  Register", "2  Setup", "3  List & Publish"]
    step_a = ease(sub_t(t, 0.40, 0.90))
    chip_y = yc + sp * 2 + 70
    chip_w = 160 if W > H else 140
    total_chips_w = len(steps) * chip_w + (len(steps) - 1) * 16
    chip_x = (W - total_chips_w) // 2
    for i, s in enumerate(steps):
        delay = ease(sub_t(t, 0.40 + i * 0.12, 0.90 + i * 0.05))
        rrect(draw, chip_x, chip_y, chip_x + chip_w, chip_y + 34, 17,
              fill=ca(GREEN, 0.25 * delay * a), outline=ca(GREEN, 0.55 * delay * a), width=1)
        f_chip = fnt(bold=False, size=14 if W > H else 12)
        tw_, th_ = tw(draw, s, f_chip)
        draw.text((chip_x + (chip_w - tw_) // 2, chip_y + (34 - th_) // 2),
                  s, font=f_chip, fill=ca(SOFT_GREEN, delay * a))
        chip_x += chip_w + 16

    # Wordmark — wide: y=24; vertical: y=280 (just inside Reels top-safe y=268)
    fL  = fnt(bold=True, size=40 if W > H else 34)
    wm_y = 24 if W > H else 280
    draw_l(draw, "Cricket", 34, wm_y, fL, ca(WHITE, min(1.0, a * 2)), sh=2)
    bb = draw.textbbox((34, wm_y), "Cricket", font=fL)
    draw_l(draw, "Market", bb[2], wm_y, fL, ca(GREEN, min(1.0, a * 2)), sh=2)

    return base


def s2_register(f, W, H):
    a = sec_alpha(f, S2, fi=18, fo=18)
    t = (f - S2[0]) / (S2[1] - S2[0])

    if W > H:
        lp = left_panel(LEFT_W, H, 1, 3, "Create your seller account",
                        ["Go to cricketmarketusa.com",
                         "Choose \u201cI\u2019m selling\u201d",
                         "Enter name, email & password"], a)
        ui_w = W - LEFT_W
        ui = make_register_ui(ui_w, H, t)
        base = make_wide_frame(lp, ui, W, H, a)
    else:
        # Vertical: focused on the form card
        ui = make_register_ui(900, 780, t)
        crop = (180, 56, 840, 740)
        base = make_vert_focused(ui, "Step 1: Register",
                                 "Create your seller account", W, H, a, crop_box=crop)

    return base


def s3_email(f, W, H):
    a = sec_alpha(f, S3, fi=18, fo=18)
    t = (f - S3[0]) / (S3[1] - S3[0])

    if W > H:
        lp = left_panel(LEFT_W, H, 1, 3, "Verify your email",
                        ["Check inbox for verification link",
                         "Link expires in 24 hours",
                         "Then sign back in"], a)
        half = S3[1] - S3[0]
        if t < 0.55:
            ui = make_email_ui(W - LEFT_W, H)
        else:
            ui = make_login_ui(W - LEFT_W, H, sub_t(t, 0.55, 1.0))
        base = make_wide_frame(lp, ui, W, H, a)
    else:
        if t < 0.55:
            ui = make_email_ui(900, 500)
            crop = (160, 0, 780, 500)
            base = make_vert_focused(ui, "Verify your email",
                                     "Check inbox, click the link", W, H, a, crop_box=crop)
        else:
            ui = make_login_ui(900, 500, sub_t(t, 0.55, 1.0))
            crop = (180, 56, 780, 440)
            base = make_vert_focused(ui, "Sign in",
                                     "Email verified \u2713  Now sign in", W, H, a, crop_box=crop)

    return base


def s4_dashboard(f, W, H):
    a = sec_alpha(f, S4, fi=18, fo=18)
    t = (f - S4[0]) / (S4[1] - S4[0])

    if W > H:
        lp = left_panel(LEFT_W, H, 2, 3, "Set up your seller account",
                        ["Connect Stripe for payouts",
                         "Add your ship-from address",
                         "Both needed before publishing"], a)
        ui = make_dashboard_ui(W - LEFT_W, H, t)
        base = make_wide_frame(lp, ui, W, H, a)
    else:
        ui_w, ui_h = 900, 600
        ui = make_dashboard_ui(ui_w, ui_h, t)
        # Crop to banner area
        crop = (50, 56, 870, 300)
        lbl = "Connect Stripe" if t < 0.55 else "Add Ship-from Address"
        cap = "Required to receive payouts" if t < 0.55 else "Required before publishing listings"
        base = make_vert_focused(ui, "Step 2: Account Setup", cap, W, H, a, crop_box=crop)

    return base


def s5_listing(f, W, H):
    a = sec_alpha(f, S5, fi=18, fo=18)
    t = (f - S5[0]) / (S5[1] - S5[0])

    if W > H:
        lp = left_panel(LEFT_W, H, 3, 3, "Create your listing",
                        ["Choose category & condition",
                         "Set a price in dollars",
                         "Upload 1\u20138 photos"], a)
        ui = make_listing_ui(W - LEFT_W, H, t)
        base = make_wide_frame(lp, ui, W, H, a)
    else:
        ui_w, ui_h = 900, 800
        ui = make_listing_ui(ui_w, ui_h, t)
        # Show progressively lower area as t increases
        if t < 0.45:
            crop = (80, 56, 860, 340)   # top: category + condition
        elif t < 0.80:
            crop = (80, 260, 860, 540)  # middle: title + price
        else:
            crop = (80, 480, 860, 760)  # bottom: photos
        lbl = "Step 3: Create Listing"
        caps = ["Choose category & condition",
                "Add title, price & description",
                "Upload photos"]
        cap_i = 0 if t < 0.45 else (1 if t < 0.80 else 2)
        base = make_vert_focused(ui, lbl, caps[cap_i], W, H, a, crop_box=crop)

    return base


def s6_publish(f, W, H):
    a = sec_alpha(f, S6, fi=18, fo=18)
    t = (f - S6[0]) / (S6[1] - S6[0])

    if W > H:
        headline = "Review & publish" if t < 0.65 else "You\u2019re live!"
        lp = left_panel(LEFT_W, H, 3, 3, headline,
                        ["Select your draft",
                         "Click \u201cPublish Selected\u201d",
                         "Listing goes live instantly"] if t < 0.65
                        else ["Your listing is now active",
                              "Buyers can find and purchase it",
                              "You\u2019ll receive payouts via Stripe"], a)
        ui = make_publish_ui(W - LEFT_W, H, t)
        base = make_wide_frame(lp, ui, W, H, a)
    else:
        ui_w, ui_h = 900, 500
        ui = make_publish_ui(ui_w, ui_h, t)
        if t < 0.65:
            crop = (60, 56, 840, 360)
        else:
            crop = (60, 56, 840, 320)
        cap = "Publish Selected \u2192" if t < 0.65 else "Your listing is live! \u2713"
        base = make_vert_focused(ui, "Publish Your Listing", cap, W, H, a, crop_box=crop)

    return base


# ── Renderer ──────────────────────────────────────────────────────────────────

def render(label, W, H):
    out = os.path.join(OUTDIR, f"seller_tutorial_{label}.mp4")
    print(f"\n  >> {label}  ({W}x{H})")
    print(f"     -> {out}")
    sys.stdout.flush()

    writer = imageio.get_writer(
        out, fps=FPS, codec="libx264",
        quality=8, pixelformat="yuv420p",
        macro_block_size=1,
        output_params=["-preset", "fast", "-crf", "18"],
    )

    for f in range(TOTAL):
        if   f < S1[1]: img = s1_hero(f, W, H)
        elif f < S2[1]: img = s2_register(f, W, H)
        elif f < S3[1]: img = s3_email(f, W, H)
        elif f < S4[1]: img = s4_dashboard(f, W, H)
        elif f < S5[1]: img = s5_listing(f, W, H)
        else:           img = s6_publish(f, W, H)

        writer.append_data(np.array(img.convert("RGB")))

        if f % 90 == 0:
            print(f"     frame {f:>4}/{TOTAL}  ({f // FPS}s / {TOTAL // FPS}s)")
            sys.stdout.flush()

    writer.close()
    kb = os.path.getsize(out) // 1024
    print(f"  OK  {label}: {kb:,} KB  ({kb/1024:.1f} MB)")
    sys.stdout.flush()
    return out


def save_previews(label, W, H):
    """Save one spot-check PNG per section midpoint."""
    mid_frames = {
        "s1_hero":      (S1[0] + S1[1]) // 2,
        "s2_register":  (S2[0] + S2[1]) // 2,
        "s3_email":     (S3[0] + S3[1]) // 2,
        "s4_dashboard": (S4[0] + S4[1]) // 2,
        "s5_listing":   (S5[0] + S5[1]) // 2,
        "s6_publish":   (S6[0] + S6[1]) // 2,
    }
    funcs = {
        "s1_hero": s1_hero, "s2_register": s2_register, "s3_email": s3_email,
        "s4_dashboard": s4_dashboard, "s5_listing": s5_listing, "s6_publish": s6_publish,
    }
    saved = []
    for name, f in mid_frames.items():
        img = funcs[name](f, W, H)
        path = os.path.join(OUTDIR, f"tutorial_{label}_{name}.png")
        img.save(path)
        saved.append(path)
        print(f"  preview: {os.path.basename(path)}")
    return saved


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    print("=" * 58)
    print("  Cricket Market USA -- Seller Tutorial Video Generator")
    print("=" * 58)

    print("\nGenerating wide previews (1920x1080) ...")
    save_previews("wide", 1920, 1080)

    print("\nGenerating vertical previews (1080x1920) ...")
    save_previews("vertical", 1080, 1920)

    print("\nRendering wide video ...")
    wide_out = render("wide_1920x1080", 1920, 1080)

    print("\nRendering vertical video ...")
    vert_out = render("vertical_1080x1920", 1080, 1920)

    print("\n" + "=" * 58)
    print("  OUTPUT FILES")
    print("=" * 58)
    for p in [wide_out, vert_out]:
        kb = os.path.getsize(p) // 1024
        print(f"  {p}")
        print(f"  {kb:,} KB  ({kb/1024:.1f} MB)")
        print()

    print("=" * 58)
    print("  NARRATION SCRIPT (record these lines)")
    print("=" * 58)
    lines = [
        ("S1  0\u20135 s",    "Ready to sell your cricket gear? Here\u2019s how to get started\n"
                               "             on Cricket Market USA in just three steps."),
        ("S2  5\u201313 s",   "First, go to cricketmarketusa.com and create a seller account.\n"
                               "             Choose \u201cI\u2019m selling\u201d, enter your name, email, and a password."),
        ("S3  13\u201318 s",  "Check your inbox for a verification link, then sign back in."),
        ("S4  18\u201327 s",  "In your Seller Dashboard, connect Stripe to receive payouts\u2014\n"
                               "             and add a ship-from address so buyers know where their order ships from."),
        ("S5  27\u201336 s",  "Click \u201cNew Listing\u201d, choose a category, set the condition and price,\n"
                               "             and upload a few photos.\n"
                               "             I\u2019m using a sample cricket bat listing here \u2014\n"
                               "             all details shown on screen are demonstration data only."),
        ("S6  36\u201342 s",  "Save as a draft to review, then hit Publish \u2014\n"
                               "             your listing goes live instantly.\n"
                               "             The listing name and price in this tutorial are\n"
                               "             fictional demonstration data, not a real item for sale."),
    ]
    for sec, text in lines:
        print(f"\n  [{sec}]")
        print(f"  \u201c{text}\u201d")
    print()


if __name__ == "__main__":
    main()
