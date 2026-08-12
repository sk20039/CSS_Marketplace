import type { MetadataRoute } from 'next';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_LISTING_URL || 'http://localhost:3002';
  try {
    const res = await fetch(`${base}/listings?status=active&limit=500`);
    const data = await res.json();
    const listings: any[] = Array.isArray(data) ? data : (data.listings || []);
    return listings.map((l: any) => ({
      url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3003'}/listings/${l.id}`,
      lastModified: new Date(l.updated_at),
      changeFrequency: 'daily' as const,
      priority: 0.8,
    }));
  } catch {
    return [];
  }
}
