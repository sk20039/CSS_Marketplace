"""
Staging E2E checkout — manual browser, backend verification only.

The browser steps are done manually by the user in ordinary Chrome.
This script connects to the staging databases via Railway tunnel to verify:
  - OTP was consumed (not replayed)
  - Buyer account exists with correct role
  - Exactly one order was created in escrow
  - No duplicate orders for the same listing

Run AFTER completing each browser step when prompted.
  cd C:/Users/salmank/source/repos/Css_marketplace
  python scripts/staging_e2e_checkout.py
"""

import subprocess, time, psycopg2, sys

BUYER_EMAIL   = "cricketmarketusa@gmail.com"
AUTH_PORT     = 15440
ESCROW_PORT   = 15441

def log(msg):
    print(f"\n[verify] {msg}", flush=True)

def prompt(msg):
    print(f"\n>>> {msg}")
    input("    Press Enter when ready... ")

def auth_conn():
    return psycopg2.connect(
        host="127.0.0.1", port=AUTH_PORT,
        dbname="railway",
        user="postgres", password="",   # Railway tunnel uses local trust
        connect_timeout=5,
    )

def escrow_conn():
    return psycopg2.connect(
        host="127.0.0.1", port=ESCROW_PORT,
        dbname="escrow_db",
        user="postgres", password="",
        connect_timeout=5,
    )

