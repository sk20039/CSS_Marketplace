# -*- coding: utf-8 -*-
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

"""
Homepage category image and layout test.
Checks:
  1. All six WebP category images load (no broken images)
  2. No JS console errors
  3. Each card href matches the correct /listings?category=<value>
  4. Image containers have uniform height
  5. Featured Listings, Trust Badges, How It Works sections untouched
  6. Responsive grid: 2-col mobile, 3-col tablet, 6-col desktop
"""

EXPECTED_CATEGORIES = [
    ("Cricket Bats",  "/listings?category=bat"),
    ("Helmets",       "/listings?category=helmet"),
    ("Batting Pads",  "/listings?category=pads"),
    ("Gloves",        "/listings?category=gloves"),
    ("Kit Bags",      "/listings?category=kit-bag"),
    ("Accessories",   "/listings?category=other"),
]

EXPECTED_WEBP = [
    "bat.webp",
    "helmet.webp",
    "pads.webp",
    "gloves.webp",
    "kitbag.webp",
    "accessories.webp",
]

results = []

def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    results.append((status, name, detail))
    marker = "[OK]" if ok else "[FAIL]"
    msg = f"  {marker} {name}"
    if detail:
        msg += f" -- {detail}"
    print(msg)

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ------------------------------------------------------------------ desktop
    print("")
    print("== Desktop (1280x800) ==")
    page = browser.new_page()
    page.set_viewport_size({"width": 1280, "height": 800})

    console_errors = []
    page.on("console", lambda msg: console_errors.append(msg.text)
            if msg.type == "error" else None)

    page.goto("http://localhost:3003", wait_until="load", timeout=60000)
    page.wait_for_timeout(2000)  # allow images to decode

    # 1. Console errors
    check("No JS console errors", len(console_errors) == 0,
          str(console_errors[:3]) if console_errors else "")

    # 2. Section heading
    check("'Shop by Category' heading present",
          page.locator("text=Shop by Category").count() > 0)

    # 3. Each card label + href
    for label, href in EXPECTED_CATEGORIES:
        link = page.locator(f"a[href='{href}']")
        has_label = link.filter(has_text=label).count() > 0
        check(f"Card '{label}' links to {href}", link.count() > 0 and has_label)

    # 4. WebP images loaded (naturalWidth > 0)
    broken = []
    for webp in EXPECTED_WEBP:
        loaded = page.evaluate(f"""
            () => {{
                const imgs = [...document.querySelectorAll('img')];
                const match = imgs.find(img =>
                    img.src.includes('{webp}') ||
                    img.src.includes(encodeURIComponent('/categories/{webp}'))
                );
                if (!match) return 'not_found';
                return match.naturalWidth > 0 ? 'ok' : 'broken';
            }}
        """)
        check(f"Image {webp} loaded", loaded == "ok", f"status={loaded}")
        if loaded != "ok":
            broken.append(webp)

    # 5. No broken img elements anywhere on the page
    broken_imgs = page.evaluate("""
        () => [...document.querySelectorAll('img')]
            .filter(img => img.complete && img.naturalWidth === 0 && img.src !== '')
            .map(img => img.src.split('/').pop())
    """)
    check("No broken <img> elements on page", len(broken_imgs) == 0,
          str(broken_imgs) if broken_imgs else "")

    # 6. Uniform container height across all 6 cards
    heights = page.evaluate("""
        () => [...document.querySelectorAll('a[href*="/listings?category"]')]
            .map(a => {
                const c = a.querySelector('.relative');
                return c ? Math.round(c.getBoundingClientRect().height) : 0;
            })
    """)
    unique_heights = list(set(h for h in heights if h > 0))
    check("All 6 image containers have uniform height",
          len(heights) == 6 and len(unique_heights) == 1,
          f"heights={heights}")

    # 7. Other sections untouched
    check("'Featured Listings' section present",
          page.locator("text=Featured Listings").count() > 0)
    check("'Secure Payments' trust badge present",
          page.locator("text=Secure Payments").count() > 0)
    check("'How Cricket Market Works' section present",
          page.locator("text=How Cricket Market Works").count() > 0)

    page.screenshot(path="/tmp/hp_desktop.png", full_page=True)
    print("  Screenshot: /tmp/hp_desktop.png")
    page.close()

    # ------------------------------------------------------------------ mobile
    print("")
    print("== Mobile (375x667) ==")
    page = browser.new_page()
    page.set_viewport_size({"width": 375, "height": 667})
    page.goto("http://localhost:3003", wait_until="load", timeout=60000)
    page.wait_for_timeout(2000)  # allow images to decode

    card_count = page.locator("a[href*='/listings?category']").count()
    check(f"All 6 category cards present on mobile (found {card_count})", card_count == 6)

    # 2-col: first two cards share the same top position
    tops = page.evaluate("""
        () => [...document.querySelectorAll('a[href*="/listings?category"]')]
            .slice(0, 2)
            .map(a => Math.round(a.getBoundingClientRect().top))
    """)
    same_row = len(tops) == 2 and abs(tops[0] - tops[1]) < 20
    check("2-column layout on mobile (cards 1+2 on same row)", same_row,
          f"tops={tops}")

    imgs_ok = page.evaluate("""
        () => [...document.querySelectorAll('a[href*="/listings?category"] img')]
            .filter(img => img.naturalWidth > 0).length
    """)
    check(f"All 6 category images loaded on mobile (found {imgs_ok})", imgs_ok == 6)

    page.screenshot(path="/tmp/hp_mobile.png", full_page=True)
    print("  Screenshot: /tmp/hp_mobile.png")
    page.close()

    # ------------------------------------------------------------------ tablet
    print("")
    print("== Tablet (768x1024) ==")
    page = browser.new_page()
    page.set_viewport_size({"width": 768, "height": 1024})
    page.goto("http://localhost:3003", wait_until="load", timeout=60000)
    page.wait_for_timeout(2000)  # allow images to decode

    # sm:grid-cols-3 -- first 3 cards should share the same top, 4th should differ
    tops = page.evaluate("""
        () => [...document.querySelectorAll('a[href*="/listings?category"]')]
            .slice(0, 4)
            .map(a => Math.round(a.getBoundingClientRect().top))
    """)
    if len(tops) == 4:
        row1 = tops[0]
        in_row1 = sum(1 for t in tops if abs(t - row1) < 20)
        check(f"3-column layout on tablet ({in_row1} cards in row 1, expected 3)",
              in_row1 == 3, f"tops={tops}")
    else:
        check("3-column layout on tablet", False, f"found only {len(tops)} positions")

    page.screenshot(path="/tmp/hp_tablet.png", full_page=True)
    print("  Screenshot: /tmp/hp_tablet.png")
    page.close()

    browser.close()

# ------------------------------------------------------------------ summary
print("")
print("=" * 60)
passed = sum(1 for r in results if r[0] == "PASS")
failed = sum(1 for r in results if r[0] == "FAIL")
print(f"Results: {passed} passed, {failed} failed out of {len(results)} checks")

if failed:
    print("")
    print("Failed:")
    for status, name, detail in results:
        if status == "FAIL":
            print(f"  [FAIL] {name}" + (f" -- {detail}" if detail else ""))
    sys.exit(1)
else:
    print("All checks passed.")
