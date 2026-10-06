"""
Diagnose Turnstile on staging checkout page.
Captures: console errors, network requests to challenges.cloudflare.com,
actual site key rendered in page, and Turnstile widget state.
"""
from playwright.sync_api import sync_playwright
import json, re

STAGING_BASE = "https://css-marketplace-frontend.vercel.app"

def log(msg):
    print(f"[diag] {msg}", flush=True)

console_msgs = []
network_events = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
    )
    page = ctx.new_page()

    # Capture all console output
    page.on("console", lambda m: console_msgs.append({
        "type": m.type,
        "text": m.text,
    }))

    # Capture all network requests/responses for Cloudflare Turnstile
    def on_response(resp):
        if "cloudflare" in resp.url or "turnstile" in resp.url.lower() or "challenges" in resp.url:
            try:
                body = resp.text()
            except Exception:
                body = "<unreadable>"
            network_events.append({
                "url": resp.url,
                "status": resp.status,
                "body_snippet": body[:500],
            })
    page.on("response", on_response)

    # ── Step 1: get a listing URL ─────────────────────────────────────────
    log("Loading listings page...")
    page.goto(f"{STAGING_BASE}/listings", wait_until="domcontentloaded")
    page.wait_for_timeout(3000)

    listing_url = None
    for a in page.locator("a[href*='/listings/']").all():
        href = a.get_attribute("href") or ""
        seg = href.split("/")[-1]
        if href.startswith("/listings/") and seg.isdigit():
            listing_url = f"{STAGING_BASE}{href}"
            break

    if not listing_url:
        log("ERROR: no listing found")
        browser.close()
        raise SystemExit(1)

    log(f"Listing: {listing_url}")

    # ── Step 2: go to listing → click Buy Now ────────────────────────────
    page.goto(listing_url, wait_until="domcontentloaded")
    page.wait_for_timeout(2500)

    buy = page.locator("text=Buy Now").first
    buy.wait_for(timeout=8000)
    buy.click()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(2000)

    log(f"Checkout page: {page.url}")

    # ── Step 3: wait for Turnstile widget to appear and attempt render ────
    log("Waiting 10 s for Turnstile widget to render...")
    page.wait_for_timeout(10000)

    page.screenshot(path="C:/tmp/ts_diag_widget.png", full_page=True)
    log("Screenshot: C:/tmp/ts_diag_widget.png")

    # ── Step 4: extract site key from the DOM ────────────────────────────
    site_key_in_dom = page.evaluate("""() => {
        // Turnstile renders a div with data-sitekey or cf-turnstile attribute
        const el = document.querySelector('[data-sitekey], cf-turnstile, .cf-turnstile, [class*="turnstile"]');
        if (el) return el.getAttribute('data-sitekey') || el.getAttribute('sitekey') || el.outerHTML.substring(0, 300);

        // Also check any script tags or inline config
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
            const m = s.textContent.match(/sitekey['":\\s]+([0-9a-zA-Z_-]{20,})/);
            if (m) return m[1];
        }
        return null;
    }""")

    # Also check iframes (Turnstile renders inside an iframe)
    turnstile_iframes = page.evaluate("""() => {
        return Array.from(document.querySelectorAll('iframe')).map(f => ({
            src: f.src || '',
            id: f.id || '',
            name: f.name || '',
            title: f.title || '',
        })).filter(f => f.src.includes('cloudflare') || f.src.includes('turnstile') || f.src.includes('challenges'));
    }""")

    # Check for error codes inside any Turnstile iframe
    ts_error_code = page.evaluate("""() => {
        // Turnstile widget error codes are exposed on window.__cf_chl_opt or similar
        const opt = window.__cf_chl_opt;
        if (opt) return JSON.stringify(opt);
        // Check for error text in widget divs
        const els = document.querySelectorAll('[class*="turnstile"], [id*="turnstile"], cf-turnstile');
        return Array.from(els).map(e => e.textContent.trim()).join(' | ');
    }""")

    # Extract NEXT_PUBLIC_TURNSTILE_SITE_KEY from __NEXT_DATA__ or env
    next_data = page.evaluate("""() => {
        const nd = window.__NEXT_DATA__;
        if (!nd) return null;
        const s = JSON.stringify(nd);
        const m = s.match(/TURNSTILE[^"]*"[^"]*"([^"]{10,})/);
        return m ? m[1] : null;
    }""")

    # Also grep the page HTML for any sitekey pattern
    html = page.content()
    sitekey_in_html = re.findall(r'0x4[A-Za-z0-9_-]{15,}', html)

    # ── Step 5: check JS bundle for NEXT_PUBLIC_TURNSTILE_SITE_KEY ───────
    log("Fetching _next/static chunks to find baked-in site key...")
    chunk_urls = page.evaluate("""() => {
        return Array.from(document.querySelectorAll('script[src*="_next/static"]'))
            .map(s => s.src)
            .filter(u => u.includes('chunks') || u.includes('app'));
    }""")

    bundle_keys = set()
    for url in chunk_urls[:20]:  # check first 20 chunks
        try:
            resp = ctx.request.get(url)
            text = resp.text()
            found = re.findall(r'0x4[A-Za-z0-9_-]{15,}', text)
            for k in found:
                bundle_keys.add(k)
        except Exception:
            pass

    # ── Report ────────────────────────────────────────────────────────────
    print("\n" + "="*60)
    print("TURNSTILE DIAGNOSTIC REPORT")
    print("="*60)

    print(f"\nCheckout URL: {page.url}")

    print(f"\n--- Site key in DOM: {site_key_in_dom}")
    print(f"--- Site keys in page HTML: {list(set(sitekey_in_html))}")
    print(f"--- Site keys in JS bundles: {list(bundle_keys)}")
    print(f"--- NEXT_DATA env key: {next_data}")
    print(f"--- Turnstile iframes: {json.dumps(turnstile_iframes, indent=2)}")
    print(f"--- Widget error text: {ts_error_code!r}")

    print("\n--- Cloudflare network events:")
    if network_events:
        for ev in network_events:
            print(f"  {ev['status']} {ev['url']}")
            print(f"       {ev['body_snippet'][:200]}")
    else:
        print("  (none — widget may not have reached Cloudflare at all)")

    print("\n--- Browser console messages:")
    if console_msgs:
        for m in console_msgs:
            if m["type"] in ("error", "warning") or "turnstile" in m["text"].lower() or "captcha" in m["text"].lower():
                print(f"  [{m['type'].upper()}] {m['text']}")
    else:
        print("  (none)")

    all_errors = [m for m in console_msgs if m["type"] == "error"]
    if all_errors:
        print("\n--- All console errors:")
        for m in all_errors:
            print(f"  {m['text']}")

    print("\n" + "="*60)

    browser.close()
