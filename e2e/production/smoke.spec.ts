import { test, expect, type Page } from '@playwright/test';

// ── Production safety: block all mutation verbs ───────────────────────────
// Any accidental POST/PUT/PATCH/DELETE from these tests is a hard failure.
// Exception: POST /auth/refresh is automatically called by AuthProvider on
// every page load (silent token refresh from httpOnly cookie). It is not a
// data mutation — it attempts a cookie-based refresh and gets 401 in the
// unauthenticated test browser, which is the correct and expected outcome.
const ALLOWED_POSTS = [
  /\/auth\/refresh$/,
  // Cloudflare Turnstile widget makes internal POSTs to its own challenge
  // platform during initialization. These are not data mutations.
  /challenges\.cloudflare\.com/,
];

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (method === 'POST' && ALLOWED_POSTS.some((re) => re.test(url))) {
        route.continue();
        return;
      }
      route.abort('failed');
      throw new Error(`SAFETY VIOLATION: test attempted ${method} ${url}`);
    }
    route.continue();
  });
});

// ── Console/network error capture ─────────────────────────────────────────
function attachErrorListeners(page: Page) {
  const jsErrors: string[] = [];
  const networkFailures: string[] = [];

  page.on('pageerror', (err) => jsErrors.push(err.message));
  page.on('response', (resp) => {
    // Only care about first-party failures (our domain + Vercel CDN)
    const url = resp.url();
    const isCritical =
      url.includes('cricketmarketusa.com') ||
      url.includes('railway.app') ||
      url.includes('_next/');
    if (isCritical && resp.status() >= 500) {
      networkFailures.push(`${resp.status()} ${url}`);
    }
  });

  return { jsErrors, networkFailures };
}

// ── Test 1: Homepage loads and main content renders ───────────────────────
test('homepage loads and main content renders', async ({ page }) => {
  const { jsErrors, networkFailures } = attachErrorListeners(page);

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // Title correct
  await expect(page).toHaveTitle(/Cricket Market/);

  // Navbar logo
  await expect(page.getByRole('link', { name: /CricketMarket/i }).first()).toBeVisible();

  // Hero h1 contains the primary marketing headline
  const h1 = page.locator('h1').first();
  await expect(h1).toBeVisible();
  await expect(h1).toContainText('Cricket');

  // Hero CTA to listings is present
  await expect(page.getByRole('link', { name: /Browse All Gear/i })).toBeVisible();

  // No unhandled JS errors
  expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
  expect(networkFailures, `Network failures: ${networkFailures.join(', ')}`).toHaveLength(0);
});

// ── Test 2: /listings loads and at least one listing card renders ──────────
test('/listings loads and at least one listing card renders', async ({ page }) => {
  const { jsErrors, networkFailures } = attachErrorListeners(page);

  await page.goto('/listings');
  await page.waitForLoadState('networkidle');

  // Page heading
  await expect(page.locator('h1').first()).toBeVisible();

  // At least one listing card link (links to /listings/[id])
  const listingLinks = page.locator('a[href^="/listings/"]').filter({ hasNot: page.locator('nav') });
  await expect(listingLinks.first()).toBeVisible({ timeout: 15_000 });

  expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
  expect(networkFailures, `Network failures: ${networkFailures.join(', ')}`).toHaveLength(0);
});

// ── Test 3: First listing detail page renders with title and price ─────────
test('first listing detail page renders with title and price', async ({ page }) => {
  const { jsErrors, networkFailures } = attachErrorListeners(page);

  await page.goto('/listings');
  await page.waitForLoadState('networkidle');

  // Find first listing card link outside nav/footer
  const firstCard = page.locator('main a[href^="/listings/"]').first();
  await expect(firstCard).toBeVisible({ timeout: 15_000 });

  const detailUrl = await firstCard.getAttribute('href');
  expect(detailUrl).toMatch(/^\/listings\/\d+$/);

  await page.goto(detailUrl!);
  await page.waitForLoadState('domcontentloaded');

  // Title: listing name should render in an h1 or prominent heading
  const heading = page.locator('h1, h2').first();
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const headingText = await heading.textContent();
  expect(headingText?.trim().length).toBeGreaterThan(0);

  // Price: dollar amount visible somewhere on page
  await expect(page.locator('text=/\\$[0-9]/')).toBeVisible({ timeout: 10_000 });

  expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
  expect(networkFailures, `Network failures: ${networkFailures.join(', ')}`).toHaveLength(0);
});

