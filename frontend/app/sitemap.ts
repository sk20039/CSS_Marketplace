import type { MetadataRoute } from 'next';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const listingBase = process.env.NEXT_PUBLIC_LISTING_URL || 'http://localhost:3002';
  const appBase     = process.env.NEXT_PUBLIC_APP_URL    || 'http://localhost:3003';

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${appBase}/`,                       lastModified: new Date(), changeFrequency: 'daily',   priority: 1.0 },
    { url: `${appBase}/listings`,               lastModified: new Date(), changeFrequency: 'hourly',  priority: 0.9 },
    { url: `${appBase}/legal/privacy`,          lastModified: new Date(), changeFrequency: 'monthly', priority: 0.3 },
    { url: `${appBase}/legal/terms`,            lastModified: new Date(), changeFrequency: 'monthly', priority: 0.3 },
    { url: `${appBase}/legal/buyer-protection`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.3 },
    { url: `${appBase}/legal/refunds`,          lastModified: new Date(), changeFrequency: 'monthly', priority: 0.3 },
    { url: `${appBase}/legal/prohibited-items`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.3 },
  ];

  try {
    const res = await fetch(`${listingBase}/listings?status=active&limit=500`);
    const data = await res.json();
    const listings: any[] = Array.isArray(data) ? data : (data.listings || []);
    const listingPages: MetadataRoute.Sitemap = listings.map((l: any) => ({
      url: `${appBase}/listings/${l.id}`,
      lastModified: new Date(l.updated_at),
      changeFrequency: 'daily' as const,
      priority: 0.8,
    }));
    return [...staticPages, ...listingPages];
  } catch {
    return staticPages;
  }
}
