'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import { createListing, uploadPhoto, syncListingToEscrow, auditListing, applySeoSuggestions, patchListing } from '@/lib/api';
import ErrorAlert from '@/components/ErrorAlert';
import { useUser } from '@/lib/auth';
import type { SeoAuditResult, SeoFields } from '@/lib/types';

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

function scoreBadgeClasses(tier: string) {
  if (tier === 'Excellent') return 'bg-green-100 text-green-800 border-green-300';
  if (tier === 'Good') return 'bg-blue-100 text-blue-800 border-blue-300';
  if (tier === 'Good start') return 'bg-amber-100 text-amber-800 border-amber-300';
  return 'bg-red-100 text-red-800 border-red-300';
}

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

  // SEO panel state
  const [createdListingId, setCreatedListingId] = useState<number | null>(null);
  const [seoAudit, setSeoAudit] = useState<SeoAuditResult | null>(null);
  const [seoLoading, setSeoLoading] = useState(false);
  const [seoApplied, setSeoApplied] = useState(false);
  const [editedSuggestions, setEditedSuggestions] = useState<SeoFields>({});

  // Sync editedSuggestions when audit result arrives
  useEffect(() => {
    if (seoAudit) {
      setEditedSuggestions({
        title: seoAudit.suggestions.title,
        meta_title: seoAudit.suggestions.meta_title,
        meta_description: seoAudit.suggestions.meta_description,
        tags: [...seoAudit.suggestions.tags],
      });
    }
  }, [seoAudit]);

  async function createAndUpload(): Promise<number | null> {
    const price = parseFloat(priceStr);
    if (isNaN(price) || price < 10) { setError('Minimum listing price is $10.00'); return null; }
    const price_cents = Math.round(price * 100);

    if (createdListingId !== null) {
      // Already created and photos already uploaded — skip to avoid duplicates
      return createdListingId;
    }

    const res = await createListing({ title, description, price_cents, category, condition });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Failed to create listing'); return null; }
    const id: number = data.id;
    setCreatedListingId(id);

    for (const file of photos.slice(0, 5)) {
      await uploadPhoto(id, file);
    }
    return id;
  }

  async function handleGetSuggestions() {
    setError('');
    setSeoLoading(true);
    try {
      const id = await createAndUpload();
      if (id === null) return;
      const audit = await auditListing(id);
      setSeoAudit(audit);
    } catch (e: any) {
      setError(e?.message || 'Failed to get SEO suggestions');
    } finally {
      setSeoLoading(false);
    }
  }

  async function handleApplySuggestions() {
    if (createdListingId === null) return;
    try {
      await applySeoSuggestions(createdListingId, editedSuggestions);
      setSeoApplied(true);
    } catch (e: any) {
      setError(e?.message || 'Failed to apply suggestions');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      let id = createdListingId;
      if (id === null) {
        // Normal flow: create then upload
        const newId = await createAndUpload();
        if (newId === null) return;
        id = newId;
      } else {
        // Listing was already created via "Get SEO Suggestions" — patch with latest title/description
        await patchListing(id, { title, description });
      }
      // Sync to escrow and redirect
      await syncListingToEscrow({
        id,
        seller_id: user!.id,
        title,
        price_cents: Math.round(parseFloat(priceStr) * 100),
      });
      router.push(`/listings/${id}`);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    return () => {
      previews.forEach((url) => URL.revokeObjectURL(url));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previews]);

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).slice(0, 5);
    setPhotos(files);
    setPreviews((prev) => {
      prev.forEach((url) => URL.revokeObjectURL(url));
      return files.map((f) => URL.createObjectURL(f));
    });
  }

  function removeTag(tag: string) {
    setEditedSuggestions((prev) => ({
      ...prev,
      tags: (prev.tags || []).filter((t) => t !== tag),
    }));
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
        <ErrorAlert message={error} />

        {/* Basic Details */}
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

          {/* Get Suggestions button — only visible when title is non-empty */}
          {title.trim().length > 0 && (
            <div>
              <button
                type="button"
                onClick={handleGetSuggestions}
                disabled={seoLoading}
                className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 border border-brand-300 bg-brand-50 hover:bg-brand-100 px-4 py-2 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {seoLoading ? (
                  <>
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Analyzing…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    Get SEO Suggestions
                  </>
                )}
              </button>
              <p className="text-xs text-gray-400 mt-1">Saves a draft and scores your listing quality</p>
            </div>
          )}
        </div>

        {/* SEO Audit Panel */}
        {seoAudit && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Listing Quality</h2>
              <button
                type="button"
                onClick={() => { setSeoAudit(null); setSeoApplied(false); }}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Skip
              </button>
            </div>

            {/* Score badge */}
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center px-3 py-1.5 rounded-xl border text-sm font-bold ${scoreBadgeClasses(seoAudit.score_tier)}`}>
                {seoAudit.quality_score}/100
              </span>
              <span className="text-sm text-gray-600">{seoAudit.score_tier}</span>
              {seoAudit.claude_used && (
                <span className="text-xs text-purple-600 font-medium">AI-powered</span>
              )}
            </div>

            {/* Issues */}
            {seoAudit.issues.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">What to improve</p>
                <ul className="space-y-1">
                  {seoAudit.issues.map((issue, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                      <span className="text-amber-500 mt-0.5 shrink-0">
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                      </span>
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Editable suggestion fields */}
            <div className="space-y-4 pt-2 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Suggested improvements</p>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Suggested Title</label>
                <input
                  type="text"
                  value={editedSuggestions.title || ''}
                  onChange={(e) => setEditedSuggestions((p) => ({ ...p, title: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-brand-600 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  SEO Title <span className="text-gray-400 font-normal">(max 60 chars)</span>
                </label>
                <input
                  type="text"
                  maxLength={60}
                  value={editedSuggestions.meta_title || ''}
                  onChange={(e) => setEditedSuggestions((p) => ({ ...p, meta_title: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-brand-600 transition-colors"
                />
                <p className="text-xs text-gray-400 mt-0.5">{(editedSuggestions.meta_title || '').length}/60</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  SEO Description <span className="text-gray-400 font-normal">(max 155 chars)</span>
                </label>
                <textarea
                  rows={3}
                  maxLength={155}
                  value={editedSuggestions.meta_description || ''}
                  onChange={(e) => setEditedSuggestions((p) => ({ ...p, meta_description: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-brand-600 transition-colors resize-none"
                />
                <p className="text-xs text-gray-400 mt-0.5">{(editedSuggestions.meta_description || '').length}/155</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">Tags</label>
                <div className="flex flex-wrap gap-2">
                  {(editedSuggestions.tags || []).map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 text-xs px-2.5 py-1 rounded-full"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="text-gray-400 hover:text-gray-700 transition-colors ml-0.5"
                        aria-label={`Remove tag ${tag}`}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleApplySuggestions}
                  disabled={seoApplied}
                  className="inline-flex items-center gap-2 bg-brand-700 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {seoApplied ? (
                    <>
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      Applied
                    </>
                  ) : (
                    'Apply Suggestions'
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setSeoAudit(null); setSeoApplied(false); }}
                  className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}

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
            <span className="ml-2 text-xs font-normal text-gray-400">$10.00 minimum</span>
          </label>
          <div className="relative max-w-xs">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-medium">$</span>
            <input
              type="number"
              required
              min="10.00"
              step="0.01"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              placeholder="10.00"
              className="w-full border-2 border-gray-200 rounded-xl pl-8 pr-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>
          {(() => {
            const price = parseFloat(priceStr);
            if (!isNaN(price) && price > 0) {
              const priceCents = Math.round(price * 100);
              const rawFee = Math.round((priceCents * 800) / 10000);
              const feeCents = Math.min(Math.max(rawFee, 200), priceCents);
              const payoutCents = priceCents - feeCents;
              return (
                <p className="text-xs text-gray-400 mt-2">
                  Platform fee: <strong className="text-gray-600">${(feeCents / 100).toFixed(2)}</strong>
                  {' '}· You receive: <strong className="text-gray-600">${(payoutCents / 100).toFixed(2)}</strong>
                </p>
              );
            }
            return <p className="text-xs text-gray-400 mt-2">8% platform fee, $2.00 minimum — deducted from your payout at sale.</p>;
          })()}
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
              {createdListingId ? 'Publishing…' : 'Creating listing…'}
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
