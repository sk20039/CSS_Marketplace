/** @type {import('next').NextConfig} */

// Stripe requires several src directives — keep them in sync with:
// https://stripe.com/docs/security/guide#content-security-policy
const railwayApis = [
  'https://auth-service-production-7d82.up.railway.app',
  'https://listing-service-production-ccb1.up.railway.app',
  'https://escrow-service-production-7727.up.railway.app',
].join(' ');

const cspHeader = [
  "default-src 'self'",
  // Next.js App Router requires 'unsafe-inline' for hydration scripts.
  "script-src 'self' 'unsafe-inline' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${railwayApis} https://api.stripe.com https://errors.stripe.com`,
  // Stripe Elements renders in iframes hosted on js.stripe.com / hooks.stripe.com
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  `img-src 'self' data: https://*.stripe.com https://listing-service-production-ccb1.up.railway.app`,
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
      {
        protocol: 'https',
        hostname: 'listing-service-production-ccb1.up.railway.app',
        pathname: '/photos/**',
      },
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