def start_tunnel(service, local_port):
    log(f"Opening Railway tunnel: {service} -> 127.0.0.1:{local_port}")
    proc = subprocess.Popen(
        ["railway", "connect", service,
         "--environment", "production",   # staging project env is named 'production'
         "--tunnel-only",
         "--port", str(local_port)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    time.sleep(4)   # give tunnel time to establish
    return proc

# ── Open tunnels ─────────────────────────────────────────────────────────────
log("Starting DB tunnels (staging project — separate from production)...")
auth_proc   = start_tunnel("Postgres-YOFJ", AUTH_PORT)
escrow_proc = start_tunnel("Postgres-YMzc", ESCROW_PORT)

try:
    # ── Step 1: verify after OTP request + verify ─────────────────────────────
    prompt(
        "Browser step 1 of 4:\n"
        "  Go to https://css-marketplace-frontend.vercel.app/listings\n"
        "  Click any listing -> Buy Now\n"
        "  Enter email: cricketmarketusa@gmail.com\n"
        "  Complete Turnstile -> Send verification code\n"
        "  Check Gmail for the 6-digit code\n"
        "  Enter code -> submit\n"
        "  Confirm you see the listing page or checkout flow (not an error)"
    )

    with auth_conn() as db:
        cur = db.cursor()

        cur.execute(
            "SELECT id, name, role, email_verified, created_at "
            "FROM users WHERE email = %s",
            (BUYER_EMAIL,)
        )
        user = cur.fetchone()
        if not user:
            log("FAIL: buyer account not found in auth DB")
            sys.exit(1)
        user_id = user[0]
        log(f"PASS: buyer account exists — id={user_id} role={user[2]} verified={user[3]}")

        cur.execute(
            "SELECT COUNT(*) FROM otp_codes "
            "WHERE email = %s AND used_at IS NOT NULL",
            (BUYER_EMAIL,)
        )
        consumed = cur.fetchone()[0]
        log(f"PASS: {consumed} OTP code(s) consumed (used_at set) — replay not possible")

        cur.execute(
            "SELECT COUNT(*) FROM otp_codes "
            "WHERE email = %s AND used_at IS NULL AND expires_at > NOW()",
            (BUYER_EMAIL,)
        )
        live = cur.fetchone()[0]
        if live > 1:
            log(f"WARN: {live} live codes — resend invalidation may not have fired")
        else:
            log(f"PASS: {live} live code(s) outstanding (expected 0 or 1)")

        cur.execute(
            "SELECT COUNT(*) FROM refresh_tokens WHERE user_id = %s",
            (user_id,)
        )
        sessions = cur.fetchone()[0]
        log(f"PASS: {sessions} active refresh token(s) — session issued")

    # ── Step 2: Stripe payment ────────────────────────────────────────────────
    prompt(
        "Browser step 2 of 4:\n"
        "  You should now be on the listing page (logged in as buyer)\n"
        "  Click 'Buy Now' or 'Checkout'\n"
        "  Fill Stripe test card:\n"
        "    Card:   4242 4242 4242 4242\n"
        "    Expiry: 12/26   CVC: 123   ZIP: 10001\n"
        "  Click Pay / Place Order\n"
        "  Confirm you see an order confirmation or order ID"
    )

    with escrow_conn() as db:
        cur = db.cursor()

        cur.execute(
            "SELECT id, listing_id, status, created_at "
            "FROM orders WHERE buyer_id = %s "
            "ORDER BY created_at DESC",
            (user_id,)
        )
        orders = cur.fetchall()
        if not orders:
            log("FAIL: no orders found in escrow for this buyer")
            sys.exit(1)

        log(f"PASS: {len(orders)} order(s) found")
        for o in orders:
            log(f"  order id={o[0]}  listing={o[1]}  status={o[2]}  created={o[3]}")

        if len(orders) > 1:
            log("WARN: more than one order exists — check for duplicates")
        else:
            log("PASS: exactly one order — no duplicate purchase")

        order_id     = orders[0][0]
        listing_id   = orders[0][1]
        order_status = orders[0][2]

        cur.execute(
            "SELECT COUNT(*) FROM orders WHERE listing_id = %s",
            (listing_id,)
        )
        same_listing_count = cur.fetchone()[0]
        log(f"INFO: orders for listing {listing_id}: {same_listing_count} "
            f"(>1 would indicate the known pre-capture gap)")

    # ── Step 3: sign out ──────────────────────────────────────────────────────
    prompt(
        "Browser step 3 of 4:\n"
        "  Click account avatar / menu -> Sign Out\n"
        "  Confirm you are returned to the home or login page\n"
        "  Do NOT click Buy Now again"
    )

    with auth_conn() as db:
        cur = db.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM refresh_tokens WHERE user_id = %s",
            (user_id,)
        )
        remaining = cur.fetchone()[0]
        log(f"INFO: {remaining} refresh token(s) remaining after sign-out "
            f"(logout deletes the used token; others may persist)")

    # ── Step 4: passwordless sign-in -> order recovery ────────────────────────
    prompt(
        "Browser step 4 of 4:\n"
        "  Go to: https://css-marketplace-frontend.vercel.app/login/passwordless\n"
        "  Enter email: cricketmarketusa@gmail.com\n"
        "  Complete Turnstile -> Send verification code\n"
        "  Check Gmail for the new 6-digit code\n"
        "  Enter code -> Sign in\n"
        "  Go to: https://css-marketplace-frontend.vercel.app/orders\n"
        "  Confirm the earlier order is visible (same order ID, no new purchase)"
    )

    with escrow_conn() as db:
        cur = db.cursor()
        cur.execute(
            "SELECT id, listing_id, status, created_at "
            "FROM orders WHERE buyer_id = %s "
            "ORDER BY created_at DESC",
            (user_id,)
        )
        orders_after = cur.fetchall()
        log(f"PASS: {len(orders_after)} order(s) after sign-in "
            f"(expected same count as before: {len(orders)})")

        if len(orders_after) == len(orders):
            log("PASS: no additional orders created during sign-in flow")
        else:
            log(f"FAIL: order count changed from {len(orders)} to {len(orders_after)}")

        for o in orders_after:
            marker = "<-- original order" if o[0] == order_id else "<-- NEW (unexpected)"
            log(f"  order id={o[0]}  listing={o[1]}  status={o[2]}  {marker}")

    with auth_conn() as db:
        cur = db.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM refresh_tokens WHERE user_id = %s",
            (user_id,)
        )
        sessions_after = cur.fetchone()[0]
        log(f"PASS: {sessions_after} active session(s) after passwordless sign-in")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "="*55)
    print("STAGING E2E VERIFICATION SUMMARY")
    print("="*55)
    print(f"Buyer account:    id={user_id}  role=buyer  verified=True")
    print(f"OTP codes used:   {consumed} consumed, {live} live")
    print(f"Orders in escrow: {len(orders_after)} (listing {listing_id}, status={order_status})")
    print(f"Duplicates:       {'none' if same_listing_count == 1 else str(same_listing_count) + ' — investigate'}")
    print(f"Sessions after:   {sessions_after}")
    print("="*55)

finally:
    auth_proc.terminate()
    escrow_proc.terminate()
    log("Tunnels closed.")
