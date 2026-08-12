import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchListingServer } from '@/lib/serverApi';
import ListingDetailClient from './ListingDetailClient';

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const listing = await fetchListingServer(params.id);
  if (!listing) return { title: 'Listing Not Found | Cricket Market' };

  let tags: string[] = [];
  try {
    tags = listing.tags ? JSON.parse(listing.tags) : [];
  } catch { tags = []; }

  return {
    title: listing.meta_title || `${listing.title} | Cricket Market`,
    description:
      listing.meta_description ||
      (listing.description || '').slice(0, 155) ||
      'Buy cricket equipment on Cricket Market',
    keywords: tags.join(', '),
    openGraph: {
      title: listing.meta_title || listing.title,
      description:
        listing.meta_description || (listing.description || '').slice(0, 155),
      type: 'website',
    },
  };
}

export default async function ListingDetailPage({ params }: { params: { id: string } }) {
  const listing = await fetchListingServer(params.id);
  if (!listing) notFound();
  return <ListingDetailClient initialListing={listing} />;
}
