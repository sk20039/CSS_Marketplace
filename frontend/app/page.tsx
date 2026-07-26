'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ListingCard from '@/components/ListingCard';
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

export default function HomePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getListings({ limit: 8 })
      .then((data) => setListings(data.listings || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="bg-green-700 text-white rounded-2xl px-8 py-12 text-center">
        <h1 className="text-4xl font-bold mb-3">USA Cricket Equipment Marketplace</h1>
        <p className="text-green-100 text-lg mb-6">Buy and sell quality cricket gear — bats, helmets, pads, gloves & more.</p>
        <Link href="/listings" className="bg-white text-green-700 font-semibold px-6 py-3 rounded-xl hover:bg-green-50 inline-block">
          Browse All Listings
        </Link>
      </section>

      {/* Featured Listings */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900">Featured Listings</h2>
          <Link href="/listings" className="text-green-600 text-sm hover:underline">View all →</Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-gray-200 rounded-xl aspect-square animate-pulse" />
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <p className="text-gray-400 text-lg">No listings yet.</p>
            <Link href="/register" className="mt-4 inline-block text-green-600 hover:underline">
              Be the first to sell!
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
          </div>
        )}
      </section>

      {/* Categories */}
      <section>
        <h2 className="text-xl font-bold text-gray-900 mb-4">Shop by Category</h2>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {[
            { value: 'bat', label: 'Bats', emoji: '🏏' },
            { value: 'helmet', label: 'Helmets', emoji: '⛑️' },
            { value: 'pads', label: 'Pads', emoji: '🦵' },
            { value: 'gloves', label: 'Gloves', emoji: '🧤' },
            { value: 'kit-bag', label: 'Kit Bags', emoji: '🎒' },
            { value: 'other', label: 'Other', emoji: '📦' },
          ].map((cat) => (
            <Link
              key={cat.value}
              href={`/listings?category=${cat.value}`}
              className="bg-white border border-gray-200 rounded-xl p-4 text-center hover:border-green-400 hover:shadow-sm transition-all"
            >
              <div className="text-3xl mb-1">{cat.emoji}</div>
              <p className="text-xs font-medium text-gray-700">{cat.label}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
