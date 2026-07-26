'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import { createListing, uploadPhoto, syncListingToEscrow } from '@/lib/api';
import { useUser } from '@/lib/auth';

const CATEGORIES = ['bat', 'helmet', 'pads', 'gloves', 'kit-bag', 'other'];
const CONDITIONS = [
  { value: 'new', label: 'New' },
  { value: 'used_good', label: 'Used – Good' },
  { value: 'used_fair', label: 'Used – Fair' },
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

      // Upload photos
      for (const file of photos.slice(0, 5)) {
        await uploadPhoto(data.id, file);
      }

      // Sync to escrow-service
      await syncListingToEscrow({
        id: data.id,
        seller_id: user!.id,
        title: data.title,
        price_cents: data.price_cents,
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
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">List an Item</h1>
      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        {error && <p className="text-red-600 text-sm bg-red-50 rounded p-2">{error}</p>}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Title <span className="text-red-500">*</span></label>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Gray-Nicolls Kaboom Bat – Grade 2"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe condition, age, size, brand details..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Condition</label>
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Price (USD) <span className="text-red-500">*</span></label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
            <input
              type="number"
              required
              min="0.01"
              step="0.01"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              placeholder="0.00"
              className="w-full border border-gray-300 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Photos (up to 5, JPEG/PNG/WebP, 5 MB each)</label>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={handleFiles}
            className="w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
          />
          {photos.length > 0 && (
            <p className="text-xs text-gray-500 mt-1">{photos.length} file(s) selected</p>
          )}
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-green-600 text-white py-2.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
        >
          {loading ? 'Creating listing...' : 'List Item'}
        </button>
      </form>
    </div>
  );
}
