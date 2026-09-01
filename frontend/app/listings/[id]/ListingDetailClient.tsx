'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getListing, createOrder, getUserReviews, type ShippingAddress } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { CONDITION_LABELS, CATEGORY_LABELS } from '@/lib/constants';
import ErrorAlert from '@/components/ErrorAlert';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
];

interface ShippingModalProps {
  onSubmit: (addr: ShippingAddress) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
  error: string;
}

function ShippingAddressModal({ onSubmit, onCancel, submitting, error }: ShippingModalProps) {
  const [form, setForm] = useState<ShippingAddress>({
    name: '', line1: '', line2: '', city: '', state: '', zip: '', phone: '',
  });

  function set(field: keyof ShippingAddress, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit(form);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-1">Ship-to Address</h2>
        <p className="text-sm text-gray-500 mb-5">Enter the address where you want this item delivered.</p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            required placeholder="Full name"
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600"
            value={form.name} onChange={(e) => set('name', e.target.value)}
          />
          <input
            required placeholder="Address line 1"
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600"
            value={form.line1} onChange={(e) => set('line1', e.target.value)}
          />
          <input
            placeholder="Address line 2 (optional)"
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600"
            value={form.line2 ?? ''} onChange={(e) => set('line2', e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              required placeholder="City"
              className="border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600"
              value={form.city} onChange={(e) => set('city', e.target.value)}
            />
            <select
              required
              className="border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 bg-white"
              value={form.state} onChange={(e) => set('state', e.target.value)}
            >
              <option value="">State</option>
              {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              required placeholder="ZIP code" pattern="\d{5}(-\d{4})?"
              className="border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600"
              value={form.zip} onChange={(e) => set('zip', e.target.value)}
            />
            <input
              placeholder="Phone (optional)"
              className="border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600"
              value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)}
            />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button
              type="button" onClick={onCancel}
              className="flex-1 border border-gray-200 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={submitting}
              className="flex-1 bg-brand-700 text-white py-2.5 rounded-xl font-bold text-sm hover:bg-brand-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Processing...' : 'Continue to Payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface Photo { id: number; filename: string; display_order: number; }
interface Listing {
  id: number; seller_id: number; title: string; description: string;
  price_cents: number; category: string; condition: string; status: string;
  photos: Photo[]; created_at: string;
}

function StarRating({ rating, count }: { rating: number; count: number }) {
  const full = Math.round(rating);
  return (
    <div className="flex items-center gap-2">
      <div className="flex">
        {Array.from({ length: 5 }).map((_, i) => (
          <svg key={i} className={`w-4 h-4 ${i < full ? 'text-amber-400' : 'text-gray-200'}`} fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        ))}
      </div>
      <span className="text-sm font-semibold text-gray-700">{rating.toFixed(1)}</span>
      <span className="text-sm text-gray-400">({count} {count === 1 ? 'review' : 'reviews'})</span>
    </div>
  );
}

interface ListingDetailClientProps {
  initialListing?: any;
}

export default function ListingDetailClient({ initialListing }: ListingDetailClientProps) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const user = useUser();
  const [listing, setListing] = useState<Listing | null>(initialListing ?? null);
  const [loading, setLoading] = useState(!initialListing);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState('');
  const [activePhoto, setActivePhoto] = useState(0);
  const [sellerRating, setSellerRating] = useState<{ average_rating: number | null; count: number } | null>(null);
  const [showAddressModal, setShowAddressModal] = useState(false);
  const [addrError, setAddrError] = useState('');

  useEffect(() => {
    if (initialListing) {
      // Seed seller rating for the server-provided listing
      getUserReviews(initialListing.seller_id)
        .then(({ average_rating, count }) => setSellerRating({ average_rating, count }));
      return;
    }
    // Client-side fallback for direct navigation without SSR data
    getListing(id)
      .then((l) => {
        setListing(l);
        getUserReviews(l.seller_id).then(({ average_rating, count }) => setSellerRating({ average_rating, count }));
      })
      .catch(() => setError('Listing not found'))
      .finally(() => setLoading(false));
  }, [id, initialListing]);

  function handleBuy() {
    if (!user) { router.push('/login'); return; }
    if (!listing) return;
    setAddrError('');
    setShowAddressModal(true);
  }

  async function handleAddressSubmit(addr: ShippingAddress) {
    if (!listing) return;
    setBuying(true);
    setAddrError('');
    setError('');
    try {
      const res = await createOrder({ listing_id: listing.id, shipping_address: addr });
      const data = await res.json();
      if (!res.ok) {
        setAddrError(data.error || 'Could not create order');
        return;
      }
      setShowAddressModal(false);
      router.push(`/checkout/${data.id}`);
    } catch {
      setAddrError('Network error');
    } finally {
      setBuying(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <div className="h-4 bg-gray-200 rounded w-32 mb-6 animate-pulse" />
        <div className="grid md:grid-cols-2 gap-8">
          <div className="aspect-square bg-gray-200 rounded-2xl animate-pulse" />
          <div className="space-y-4">
            <div className="h-8 bg-gray-200 rounded w-3/4 animate-pulse" />
            <div className="h-10 bg-gray-200 rounded w-1/3 animate-pulse" />
            <div className="h-4 bg-gray-200 rounded animate-pulse" />
            <div className="h-4 bg-gray-200 rounded w-4/5 animate-pulse" />
            <div className="h-12 bg-gray-200 rounded-xl animate-pulse mt-6" />
          </div>
        </div>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="text-center py-24">
        <svg className="w-16 h-16 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-gray-500 font-medium">{error || 'Listing not found'}</p>
        <Link href="/listings" className="mt-4 inline-block text-brand-700 font-medium hover:underline text-sm">
          &larr; Back to listings
        </Link>
      </div>
    );
  }

  const photos = listing.photos || [];
  const currentPhoto = photos[activePhoto];
  const imgUrl = currentPhoto ? `${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${currentPhoto.filename}` : null;
  const condition = CONDITION_LABELS[listing.condition] ?? { label: listing.condition, cls: 'bg-gray-500 text-white' };
  const isSeller = user?.id === listing.seller_id;

  return (
    <div className="max-w-5xl mx-auto">
      {showAddressModal && (
        <ShippingAddressModal
          onSubmit={handleAddressSubmit}
          onCancel={() => { setShowAddressModal(false); setAddrError(''); }}
          submitting={buying}
          error={addrError}
        />
      )}
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/" className="hover:text-gray-700 transition-colors">Home</Link>
        <span>/</span>
        <Link href="/listings" className="hover:text-gray-700 transition-colors">Listings</Link>
        <span>/</span>
        <Link href={`/listings?category=${listing.category}`} className="hover:text-gray-700 transition-colors">
          {CATEGORY_LABELS[listing.category] || listing.category}
        </Link>
        <span>/</span>
        <span className="text-gray-600 font-medium truncate max-w-xs">{listing.title}</span>
      </nav>

      <div className="grid md:grid-cols-2 gap-10">
        {/* Photo gallery */}
        <div className="space-y-3">
          <div className="aspect-square bg-gray-100 rounded-2xl overflow-hidden relative">
            {imgUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imgUrl} alt={listing.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-gray-300 gap-3">
                <svg className="w-16 h-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-sm">No photos</span>
              </div>
            )}
            {/* Condition badge */}
            <span className={`absolute top-3 left-3 text-xs font-semibold px-2.5 py-1 rounded-lg ${condition.cls}`}>
              {condition.label}
            </span>
          </div>

          {/* Thumbnails */}
          {photos.length > 1 && (
            <div className="flex gap-2">
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  onClick={() => setActivePhoto(i)}
                  className={`w-18 h-18 rounded-xl overflow-hidden border-2 transition-all ${
                    i === activePhoto ? 'border-brand-600 shadow-md' : 'border-transparent hover:border-gray-300'
                  }`}
                  style={{ width: '4.5rem', height: '4.5rem' }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${p.filename}`}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="space-y-5">
          {/* Category + condition tags */}
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/listings?category=${listing.category}`}
              className="text-xs font-medium bg-gray-100 text-gray-600 px-3 py-1 rounded-full hover:bg-gray-200 transition-colors"
            >
              {CATEGORY_LABELS[listing.category] || listing.category}
            </Link>
            <span className={`text-xs font-semibold px-3 py-1 rounded-full ${condition.cls}`}>
              {condition.label}
            </span>
            {listing.status === 'sold' && (
              <span className="text-xs font-semibold bg-gray-200 text-gray-600 px-3 py-1 rounded-full">Sold</span>
            )}
          </div>

          <h1 className="text-2xl font-bold text-gray-900 leading-snug">{listing.title}</h1>

          <div>
            <p className="text-4xl font-extrabold text-brand-700">${(listing.price_cents / 100).toFixed(2)}</p>
            <p className="text-xs text-gray-400 mt-1">Seller payout after 8% platform fee ($2.00 min) at release</p>
          </div>

          {/* Seller rating */}
          {sellerRating && sellerRating.count > 0 && sellerRating.average_rating != null && (
            <div className="flex items-center gap-2">
              <StarRating rating={sellerRating.average_rating} count={sellerRating.count} />
              <span className="text-xs text-gray-400">— Seller rating</span>
            </div>
          )}

          {/* Description */}
          {listing.description && (
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
              <p className="text-sm font-medium text-gray-700 mb-1">Description</p>
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{listing.description}</p>
            </div>
          )}

          <ErrorAlert message={error} />

          {/* CTA */}
          {listing.status === 'active' && !isSeller && (
            <>
              {user?.role === 'buyer' ? (
                <button
                  onClick={handleBuy}
                  disabled={buying}
                  className="w-full bg-brand-700 text-white py-3.5 rounded-xl font-bold text-lg hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  {buying ? (
                    <>
                      <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Processing...
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      Buy Now
                    </>
                  )}
                </button>
              ) : !user ? (
                <Link
                  href="/login"
                  className="w-full bg-brand-700 text-white py-3.5 rounded-xl font-bold text-lg hover:bg-brand-800 transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>
                  Sign in to Buy
                </Link>
              ) : null}
            </>
          )}

          {listing.status === 'active' && isSeller && (
            <div className="bg-gray-50 border border-gray-200 text-gray-500 text-sm text-center py-3 rounded-xl">
              This is your listing
            </div>
          )}

          {listing.status === 'sold' && (
            <div className="bg-gray-100 text-gray-500 text-center py-3 rounded-xl font-semibold">
              This item has been sold
            </div>
          )}

          {/* Trust badges */}
          {listing.status === 'active' && !isSeller && (
            <div className="border border-gray-100 rounded-xl p-4 space-y-3 bg-gray-50">
              {[
                { text: 'Payment held securely until you confirm delivery', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
                { text: 'Dispute protection — raise a claim if item not as described', icon: 'M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3' },
                { text: '8% platform fee, $2.00 minimum — transparent seller-side pricing', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
              ].map((b) => (
                <div key={b.text} className="flex items-start gap-3 text-xs text-gray-500">
                  <svg className="w-4 h-4 text-brand-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={b.icon} />
                  </svg>
                  {b.text}
                </div>
              ))}
            </div>
          )}

          {/* Listed date */}
          <p className="text-xs text-gray-400">
            Listed on {new Date(listing.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>
    </div>
  );
}
