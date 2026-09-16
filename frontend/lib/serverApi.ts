// Server-side fetch helper — no 'use client' directive.
// Used by Server Components (e.g. generateMetadata) to fetch listing data
// directly from the listing-service without going through the browser.

export async function fetchListingServer(id: string | number): Promise<any> {
  const base =
    process.env.LISTING_SERVICE_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_LISTING_URL ||
    'http://localhost:3002';

  try {
    const res = await fetch(`${base}/listings/${id}`, {
      cache: 'no-store', // always fetch fresh — listing detail must show current photos immediately after publish
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
