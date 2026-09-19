import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://www.cricketmarketusa.com';
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/listings', '/listings/'],
        disallow: [
          '/admin',
          '/dashboard',
          '/checkout',
          '/orders',
          '/settings',
          '/login',
          '/register',
          '/login/mfa',
          '/forgot-password',
          '/reset-password',
          '/verify-email',
          '/resend-verification',
          '/api/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
