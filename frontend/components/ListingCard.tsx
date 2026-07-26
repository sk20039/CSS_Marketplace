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

const CONDITION_LABELS: Record<string, string> = {
  new: 'New',
  used_good: 'Used - Good',
  used_fair: 'Used - Fair',
};

const CATEGORY_LABELS: Record<string, string> = {
  bat: 'Bat',
  helmet: 'Helmet',
  pads: 'Pads',
  gloves: 'Gloves',
  'kit-bag': 'Kit Bag',
  other: 'Other',
};

export default function ListingCard({ listing }: { listing: Listing }) {
  const photo = listing.photos?.[0];
  const imgUrl = photo
    ? `${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${photo.filename}`
    : null;

  return (
    <Link href={`/listings/${listing.id}`} className="group block bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
      <div className="aspect-square bg-gray-100 overflow-hidden">
        {imgUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imgUrl}
            alt={listing.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400 text-5xl">
            🏏
          </div>
        )}
      </div>
      <div className="p-3">
        <p className="text-sm font-medium text-gray-900 line-clamp-2 leading-snug">{listing.title}</p>
        <p className="text-lg font-bold text-green-700 mt-1">${(listing.price_cents / 100).toFixed(2)}</p>
        <div className="flex gap-1 mt-1.5 flex-wrap">
          <span className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full">
            {CATEGORY_LABELS[listing.category] || listing.category}
          </span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
            {CONDITION_LABELS[listing.condition] || listing.condition}
          </span>
        </div>
      </div>
    </Link>
  );
}
