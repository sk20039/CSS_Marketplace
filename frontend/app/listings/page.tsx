'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ListingCard from '@/components/ListingCard';
import SearchSidebar from '@/components/SearchSidebar';
import { getListings } from '@/lib/api';

interface Listing {
  id: number;
  title: string;
  price_cents: number;
  category: string;
  condition: string;
  status: string;
  photos: { id: number; filename: string; display_order: number }[];
}

function MarketplaceContent() {
  const searchParams = useSearchParams();
  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    searchParams.forEach((v, k) => { params[k] = v; });

    getListings(params)
      .then((data) => {
        setListings(data.listings || []);
        setTotal(data.total || 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [searchParams]);

  return (
    <div className="flex gap-8">
      <SearchSidebar />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-gray-900">
            {searchParams.get('q')
              ? `Results for "${searchParams.get('q')}"`
              : 'All Listings'}
          </h1>
          <span className="text-sm text-gray-500">{total} item{total !== 1 ? 's' : ''}</span>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="bg-gray-200 rounded-xl aspect-square animate-pulse" />
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
            <p className="text-gray-400 text-lg">No listings found.</p>
            <p className="text-gray-400 text-sm mt-1">Try adjusting your filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
            {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ListingsPage() {
  return (
    <Suspense fallback={<div className="text-gray-400">Loading...</div>}>
      <MarketplaceContent />
    </Suspense>
  );
}
