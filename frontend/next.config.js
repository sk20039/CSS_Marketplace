/** @type {import('next').NextConfig} */

// Stripe requires several src directives — keep them in sync with:
// https://stripe.com/docs/security/guide#content-security-policy
//
// CSP connect-src and image allowlist are derived from the service URL env
// vars so that Preview builds automatically use staging hosts and Production
// builds use production hosts — no branch-specific hostnames hardcoded here.

const authUrl     = process.env.NEXT_PUBLIC_AUTH_URL    || '';
const listingUrl  = process.env.NEXT_PUBLIC_LISTING_URL || '';
const escrowUrl   = process.env.NEXT_PUBLIC_ESCROW_URL  || '';

// connect-src: all three service origins (localhost ports are not 'self').
const apiOrigins = [authUrl, listingUrl, escrowUrl].filter(Boolean).join(' ');

// img-src: listing service serves photos; use its origin directly.
const listingImgSrc = listingUrl || '';

// remotePatterns for Next.js image optimisation: parse listing URL.
// localhost:3002 is covered by the hardcoded entry below.
function parseRemotePattern(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') return null;
    return {
      protocol: u.protocol.replace(':', ''),
      hostname: u.hostname,
      ...(u.port ? { port: u.port } : {}),
      pathname: '/photos/**',
    };
  } catch {
    return null;
  }
}

const listingPattern = parseRemotePattern(listingUrl);

const cspHeader = [
  "default-src 'self'",
  // Next.js App Router requires 'unsafe-inline' for hydration scripts.
  "script-src 'self' 'unsafe-inline' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self'${apiOrigins ? ` ${apiOrigins}` : ''} https://api.stripe.com https://errors.stripe.com`,
  // Stripe Elements renders in iframes hosted on js.stripe.com / hooks.stripe.com
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  `img-src 'self' data: https://*.stripe.com${listingImgSrc ? ` ${listingImgSrc}` : ''}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3002',
        pathname: '/photos/**',
      },
      ...(listingPattern ? [listingPattern] : []),
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: cspHeader },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
