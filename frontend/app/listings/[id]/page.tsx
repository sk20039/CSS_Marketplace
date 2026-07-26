'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getListing, createOrder } from '@/lib/api';
import { useUser } from '@/lib/auth';

interface Photo { id: number; filename: string; display_order: number; }
interface Listing {
  id: number; seller_id: number; title: string; description: string;
  price_cents: number; category: string; condition: string; status: string;
  photos: Photo[]; created_at: string;
}

const CONDITION_LABELS: Record<string, string> = { new: 'New', used_good: 'Used – Good', used_fair: 'Used – Fair' };

export default function ListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const user = useUser();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState('');
  const [activePhoto, setActivePhoto] = useState(0);

  useEffect(() => {
    getListing(id)
      .then(setListing)
      .catch(() => setError('Listing not found'))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleBuy() {
    if (!user) { router.push('/login'); return; }
    if (!listing) return;
    setBuying(true);
    setError('');
    try {
      // The listing is synced to escrow by its seller at creation time (see
      // listings/new). We deliberately don't re-sync it here as the buyer -
      // escrow-service now rejects that (only the listing's owner may sync
      // it), which also closes off a price-tampering path a buyer could
      // otherwise use by syncing fabricated listing data right before buying.
      const res = await createOrder({ listing_id: listing.id });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not create order'); return; }
      router.push(`/checkout/${data.id}`);
    } catch {
      setError('Network error');
    } finally {
      setBuying(false);
    }
  }

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;
  if (!listing) return <div className="text-center py-20 text-red-500">{error || 'Not found'}</div>;

  const photos = listing.photos || [];
  const currentPhoto = photos[activePhoto];
  const imgUrl = currentPhoto ? `${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${currentPhoto.filename}` : null;

  return (
    <div className="max-w-5xl mx-auto">
      <Link href="/listings" className="text-sm text-green-600 hover:underline mb-4 block">← Back to listings</Link>
      <div className="grid md:grid-cols-2 gap-8">
        {/* Photos */}
        <div className="space-y-3">
          <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden">
            {imgUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imgUrl} alt={listing.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-8xl text-gray-300">🏏</div>
            )}
          </div>
          {photos.length > 1 && (
            <div className="flex gap-2">
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  onClick={() => setActivePhoto(i)}
                  className={`w-16 h-16 rounded-lg overflow-hidden border-2 ${i === activePhoto ? 'border-green-500' : 'border-transparent'}`}
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
        <div className="space-y-4">
          <h1 className="text-2xl font-bold text-gray-900">{listing.title}</h1>
          <p className="text-3xl font-bold text-green-700">${(listing.price_cents / 100).toFixed(2)}</p>
          <div className="flex gap-2">
            <span className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded-full capitalize">{listing.category}</span>
            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full">
              {CONDITION_LABELS[listing.condition] || listing.condition}
            </span>
          </div>

          {listing.description && (
            <p className="text-gray-600 text-sm leading-relaxed">{listing.description}</p>
          )}

          {error && <p className="text-red-600 text-sm bg-red-50 rounded p-2">{error}</p>}

          {listing.status === 'active' && (
            <>
              {user?.role === 'buyer' ? (
                <button
                  onClick={handleBuy}
                  disabled={buying}
                  className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold text-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {buying ? 'Processing...' : 'Buy Now'}
                </button>
              ) : !user ? (
                <Link href="/login" className="block text-center w-full bg-green-600 text-white py-3 rounded-xl font-semibold text-lg hover:bg-green-700">
                  Sign in to Buy
                </Link>
              ) : (
                <p className="text-gray-500 text-sm">This is your listing.</p>
              )}
            </>
          )}
          {listing.status === 'sold' && (
            <div className="bg-gray-100 text-gray-500 text-center py-3 rounded-xl font-medium">Sold</div>
          )}

          <p className="text-xs text-gray-400">Listed {new Date(listing.created_at).toLocaleDateString()}</p>
        </div>
      </div>
    </div>
  );
}