// ── Test 4: /login renders form controls and Turnstile ────────────────────
test('/login renders form controls and Turnstile container', async ({ page }) => {
  const { jsErrors, networkFailures } = attachErrorListeners(page);

  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();

  // Submit button is disabled before Turnstile solves
  const submitBtn = page.getByRole('button', { name: /Sign in/i });
  await expect(submitBtn).toBeVisible();
  await expect(submitBtn).toBeDisabled();

  // In headless Chromium, Turnstile renders a container div and injects a
  // hidden response input — no iframe. Assert the response input exists,
  // which confirms the Cloudflare JS loaded and initialized the widget.
  await expect(
    page.locator('input[id*="cf-chl-widget"]'),
  ).toBeAttached({ timeout: 15_000 });

  expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
  expect(networkFailures, `Network failures: ${networkFailures.join(', ')}`).toHaveLength(0);
});

// ── Test 5: /register renders form controls and Turnstile ─────────────────
test('/register renders form controls and Turnstile container', async ({ page }) => {
  const { jsErrors, networkFailures } = attachErrorListeners(page);

  await page.goto('/register');
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('input[type="text"]').first()).toBeVisible();
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();

  // Submit button is disabled before Turnstile solves
  const submitBtn = page.getByRole('button', { name: /Create/i });
  await expect(submitBtn).toBeVisible();
  await expect(submitBtn).toBeDisabled();

  // Turnstile response input — same headless-mode check as /login
  await expect(
    page.locator('input[id*="cf-chl-widget"]'),
  ).toBeAttached({ timeout: 15_000 });

  expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
  expect(networkFailures, `Network failures: ${networkFailures.join(', ')}`).toHaveLength(0);
});

// ── Test 6: JS errors / critical network failures (standalone journey) ─────
// Tests 1–5 already attach error listeners to their own pages. This test
// exercises the homepage→listings flow and fails explicitly on any error.
test('no critical JS errors or 5xx failures on homepage→listings journey', async ({ page }) => {
  const jsErrors: string[] = [];
  const networkFailures: string[] = [];

  page.on('pageerror', (err) => jsErrors.push(err.message));
  page.on('response', (resp) => {
    const url = resp.url();
    const isCritical =
      url.includes('cricketmarketusa.com') ||
      url.includes('railway.app') ||
      url.includes('_next/');
    if (isCritical && resp.status() >= 500) {
      networkFailures.push(`${resp.status()} ${url}`);
    }
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByRole('link', { name: /Browse All Gear/i }).click();
  await page.waitForLoadState('networkidle');

  expect(jsErrors, `Unhandled JS errors:\n  ${jsErrors.join('\n  ')}`).toHaveLength(0);
  expect(networkFailures, `Critical 5xx responses:\n  ${networkFailures.join('\n  ')}`).toHaveLength(0);
});

// ── Test 7: Mobile 390x844 — homepage renders and hamburger nav opens ──────
test('mobile viewport: homepage renders and hamburger nav opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { jsErrors, networkFailures } = attachErrorListeners(page);

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  await expect(page).toHaveTitle(/Cricket Market/);

  // Hamburger button visible at mobile width
  const hamburger = page.getByRole('button', { name: /Open navigation menu/i });
  await expect(hamburger).toBeVisible();

  // Click hamburger → mobile drawer opens
  await hamburger.click();
  const drawer = page.locator('#mobile-nav');
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  // Drawer contains Login and Register links
  await expect(drawer.getByRole('link', { name: /Login/i })).toBeVisible();
  await expect(drawer.getByRole('link', { name: /Create account/i })).toBeVisible();

  expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
  expect(networkFailures, `Network failures: ${networkFailures.join(', ')}`).toHaveLength(0);
});
