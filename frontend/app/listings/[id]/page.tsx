import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchListingServer } from '@/lib/serverApi';
import { CATEGORY_LABELS } from '@/lib/constants';
import ListingDetailClient from './ListingDetailClient';

// schema.org itemCondition values for the conditions defined in constants.ts
const CONDITION_SCHEMA: Record<string, string> = {
  new:       'https://schema.org/NewCondition',
  used_good: 'https://schema.org/UsedCondition',
  used_fair: 'https://schema.org/UsedCondition',
};

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const listing = await fetchListingServer(params.id);
  if (!listing) return { title: 'Listing Not Found | Cricket Market' };

  let tags: string[] = [];
  try {
    tags = listing.tags ? JSON.parse(listing.tags) : [];
  } catch { tags = []; }

  const appBase     = process.env.NEXT_PUBLIC_APP_URL    || 'https://www.cricketmarketusa.com';
  const listingBase = process.env.NEXT_PUBLIC_LISTING_URL || '';
  const canonicalUrl = `${appBase}/listings/${listing.id}`;

  const title = listing.meta_title || `${listing.title} | Cricket Market`;
  const description =
    listing.meta_description ||
    (listing.description || '').slice(0, 155) ||
    'Buy cricket equipment on Cricket Market';

  const firstPhoto = listing.photos?.[0];
  const ogImageUrl =
    firstPhoto && listingBase
      ? `${listingBase}/photos/${firstPhoto.filename}`
      : undefined;

  return {
    title,
    description,
    keywords: tags.join(', '),
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: listing.meta_title || listing.title,
      description,
      type: 'website',
      url: canonicalUrl,
      ...(ogImageUrl ? { images: [{ url: ogImageUrl }] } : {}),
    },
  };
}

export default async function ListingDetailPage({ params }: { params: { id: string } }) {
  const listing = await fetchListingServer(params.id);
  if (!listing) notFound();

  const appBase     = process.env.NEXT_PUBLIC_APP_URL    || 'https://www.cricketmarketusa.com';
  const listingBase = process.env.NEXT_PUBLIC_LISTING_URL || '';
  const canonicalUrl = `${appBase}/listings/${listing.id}`;

  const firstPhoto = listing.photos?.[0];
  const imageUrl =
    firstPhoto && listingBase
      ? `${listingBase}/photos/${firstPhoto.filename}`
      : undefined;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type':    'Product',
    name:       listing.title,
    category:   CATEGORY_LABELS[listing.category as string] || listing.category,
    url:        canonicalUrl,
    ...(listing.description ? { description: listing.description } : {}),
    ...(imageUrl             ? { image: imageUrl }                 : {}),
    offers: {
      '@type':        'Offer',
      price:          (listing.price_cents / 100).toFixed(2),
      priceCurrency:  'USD',
      url:            canonicalUrl,
      ...(CONDITION_SCHEMA[listing.condition as string]
        ? { itemCondition: CONDITION_SCHEMA[listing.condition as string] }
        : {}),
    },
  };

  // JSON.stringify is safe here; escape '<' to prevent any </script> injection.
  const jsonLdString = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdString }}
      />
      <ListingDetailClient initialListing={listing} />
    </>
  );
}
