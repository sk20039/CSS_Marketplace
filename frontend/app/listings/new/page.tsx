'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import { createListing, uploadPhoto, syncListingToEscrow } from '@/lib/api';
import { useUser } from '@/lib/auth';

const CATEGORIES = [
  { value: 'bat',     label: 'Cricket Bat' },
  { value: 'helmet',  label: 'Helmet' },
  { value: 'pads',    label: 'Batting Pads' },
  { value: 'gloves',  label: 'Gloves' },
  { value: 'kit-bag', label: 'Kit Bag' },
  { value: 'other',   label: 'Accessories / Other' },
];

const CONDITIONS = [
  { value: 'new',       label: 'New',         desc: 'Unused, in original packaging' },
  { value: 'used_good', label: 'Used – Good',  desc: 'Light use, minor wear only' },
  { value: 'used_fair', label: 'Used – Fair',  desc: 'Visible wear but fully functional' },
];

export default function NewListingPage() {
  return (
    <AuthGuard allowedRoles={['seller', 'admin']}>
      <NewListingForm />
    </AuthGuard>
  );
}

function NewListingForm() {
  const router = useRouter();
  const user = useUser();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [category, setCategory] = useState('bat');
  const [condition, setCondition] = useState('used_good');
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) { setError('Enter a valid price'); return; }
    const price_cents = Math.round(price * 100);
    setLoading(true);
    try {
      const res = await createListing({ title, description, price_cents, category, condition });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to create listing'); return; }
      for (const file of photos.slice(0, 5)) {
        await uploadPhoto(data.id, file);
      }
      await syncListingToEscrow({
        id: data.id, seller_id: user!.id, title: data.title, price_cents: data.price_cents,
      });
      router.push(`/listings/${data.id}`);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).slice(0, 5);
    setPhotos(files);
    setPreviews(files.map((f) => URL.createObjectURL(f)));
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Sell gear</p>
        <h1 className="text-2xl font-bold text-gray-900">List an Item</h1>
        <p className="text-gray-500 text-sm mt-1">Fill in the details below. Your listing goes live immediately.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </div>
        )}

        {/* Title */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-5">
          <h2 className="text-sm font-semibold text-gray-700 border-b border-gray-100 pb-3">Basic Details</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Gray-Nicolls Kaboom English Willow Bat – Grade 2"
              className="w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the condition, age, brand, size, any damage or repairs..."
              className="w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors resize-none"
            />
          </div>
        </div>

        {/* Category + Condition */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-5">
          <h2 className="text-sm font-semibold text-gray-700 border-b border-gray-100 pb-3">Category & Condition</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Category</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCategory(c.value)}
                  className={`text-sm font-medium px-3 py-2.5 rounded-xl border-2 text-left transition-all ${
                    category === c.value
                      ? 'border-brand-600 bg-brand-50 text-brand-800'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Condition</label>
            <div className="space-y-2">
              {CONDITIONS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCondition(c.value)}
                  className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${
                    condition === c.value
                      ? 'border-brand-600 bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${condition === c.value ? 'text-brand-800' : 'text-gray-700'}`}>
                      {c.label}
                    </span>
                    {condition === c.value && (
                      <svg className="w-4 h-4 text-brand-700" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">{c.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Price */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 border-b border-gray-100 pb-3 mb-5">Pricing</h2>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Price (USD) <span className="text-red-500">*</span>
          </label>
          <div className="relative max-w-xs">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-medium">$</span>
            <input
              type="number"
              required
              min="0.01"
              step="0.01"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              placeholder="0.00"
              className="w-full border-2 border-gray-200 rounded-xl pl-8 pr-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>
          <p className="text-xs text-gray-400 mt-2">A 3% platform fee applies at the time of sale.</p>
        </div>

        {/* Photos */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 border-b border-gray-100 pb-3 mb-5">Photos</h2>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Upload photos <span className="text-gray-400 font-normal">(up to 5 · JPEG, PNG, WebP · max 5 MB each)</span>
          </label>

          <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-brand-500 hover:bg-brand-50 transition-all">
            <svg className="w-8 h-8 text-gray-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-sm text-gray-400">Click to upload or drag and drop</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={handleFiles}
              className="hidden"
            />
          </label>

          {previews.length > 0 && (
            <div className="flex gap-3 mt-4 flex-wrap">
              {previews.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt={`preview ${i + 1}`}
                  className="w-20 h-20 object-cover rounded-xl border border-gray-200"
                />
              ))}
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-brand-700 text-white py-3.5 rounded-xl font-bold text-base hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Creating listing…
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Publish Listing
            </>
          )}
        </button>
      </form>
    </div>
  );
}
