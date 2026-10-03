'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import ErrorAlert from '@/components/ErrorAlert';
import { patchListing, uploadPhoto, deletePhoto, listingFetch } from '@/lib/api';

const CATEGORIES = [
  { value: 'bat',     label: 'Cricket Bat' },
  { value: 'helmet',  label: 'Helmet' },
  { value: 'pads',    label: 'Batting Pads' },
  { value: 'gloves',  label: 'Gloves' },
  { value: 'kit-bag', label: 'Kit Bag' },
  { value: 'other',   label: 'Accessories / Other' },
];

const CONDITIONS = [
  { value: 'new',       label: 'New',        desc: 'Unused, in original packaging' },
  { value: 'used_good', label: 'Used – Good', desc: 'Light use, minor wear only' },
  { value: 'used_fair', label: 'Used – Fair', desc: 'Visible wear but fully functional' },
];

function toWeightOz(value: string, unit: 'lb' | 'oz' | 'kg'): number {
  const n = parseFloat(value);
  if (isNaN(n)) return NaN;
  if (unit === 'lb') return n * 16;
  if (unit === 'kg') return n * 35.274;
  return n;
}

interface ExistingPhoto {
  id: number;
  filename: string;
  display_order: number;
}

interface ListingData {
  id: number;
  title: string;
  description: string;
  price_cents: number | null;
  category: string;
  condition: string;
  status: string;
  seller_id: number;
  weight_oz: number | null;
  pkg_length_in: number | null;
  pkg_width_in: number | null;
  pkg_height_in: number | null;
  photos: ExistingPhoto[];
}

export default function EditListingPage() {
  return (
    <AuthGuard allowedRoles={['seller', 'admin']}>
      <EditListingForm />
    </AuthGuard>
  );
}

