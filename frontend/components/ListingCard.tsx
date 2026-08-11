import Link from 'next/link';

interface Photo {
  id: number;
  filename: string;
  display_order: number;
}

interface Listing {
  id: number;
  title: string;
  price_cents: number;
  category: string;
  condition: string;
  status: string;
  photos: Photo[];
}

const CONDITION_LABELS: Record<string, { label: string; color: string }> = {
  new:       { label: 'New',       color: 'bg-brand-700 text-white' },
  used_good: { label: 'Used – Good', color: 'bg-blue-600 text-white' },
  used_fair: { label: 'Used – Fair', color: 'bg-amber-500 text-white' },
};

const CATEGORY_LABELS: Record<string, string> = {
  bat:     'Bat',
  helmet:  'Helmet',
  pads:    'Pads',
  gloves:  'Gloves',
  'kit-bag': 'Kit Bag',
  other:   'Other',
};

export default function ListingCard({ listing }: { listing: Listing }) {
  const photo = listing.photos?.[0];
  const imgUrl = photo
    ? `${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${photo.filename}`
    : null;

  const condition = CONDITION_LABELS[listing.condition] ?? { label: listing.condition, color: 'bg-gray-600 text-white' };

  return (
    <Link
      href={`/listings/${listing.id}`}
      className="group block bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg hover:border-brand-300 transition-all duration-200"
    >
      {/* Image */}
      <div className="aspect-square bg-gray-100 overflow-hidden relative">
        {imgUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imgUrl}
            alt={listing.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-300">
            <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-xs text-gray-400">No photo</span>
          </div>
        )}

        {/* Condition badge */}
        <span className={`absolute top-2 left-2 text-xs font-semibold px-2 py-0.5 rounded-md ${condition.color}`}>
          {condition.label}
        </span>

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-gray-900/0 group-hover:bg-gray-900/10 transition-colors duration-200 flex items-end justify-center pb-3 opacity-0 group-hover:opacity-100">
          <span className="bg-white text-gray-900 text-xs font-semibold px-4 py-1.5 rounded-full shadow">
            View Listing
          </span>
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <p className="text-sm font-medium text-gray-900 line-clamp-2 leading-snug min-h-[2.5rem]">
          {listing.title}
        </p>
        <div className="flex items-center justify-between mt-2">
          <p className="text-lg font-bold text-brand-700">
            ${(listing.price_cents / 100).toFixed(2)}
          </p>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-medium">
            {CATEGORY_LABELS[listing.category] || listing.category}
          </span>
        </div>
      </div>
    </Link>
  );
}
