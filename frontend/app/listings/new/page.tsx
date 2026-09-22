'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import {
  createListing, uploadPhoto, syncListingToEscrow, auditListing,
  applySeoSuggestions, patchListing, publishListing, deletePhoto, listingFetch,
} from '@/lib/api';
import ErrorAlert from '@/components/ErrorAlert';
import { useAuth } from '@/lib/auth';
import type { SeoAuditResult, SeoFields } from '@/lib/types';

function parseHasShipFrom(token: string | null): boolean {
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return !!payload.has_ship_from_address;
  } catch {
    return true;
  }
}

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

function toWeightOz(value: string, unit: 'lb' | 'oz' | 'kg'): number {
  const n = parseFloat(value);
  if (isNaN(n)) return NaN;
  if (unit === 'lb') return n * 16;
  if (unit === 'kg') return n * 35.27396195;
  return n;
}

export default function NewListingPage() {
  return (
    <AuthGuard allowedRoles={['seller', 'admin']}>
      <Suspense fallback={<div className="animate-pulse h-32 bg-gray-100 rounded-xl" />}>
        <NewListingForm />
      </Suspense>
    </AuthGuard>
  );
}

interface ExistingPhoto {
  id: number;
  filename: string;
  display_order: number;
}

function NewListingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, accessToken } = useAuth();
  const hasShipFrom = parseHasShipFrom(accessToken);

  // Edit-mode: ?edit=<draft-id> pre-loads an existing draft into the form.
  const rawEdit = searchParams.get('edit');
  const editId = rawEdit ? parseInt(rawEdit, 10) || null : null;

  // Core form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [category, setCategory] = useState('bat');
  const [condition, setCondition] = useState('used_good');
  const [weightValue, setWeightValue] = useState('');
  const [weightUnit, setWeightUnit] = useState<'lb' | 'oz' | 'kg'>('lb');
  const [pkgLength, setPkgLength] = useState('');
  const [pkgWidth, setPkgWidth] = useState('');
  const [pkgHeight, setPkgHeight] = useState('');

  // New photos selected in this session (File objects)
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);

  // Existing photos already uploaded to the draft (edit mode)
  const [existingPhotos, setExistingPhotos] = useState<ExistingPhoto[]>([]);
  // Per-photo inline delete error (keyed by photo id)
  const [photoDeleteErrors, setPhotoDeleteErrors] = useState<Record<number, string>>({});

  // Loading / error states
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);

  // Draft feedback
  const [draftSaved, setDraftSaved] = useState(false);

  // Escrow sync failure (single publish path)
  const [syncFailed, setSyncFailed] = useState(false);
  const [syncFailedData, setSyncFailedData] = useState<{ id: number; title: string; price_cents: number } | null>(null);
  const [syncingEscrow, setSyncingEscrow] = useState(false);

  // Tracks the DB listing id once created (either via SEO suggestions or Save Draft)
  const [createdListingId, setCreatedListingId] = useState<number | null>(null);

  // SEO panel state
  const [seoAudit, setSeoAudit] = useState<SeoAuditResult | null>(null);
  const [seoLoading, setSeoLoading] = useState(false);
  const [seoApplied, setSeoApplied] = useState(false);
  const [editedSuggestions, setEditedSuggestions] = useState<SeoFields>({});

  // --- Load draft data when entering edit mode ---
  useEffect(() => {
    if (!editId || editId <= 0) return;
    listingFetch('/listings/mine')
      .then((r) => r.json())
      .then((d: { listings?: any[] }) => {
        const listing = (d.listings ?? []).find((l: any) => Number(l.id) === editId);
        if (!listing) return;
        setTitle(listing.title ?? '');
        setDescription(listing.description ?? '');
        setPriceStr(listing.price_cents != null ? String(listing.price_cents / 100) : '');
        setCategory(listing.category ?? 'bat');
        setCondition(listing.condition ?? 'used_good');
        if (listing.weight_oz) {
          setWeightValue(String(listing.weight_oz));
          setWeightUnit('oz');
        }
        if (listing.pkg_length_in) setPkgLength(String(listing.pkg_length_in));
        if (listing.pkg_width_in)  setPkgWidth(String(listing.pkg_width_in));
        if (listing.pkg_height_in) setPkgHeight(String(listing.pkg_height_in));
        setExistingPhotos(listing.photos ?? []);
        setCreatedListingId(Number(listing.id));
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

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

  // Revoke object URLs on unmount / preview change
  useEffect(() => {
    return () => { previews.forEach((url) => URL.revokeObjectURL(url)); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previews]);

  // Remaining upload slots: 5 minus already-uploaded minus currently selected-but-not-yet-uploaded
  const remainingPhotoSlots = Math.max(0, 5 - existingPhotos.length - photos.length);

  // --- Helpers ---

  function buildPatchBody() {
    const body: Parameters<typeof patchListing>[1] = { title, description };
    if (priceStr) {
      const p = parseFloat(priceStr);
      if (!isNaN(p)) body.price_cents = Math.round(p * 100);
    }
    body.category = category;
    body.condition = condition;
    // Package dims: only patch all four together (backend constraint)
    if (weightValue && pkgLength && pkgWidth && pkgHeight) {
      const w = toWeightOz(weightValue, weightUnit);
      const l = parseFloat(pkgLength);
      const wi = parseFloat(pkgWidth);
      const h = parseFloat(pkgHeight);
      if (Number.isFinite(w) && w > 0 && Number.isFinite(l) && l > 0 &&
          Number.isFinite(wi) && wi > 0 && Number.isFinite(h) && h > 0) {
        body.weight_oz = w;
        body.pkg_length_in = l;
        body.pkg_width_in = wi;
        body.pkg_height_in = h;
      }
    }
    return body;
  }

  async function uploadNewPhotos(id: number): Promise<string[]> {
    const failedNames: string[] = [];
    const maxNew = Math.max(0, 5 - existingPhotos.length);
    for (const file of photos.slice(0, maxNew)) {
      const photoRes = await uploadPhoto(id, file);
      if (!photoRes.ok) failedNames.push(file.name);
    }
    return failedNames;
  }

  // --- Save as Draft ---
  async function handleSaveDraft(addAnother: boolean) {
    if (!title.trim()) { setError('Title is required to save a draft'); return; }
    if (priceStr) {
      const price = parseFloat(priceStr);
      if (isNaN(price) || price < 10) {
        setError('Minimum listing price is $10.00 (leave the price blank if not set yet)');
        return;
      }
    }
    setError('');
    setDraftSaved(false);
    setIsSavingDraft(true);
    try {
      let id = createdListingId;

      if (id === null) {
        // Create a new draft record
        const price_cents = priceStr ? Math.round(parseFloat(priceStr) * 100) : null;
        const weight_oz   = weightValue ? toWeightOz(weightValue, weightUnit) : null;
        const pkg_length_in = pkgLength ? parseFloat(pkgLength) : null;
        const pkg_width_in  = pkgWidth  ? parseFloat(pkgWidth)  : null;
        const pkg_height_in = pkgHeight ? parseFloat(pkgHeight) : null;

        const res = await createListing({
          title, description, price_cents, category, condition,
          weight_oz, pkg_length_in, pkg_width_in, pkg_height_in,
          save_as_draft: true,
        });
        const data = await res.json();
        if (!res.ok) { setError(data.error || 'Failed to save draft'); return; }
        id = data.id as number;
        setCreatedListingId(id);
      } else {
        // Patch the existing draft
        await patchListing(id, buildPatchBody());
      }

      // Upload any newly selected photos
      const failedNames = await uploadNewPhotos(id);
      if (failedNames.length > 0) {
        setError(
          `Draft saved, but ${failedNames.length} photo(s) failed to upload: ${failedNames.join(', ')}`
        );
        return;
      }

      if (addAnother) {
        // Reset entire form for the next item
        setTitle(''); setDescription(''); setPriceStr('');
        setCategory('bat'); setCondition('used_good');
        setWeightValue(''); setWeightUnit('lb');
        setPkgLength(''); setPkgWidth(''); setPkgHeight('');
        setPhotos([]); setPreviews([]); setExistingPhotos([]);
        setCreatedListingId(null);
        setSeoAudit(null); setSeoApplied(false);
        setDraftSaved(true);
        if (editId) router.push('/listings/new');
      } else {
        router.push('/dashboard/seller');
      }
    } catch {
      setError('Network error');
    } finally {
      setIsSavingDraft(false);
    }
  }

  // --- Delete an existing photo in edit mode ---
  async function handleDeleteExistingPhoto(photo: ExistingPhoto) {
    if (!editId) return;
    setPhotoDeleteErrors((prev) => { const n = { ...prev }; delete n[photo.id]; return n; });
    try {
      const res = await deletePhoto(editId, photo.id);
      if (res.ok) {
        setExistingPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      } else {
        setPhotoDeleteErrors((prev) => ({ ...prev, [photo.id]: 'Could not remove — please try again' }));
      }
    } catch {
      setPhotoDeleteErrors((prev) => ({ ...prev, [photo.id]: 'Network error — please try again' }));
    }
  }

  // --- Remove a newly selected (not yet uploaded) photo ---
  function handleRemoveNewPhoto(index: number) {
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  // --- Retry escrow sync (single publish path) ---
  async function handleRetrySync() {
    if (!syncFailedData || !user) return;
    setSyncingEscrow(true);
    try {
      const res = await syncListingToEscrow({
        id: syncFailedData.id,
        seller_id: user.id,
        title: syncFailedData.title,
        price_cents: syncFailedData.price_cents,
      });
      if (res.ok) {
        router.push(`/listings/${syncFailedData.id}`);
      }
    } catch {
      // Keep error visible; user can retry again
    } finally {
      setSyncingEscrow(false);
    }
  }

  // --- SEO helpers (unchanged) ---
  async function createListingRecord(): Promise<number | null> {
    if (createdListingId !== null) return createdListingId;
    const price = parseFloat(priceStr);
    if (isNaN(price) || price < 10) { setError('Minimum listing price is $10.00'); return null; }
    const price_cents = Math.round(price * 100);
    const res = await createListing({
      title, description, price_cents, category, condition,
      weight_oz: toWeightOz(weightValue, weightUnit),
      pkg_length_in: parseFloat(pkgLength),
      pkg_width_in: parseFloat(pkgWidth),
      pkg_height_in: parseFloat(pkgHeight),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Failed to create listing'); return null; }
    const id: number = data.id;
    setCreatedListingId(id);
    return id;
  }

  async function handleGetSuggestions() {
    setError('');
    setSeoLoading(true);
    try {
      const id = await createListingRecord();
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

  // --- Publish ---
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSyncFailed(false);
    setLoading(true);
    try {
      if (editId !== null && createdListingId !== null) {
        // Edit mode: patch all fields → upload new photos → publish → sync
        await patchListing(createdListingId, buildPatchBody());

        const failedNames = await uploadNewPhotos(createdListingId);
        if (failedNames.length > 0) {
          setError(
            `${failedNames.length} photo(s) failed to upload: ${failedNames.join(', ')}. ` +
            `The draft is saved. Remove failed photos and try again.`
          );
          return;
        }

        const pubResult = await publishListing(createdListingId);
        if (!pubResult.ok) {
          setError(
            `Cannot publish — missing or invalid: ${(pubResult.missing ?? []).join(', ')}`
          );
          return;
        }

        const publishedListing = pubResult.listing as any;
        const price_cents = publishedListing?.price_cents ?? Math.round(parseFloat(priceStr) * 100);

        try {
          const syncRes = await syncListingToEscrow({
            id: createdListingId,
            seller_id: user!.id,
            title,
            price_cents,
          });
          if (!syncRes.ok) throw new Error('sync failed');
          router.push(`/listings/${createdListingId}`);
        } catch {
          setSyncFailed(true);
          setSyncFailedData({ id: createdListingId, title, price_cents });
        }
        return;
      }

      // --- Normal path (new listing or SEO flow) ---
      let id = createdListingId;
      if (id === null) {
        const newId = await createListingRecord();
        if (newId === null) return;
        id = newId;
      } else {
        // Listing created via "Get SEO Suggestions" — patch latest title/description
        await patchListing(id, { title, description });
      }

      const failedNames: string[] = [];
      for (const file of photos.slice(0, 5)) {
        const photoRes = await uploadPhoto(id, file);
        if (!photoRes.ok) failedNames.push(file.name);
      }
      if (failedNames.length > 0) {
        setError(
          `${failedNames.length} photo${failedNames.length > 1 ? 's' : ''} failed to upload: ` +
          `${failedNames.join(', ')}. Remove the failed photo${failedNames.length > 1 ? 's' : ''} and publish again.`
        );
        return;
      }

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

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    // Cap by total slots available for new photos (existing already uploaded count against the 5 limit)
    const maxNew = Math.max(0, 5 - existingPhotos.length);
    const files = Array.from(e.target.files || []).slice(0, maxNew);
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

  const anyLoading = loading || isSavingDraft;

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Sell gear</p>
        <h1 className="text-2xl font-bold text-gray-900">
          {editId ? 'Edit Draft' : 'List an Item'}
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          {editId
            ? 'Make changes to your draft, then save or publish.'
            : 'Save as a draft to come back later, or publish immediately.'}
        </p>
      </div>

      {/* Ship-from address prerequisite banner */}
      {!hasShipFrom && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 flex items-start justify-between gap-4 mb-6">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 bg-amber-200 rounded-full flex items-center justify-center shrink-0 mt-0.5">
              <svg className="w-5 h-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-amber-900 text-sm">Ship-from Address Required to Publish</p>
              <p className="text-xs text-amber-700 mt-0.5">
                You can save drafts without an address, but you&apos;ll need to add one before publishing. Add it on your Seller Dashboard.
              </p>
            </div>
          </div>
          <Link
            href="/dashboard/seller"
            className="shrink-0 bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-amber-700 transition-colors"
          >
            Add Address
          </Link>
        </div>
      )}

      {/* Draft saved banner */}
      {draftSaved && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 mb-6 flex items-center gap-3">
          <svg className="w-5 h-5 text-green-600 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <p className="text-sm font-medium text-green-800">Draft saved! Add your next item below.</p>
        </div>
      )}

      {/* Escrow sync failure banner (single publish path) */}
      {syncFailed && syncFailedData && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-6">
          <p className="text-sm font-semibold text-amber-900 mb-1">
            Published, but marketplace synchronization failed.
          </p>
          <p className="text-xs text-amber-700 mb-3">
            Your listing is live but may not appear in search or accept orders until synced. This is usually temporary.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleRetrySync}
              disabled={syncingEscrow}
              className="inline-flex items-center gap-2 bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {syncingEscrow ? 'Retrying…' : 'Retry Sync'}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/listings/${syncFailedData.id}`)}
              className="text-sm text-amber-800 underline hover:no-underline"
            >
              View listing anyway
            </button>
          </div>
        </div>
      )}

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

          {/* Get Suggestions button — only visible when title is non-empty and not in edit mode */}
          {title.trim().length > 0 && !editId && (
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
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center px-3 py-1.5 rounded-xl border text-sm font-bold ${scoreBadgeClasses(seoAudit.score_tier)}`}>
                {seoAudit.quality_score}/100
              </span>
              <span className="text-sm text-gray-600">{seoAudit.score_tier}</span>
              {seoAudit.claude_used && (
                <span className="text-xs text-purple-600 font-medium">AI-powered</span>
              )}
            </div>
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
          <h2 className="text-sm font-semibold text-gray-700 border-b border-gray-100 pb-3">Category &amp; Condition</h2>
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
            Price (USD)
            {!editId && <span className="text-red-500"> *</span>}
            <span className="ml-2 text-xs font-normal text-gray-400">$10.00 minimum</span>
          </label>
          <div className="relative max-w-xs">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-medium">$</span>
            <input
              type="number"
              required={!editId}
              min="10.00"
              step="0.01"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              placeholder={editId ? 'Leave blank if not set' : '10.00'}
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

        {/* Package Details */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 border-b border-gray-100 pb-3">
              Package Details {!editId && <span className="text-red-500">*</span>}
            </h2>
            <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mb-1">
              <svg className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-xs text-amber-800">
                <span className="font-semibold">Shipping is free for buyers.</span> As the seller, you are responsible for all shipping costs. These dimensions are used when you purchase a shipping label after your item sells.
              </p>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Include the weight and dimensions of the item, box, and all packing materials.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Package weight {!editId && <span className="text-red-500">*</span>}
            </label>
            <div className="flex items-center gap-2 max-w-xs">
              <input
                type="number" required={!editId} min="0.01" step="0.01"
                value={weightValue} onChange={(e) => setWeightValue(e.target.value)}
                placeholder="e.g. 2.5"
                className="flex-1 border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
              />
              <select
                value={weightUnit}
                onChange={(e) => setWeightUnit(e.target.value as 'lb' | 'oz' | 'kg')}
                className="border-2 border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 focus:outline-none focus:border-brand-600 transition-colors bg-white"
              >
                <option value="lb">lb</option>
                <option value="oz">oz</option>
                <option value="kg">kg</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Dimensions {!editId && <span className="text-red-500">*</span>}
              <span className="ml-1 text-xs font-normal text-gray-400">(inches, outer box)</span>
            </label>
            <div className="grid grid-cols-3 gap-3 max-w-sm">
              {[
                { label: 'Length', val: pkgLength, set: setPkgLength },
                { label: 'Width',  val: pkgWidth,  set: setPkgWidth },
                { label: 'Height', val: pkgHeight, set: setPkgHeight },
              ].map(({ label, val, set }) => (
                <div key={label}>
                  <input
                    type="number" required={!editId} min="0.1" step="0.1"
                    value={val} onChange={(e) => set(e.target.value)}
                    placeholder={label}
                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
                  />
                  <p className="text-xs text-gray-400 mt-1 text-center">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Photos */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 border-b border-gray-100 pb-3 mb-5">Photos</h2>

          {/* Existing photos (edit mode only) */}
          {existingPhotos.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-gray-500 mb-2">Uploaded photos (click ✕ to remove)</p>
              <div className="flex gap-3 flex-wrap">
                {existingPhotos.map((photo, i) => (
                  <div key={photo.id} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${photo.filename}`}
                      alt={`Uploaded photo ${i + 1}`}
                      className="w-20 h-20 object-cover rounded-xl border border-gray-200"
                    />
                    <button
                      type="button"
                      onClick={() => handleDeleteExistingPhoto(photo)}
                      className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600 shadow-sm"
                      aria-label={`Remove photo ${i + 1}`}
                    >
                      &times;
                    </button>
                    {photoDeleteErrors[photo.id] && (
                      <p className="text-xs text-red-600 mt-1 w-20 text-center leading-tight">
                        {photoDeleteErrors[photo.id]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {remainingPhotoSlots > 0 ? (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {editId ? `Add photos` : 'Upload photos'}{' '}
                <span className="text-gray-400 font-normal">
                  ({remainingPhotoSlots} slot{remainingPhotoSlots !== 1 ? 's' : ''} remaining · JPEG, PNG, WebP · max 5 MB each)
                </span>
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
                    <div key={i} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt={`preview ${i + 1}`}
                        className="w-20 h-20 object-cover rounded-xl border border-gray-200"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveNewPhoto(i)}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600 shadow-sm"
                        aria-label={`Remove photo ${i + 1}`}
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400">Maximum of 5 photos reached. Remove an existing photo to add a new one.</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={() => handleSaveDraft(false)}
            disabled={anyLoading}
            className="flex-1 border-2 border-gray-200 text-gray-700 py-3 rounded-xl font-semibold text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {isSavingDraft ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Saving…
              </>
            ) : 'Save Draft'}
          </button>

          <button
            type="button"
            onClick={() => handleSaveDraft(true)}
            disabled={anyLoading}
            className="flex-1 border-2 border-brand-300 text-brand-700 bg-brand-50 py-3 rounded-xl font-semibold text-sm hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {isSavingDraft ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Saving…
              </>
            ) : 'Save & Add Another'}
          </button>

          <button
            type="submit"
            disabled={anyLoading}
            className="flex-1 bg-brand-700 text-white py-3 rounded-xl font-bold text-sm hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {editId ? 'Publishing…' : (createdListingId ? 'Publishing…' : 'Creating…')}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Publish Listing
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