function EditListingForm() {
  const params = useParams();
  const router = useRouter();
  const listingId = Number(params.id);

  // Loading state
  const [loadError, setLoadError] = useState('');
  const [loadingListing, setLoadingListing] = useState(true);

  // Form fields
  const [title, setTitle]             = useState('');
  const [description, setDescription] = useState('');
  const [priceStr, setPriceStr]       = useState('');
  const [category, setCategory]       = useState('bat');
  const [condition, setCondition]     = useState('used_good');
  const [weightValue, setWeightValue] = useState('');
  const [weightUnit, setWeightUnit]   = useState<'lb' | 'oz' | 'kg'>('lb');
  const [pkgLength, setPkgLength]     = useState('');
  const [pkgWidth, setPkgWidth]       = useState('');
  const [pkgHeight, setPkgHeight]     = useState('');
  const [listingStatus, setListingStatus] = useState('');

  // Photo state
  const [existingPhotos, setExistingPhotos] = useState<ExistingPhoto[]>([]);
  const [newPhotos, setNewPhotos]           = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews]   = useState<string[]>([]);
  const [photoDeleteErrors, setPhotoDeleteErrors] = useState<Record<number, string>>({});

  // Submit state
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  // Load listing from /listings/mine (confirms ownership, includes all statuses)
  useEffect(() => {
    if (!listingId) return;
    listingFetch('/listings/mine')
      .then((r) => r.json())
      .then((data: { listings?: ListingData[] }) => {
        const listing = (data.listings ?? []).find((l) => Number(l.id) === listingId);
        if (!listing) {
          setLoadError('Listing not found or you do not own it.');
          return;
        }
        if (listing.status === 'sold') {
          setLoadError('Sold listings cannot be edited.');
          return;
        }
        if (listing.status === 'draft') {
          setLoadError('Use the draft editor to edit this listing.');
          return;
        }
        // Pre-fill form
        setTitle(listing.title ?? '');
        setDescription(listing.description ?? '');
        setPriceStr(listing.price_cents != null ? String(listing.price_cents / 100) : '');
        setCategory(listing.category ?? 'bat');
        setCondition(listing.condition ?? 'used_good');
        setListingStatus(listing.status);
        if (listing.weight_oz) {
          const oz = Number(listing.weight_oz);
          if (oz >= 16) {
            setWeightValue(String((oz / 16).toFixed(2)).replace(/\.?0+$/, ''));
            setWeightUnit('lb');
          } else {
            setWeightValue(String(oz));
            setWeightUnit('oz');
          }
        }
        if (listing.pkg_length_in) setPkgLength(String(listing.pkg_length_in));
        if (listing.pkg_width_in)  setPkgWidth(String(listing.pkg_width_in));
        if (listing.pkg_height_in) setPkgHeight(String(listing.pkg_height_in));
        setExistingPhotos(listing.photos ?? []);
      })
      .catch(() => setLoadError('Failed to load listing. Please try again.'))
      .finally(() => setLoadingListing(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId]);

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => { photoPreviews.forEach(URL.revokeObjectURL); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoPreviews]);

  function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const slots = Math.max(0, 5 - existingPhotos.length - newPhotos.length);
    const accepted = files.slice(0, slots);
    setNewPhotos((p) => [...p, ...accepted]);
    setPhotoPreviews((p) => [...p, ...accepted.map((f) => URL.createObjectURL(f))]);
    e.target.value = '';
  }

  function removeNewPhoto(idx: number) {
    URL.revokeObjectURL(photoPreviews[idx]);
    setNewPhotos((p) => p.filter((_, i) => i !== idx));
    setPhotoPreviews((p) => p.filter((_, i) => i !== idx));
  }

  async function handleDeleteExistingPhoto(photo: ExistingPhoto) {
    setPhotoDeleteErrors((e) => { const n = { ...e }; delete n[photo.id]; return n; });
    const res = await deletePhoto(listingId, photo.id);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setPhotoDeleteErrors((e) => ({ ...e, [photo.id]: (data as any).error || 'Delete failed' }));
    } else {
      setExistingPhotos((p) => p.filter((ph) => ph.id !== photo.id));
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // Front-end validation
    if (!title.trim()) { setError('Title is required'); return; }
    const price = parseFloat(priceStr);
    if (!priceStr || isNaN(price) || price < 10) {
      setError('Price is required and must be at least $10.00');
      return;
    }

    // Package dims: all-or-nothing
    const hasSomeDim = !!(weightValue || pkgLength || pkgWidth || pkgHeight);
    const hasAllDims = !!(weightValue && pkgLength && pkgWidth && pkgHeight);
    if (hasSomeDim && !hasAllDims) {
      setError('Package dimensions must all be filled in together (weight, length, width, height)');
      return;
    }

    setSaving(true);
    try {
      const body: Parameters<typeof patchListing>[1] = {
        title: title.trim(),
        description,
        price_cents: Math.round(price * 100),
        category,
        condition,
      };
      if (hasAllDims) {
        const w  = toWeightOz(weightValue, weightUnit);
        const l  = parseFloat(pkgLength);
        const wi = parseFloat(pkgWidth);
        const h  = parseFloat(pkgHeight);
        if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(l) || l <= 0 ||
            !Number.isFinite(wi) || wi <= 0 || !Number.isFinite(h) || h <= 0) {
          setError('Package dimensions must be positive numbers');
          setSaving(false);
          return;
        }
        body.weight_oz     = w;
        body.pkg_length_in = l;
        body.pkg_width_in  = wi;
        body.pkg_height_in = h;
      }

      await patchListing(listingId, body);

      // Upload any new photos after a successful patch
      for (const file of newPhotos) {
        await uploadPhoto(listingId, file);
      }

      router.push('/dashboard/seller');
    } catch (err: any) {
      setError(err.message || 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  if (loadingListing) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 animate-pulse">
        <div className="h-8 bg-gray-200 rounded w-48" />
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 bg-gray-100 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto">
        <ErrorAlert message={loadError} />
        <Link href="/dashboard/seller" className="mt-4 inline-block text-sm text-brand-700 hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  const totalPhotos = existingPhotos.length + newPhotos.length;
  const remainingSlots = Math.max(0, 5 - totalPhotos);

  const statusLabel = listingStatus === 'active' ? 'Active' : 'Inactive';
  const statusCls   = listingStatus === 'active'
    ? 'bg-brand-100 text-brand-800'
    : 'bg-amber-100 text-amber-700';

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">My Listings</p>
          <h1 className="text-2xl font-bold text-gray-900">Edit Listing</h1>
        </div>
        <span className={`text-xs font-semibold px-3 py-1 rounded-full ${statusCls}`}>
          {statusLabel}
        </span>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Core fields */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-base font-semibold text-gray-900">Listing Details</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="e.g. GM Original English Willow Cricket Bat"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Condition details, brand, size, any extras included…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Price (USD) *</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input
                  type="number"
                  value={priceStr}
                  onChange={(e) => setPriceStr(e.target.value)}
                  min="10"
                  step="0.01"
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
                  required
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">Minimum $10.00</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Category *</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600 bg-white"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Condition *</label>
            <div className="grid grid-cols-3 gap-2">
              {CONDITIONS.map((c) => (
                <label
                  key={c.value}
                  className={`flex flex-col gap-0.5 border rounded-lg p-3 cursor-pointer transition-all ${
                    condition === c.value
                      ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="condition"
                    value={c.value}
                    checked={condition === c.value}
                    onChange={() => setCondition(c.value)}
                    className="sr-only"
                  />
                  <span className="text-sm font-semibold text-gray-900">{c.label}</span>
                  <span className="text-xs text-gray-500">{c.desc}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Package dimensions */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Package Dimensions</h2>
            <p className="text-sm text-gray-500 mt-0.5">Required for shipping label generation. All four fields must be filled together.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Weight *</label>
            <div className="flex gap-2">
              <input
                type="number"
                value={weightValue}
                onChange={(e) => setWeightValue(e.target.value)}
                min="0.01"
                step="0.01"
                placeholder="e.g. 3.5"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
              />
              <select
                value={weightUnit}
                onChange={(e) => setWeightUnit(e.target.value as 'lb' | 'oz' | 'kg')}
                className="w-20 border border-gray-200 rounded-lg px-2 py-2.5 text-sm focus:outline-none focus:border-brand-600 bg-white"
              >
                <option value="lb">lb</option>
                <option value="oz">oz</option>
                <option value="kg">kg</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Length (in)', value: pkgLength, setter: setPkgLength },
              { label: 'Width (in)',  value: pkgWidth,  setter: setPkgWidth  },
              { label: 'Height (in)', value: pkgHeight, setter: setPkgHeight },
            ].map(({ label, value, setter }) => (
              <div key={label}>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">{label} *</label>
                <input
                  type="number"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  min="0.1"
                  step="0.1"
                  placeholder="0.0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Photos */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Photos</h2>
            <p className="text-sm text-gray-500 mt-0.5">Up to 5 photos. Delete existing or add new ones.</p>
          </div>

          {/* Existing photos */}
          {existingPhotos.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              {existingPhotos.map((photo) => (
                <div key={photo.id} className="relative group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${photo.filename}`}
                    alt="Listing photo"
                    className="w-full aspect-square object-cover rounded-lg border border-gray-200"
                  />
                  <button
                    type="button"
                    onClick={() => handleDeleteExistingPhoto(photo)}
                    className="absolute -top-2 -right-2 w-6 h-6 bg-red-600 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700"
                    title="Delete photo"
                  >
                    ×
                  </button>
                  {photoDeleteErrors[photo.id] && (
                    <p className="text-xs text-red-600 mt-1 text-center">{photoDeleteErrors[photo.id]}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* New photo previews */}
          {newPhotos.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              {newPhotos.map((file, idx) => (
                <div key={idx} className="relative group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoPreviews[idx]}
                    alt={file.name}
                    className="w-full aspect-square object-cover rounded-lg border border-brand-300"
                  />
                  <button
                    type="button"
                    onClick={() => removeNewPhoto(idx)}
                    className="absolute -top-2 -right-2 w-6 h-6 bg-red-600 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700"
                    title="Remove photo"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Upload button */}
          {remainingSlots > 0 && (
            <label className="flex items-center gap-2 w-fit cursor-pointer border border-dashed border-gray-300 hover:border-brand-400 rounded-lg px-4 py-2.5 text-sm text-gray-600 hover:text-brand-700 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add photo{remainingSlots > 1 ? 's' : ''} ({remainingSlots} remaining)
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={handlePhotoSelect}
              />
            </label>
          )}
        </div>

        {/* Error + actions */}
        {error && <ErrorAlert message={error} />}

        <div className="flex gap-3">
          <Link
            href="/dashboard/seller"
            className="flex-1 text-center border border-gray-200 text-gray-700 py-3 rounded-lg font-semibold text-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 bg-brand-700 text-white py-3 rounded-lg font-bold text-sm hover:bg-brand-800 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
