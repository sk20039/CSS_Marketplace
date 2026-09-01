'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
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

const CATEGORIES = [
  {
    value: 'bat',
    label: 'Cricket Bats',
    description: 'Kashmir willow, English willow & more',
    image: '/categories/bat.webp',
    alt: 'Used cricket bat for sale',
  },
  {
    value: 'helmet',
    label: 'Helmets',
    description: 'Masuri, Shrey & protective gear',
    image: '/categories/helmet.webp',
    alt: 'Cricket batting helmet with face guard',
  },
  {
    value: 'pads',
    label: 'Batting Pads',
    description: 'Front leg, thigh & shin protection',
    image: '/categories/pads.webp',
    alt: 'Cricket batting pads',
  },
  {
    value: 'gloves',
    label: 'Gloves',
    description: 'Batting & wicket keeping gloves',
    image: '/categories/gloves.webp',
    alt: 'Cricket batting gloves',
  },
  {
    value: 'kit-bag',
    label: 'Kit Bags',
    description: 'Duffle, wheelie & backpack styles',
    image: '/categories/kitbag.webp',
    alt: 'Cricket kit bag',
  },
  {
    value: 'other',
    label: 'Accessories',
    description: 'Balls, grips, guards & more',
    image: '/categories/accessories.webp',
    alt: 'Cricket ball and accessories',
  },
];

const TRUST_BADGES = [
  {
    icon: (
      <svg className="w-7 h-7 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    title: 'Secure Payments',
    text: 'Payment held safely until you confirm delivery',
  },
  {
    icon: (
      <svg className="w-7 h-7 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    title: 'Verified Listings',
    text: 'Every listing reviewed before going live',
  },
  {
    icon: (
      <svg className="w-7 h-7 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
    title: 'Buyer Protection',
    text: 'Dispute resolution and full refunds if item not as described',
  },
];

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
    <div className="space-y-14">
      {/* Hero */}
      <section className="-mx-4 sm:-mx-6 lg:-mx-8 -mt-8 bg-gray-900 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-900 to-brand-900 opacity-90" />
        <div className="absolute inset-0 opacity-5" style={{
          backgroundImage: 'radial-gradient(circle at 20% 50%, #22c55e 0%, transparent 50%), radial-gradient(circle at 80% 20%, #16a34a 0%, transparent 40%)',
        }} />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
          <div className="inline-flex items-center gap-2 bg-green-100 border border-green-300 text-green-900 text-sm font-medium px-4 py-1.5 rounded-full mb-6">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            USA&apos;s Cricket Equipment Marketplace
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white leading-tight mb-5">
            Buy & Sell Premium<br />
            <span className="text-brand-500">Cricket Equipment</span>
          </h1>
          <p className="text-gray-400 text-lg sm:text-xl max-w-2xl mx-auto mb-8">
            From cricket bats to helmets, find quality used gear from players across the USA, with secure buyer protection.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/listings"
              className="bg-brand-700 text-white font-bold px-8 py-3.5 rounded-lg hover:bg-brand-800 transition-colors text-base"
            >
              Browse All Gear
            </Link>
            <Link
              href="/register"
              className="bg-white/10 backdrop-blur text-white font-semibold px-8 py-3.5 rounded-lg border border-white/20 hover:bg-white/20 transition-colors text-base"
            >
              Start Selling
            </Link>
          </div>
        </div>
      </section>

      {/* Trust badges */}
      <section>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {TRUST_BADGES.map((b) => (
            <div key={b.title} className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4">
              <div className="shrink-0 w-12 h-12 bg-brand-50 rounded-lg flex items-center justify-center">
                {b.icon}
              </div>
              <div>
                <p className="font-semibold text-gray-900">{b.title}</p>
                <p className="text-sm text-gray-500 mt-0.5">{b.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Shop by category */}
      <section>
        <div className="flex items-end justify-between mb-5">
          <div>
            <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Browse by</p>
            <h2 className="text-2xl font-bold text-gray-900">Shop by Category</h2>
          </div>
          <Link href="/listings" className="text-sm text-brand-700 font-medium hover:underline">
            View all &rarr;
          </Link>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.value}
              href={`/listings?category=${cat.value}`}
              className="group bg-white border border-gray-200 rounded-xl overflow-hidden hover:border-brand-500 hover:shadow-md transition-all duration-200"
            >
              <div className="relative bg-gray-50 h-36">
                <Image
                  src={cat.image}
                  alt={cat.alt}
                  fill
                  className="object-contain p-4"
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 17vw"
                />
              </div>
              <div className="px-3 pt-2.5 pb-3 text-center">
                <p className="text-sm font-semibold text-gray-900 group-hover:text-brand-700 transition-colors">
                  {cat.label}
                </p>
                <p className="text-xs text-gray-400 mt-0.5 hidden lg:block leading-tight">
                  {cat.description}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Featured Listings */}
      <section>
        <div className="flex items-end justify-between mb-5">
          <div>
            <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Just listed</p>
            <h2 className="text-2xl font-bold text-gray-900">Featured Listings</h2>
          </div>
          <Link href="/listings" className="text-sm text-brand-700 font-medium hover:underline">
            View all &rarr;
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
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
        ) : listings.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 px-8 py-7 text-center">
            <p className="text-lg font-bold text-gray-900 mb-1">Turn Your Cricket Gear Into Cash</p>
            <p className="text-sm text-gray-500 mb-5">List your bats, pads, helmets, gloves and more. Reach cricket players across the USA.</p>
            <Link
              href="/register"
              className="inline-flex items-center gap-2 bg-brand-700 text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-brand-800 transition-colors text-sm"
            >
              List Your Gear
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
          </div>
        )}
      </section>

      {/* How it works */}
      <section className="bg-white rounded-2xl border border-gray-200 px-6 py-10">
        <div className="text-center mb-8">
          <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Simple & safe</p>
          <h2 className="text-2xl font-bold text-gray-900">How Cricket Market Works</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          {[
            {
              step: '01',
              title: 'Find Your Gear',
              text: 'Browse hundreds of listings or search by category, condition, and price range.',
            },
            {
              step: '02',
              title: 'Pay Securely',
              text: 'Your payment is held securely — never released until you confirm the item arrived as described.',
            },
            {
              step: '03',
              title: 'Play Cricket',
              text: 'Receive your gear, confirm delivery, and funds are released to the seller. Simple.',
            },
          ].map((item) => (
            <div key={item.step} className="text-center">
              <div className="w-12 h-12 bg-brand-700 text-white rounded-xl text-lg font-extrabold flex items-center justify-center mx-auto mb-4">
                {item.step}
              </div>
              <h3 className="font-bold text-gray-900 text-lg mb-2">{item.title}</h3>
              <p className="text-gray-500 text-sm leading-relaxed">{item.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
