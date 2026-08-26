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

const SORT_OPTIONS = [
  { value: '',             label: 'Newest first' },
  { value: 'price_asc',   label: 'Price: low to high' },
  { value: 'price_desc',  label: 'Price: high to low' },
];

function MarketplaceContent() {
  const searchParams = useSearchParams();
  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('');

  const query = searchParams.get('q');
  const category = searchParams.get('category');

  useEffect(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    searchParams.forEach((v, k) => { params[k] = v; });
    if (sort) params['sort'] = sort;

    getListings(params)
      .then((data) => {
        setListings(data.listings || []);
        setTotal(data.total || 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [searchParams, sort]);

  // Active filter chips
  const chips: { label: string; key: string }[] = [];
  if (category) chips.push({ label: category.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase()), key: 'category' });
  if (searchParams.get('condition')) chips.push({ label: searchParams.get('condition')!.replace('_', ' '), key: 'condition' });
  if (searchParams.get('min_price')) chips.push({ label: `Min $${(Number(searchParams.get('min_price')) / 100).toFixed(0)}`, key: 'min_price' });
  if (searchParams.get('max_price')) chips.push({ label: `Max $${(Number(searchParams.get('max_price')) / 100).toFixed(0)}`, key: 'max_price' });

  return (
    <div>
      {/* Page header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-400 mb-2">
          <span>Home</span>
          <span>/</span>
          <span className="text-gray-700 font-medium">
            {query ? `Search: "${query}"` : category ? category.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'All Listings'}
          </span>
        </div>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {query ? `Results for "${query}"` : category
                ? category.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())
                : 'All Listings'}
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {loading ? 'Loading...' : `${total} item${total !== 1 ? 's' : ''} found`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">Sort:</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 bg-white"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Active filter chips */}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {chips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1.5 bg-brand-50 text-brand-800 border border-brand-200 text-xs font-medium px-3 py-1 rounded-full"
              >
                {chip.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="md:flex md:gap-6 md:items-start">
        <SearchSidebar />

        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="aspect-square bg-gray-100 animate-pulse" />
                  <div className="p-3 space-y-2">
                    <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    <div className="h-4 bg-gray-100 rounded w-3/4 animate-pulse" />
                    <div className="h-5 bg-gray-100 rounded w-1/2 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : listings.length === 0 ? (
            <div className="text-center py-24 bg-white rounded-xl border border-gray-200">
              <svg className="w-16 h-16 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-gray-500 font-medium text-lg">No listings found</p>
              <p className="text-gray-400 text-sm mt-1">Try adjusting your filters or search term.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
              {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ListingsPage() {
  return (
    <Suspense fallback={
      <div className="md:flex md:gap-6 mt-6">
        <div className="hidden md:block w-60 shrink-0 h-96 bg-white rounded-xl border border-gray-200 animate-pulse" />
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="aspect-square bg-gray-100 animate-pulse" />
              <div className="p-3 space-y-2">
                <div className="h-4 bg-gray-100 rounded animate-pulse" />
                <div className="h-5 bg-gray-100 rounded w-1/2 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    }>
      <MarketplaceContent />
    </Suspense>
  );
}
