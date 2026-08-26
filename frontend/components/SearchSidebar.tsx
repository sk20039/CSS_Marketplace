'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';

const CATEGORIES = [
  { value: 'bat',     label: 'Cricket Bats' },
  { value: 'helmet',  label: 'Helmets' },
  { value: 'pads',    label: 'Batting Pads' },
  { value: 'gloves',  label: 'Gloves' },
  { value: 'kit-bag', label: 'Kit Bags' },
  { value: 'other',   label: 'Accessories' },
];

const CONDITIONS = [
  { value: '',          label: 'Any condition' },
  { value: 'new',       label: 'New' },
  { value: 'used_good', label: 'Used — Good' },
  { value: 'used_fair', label: 'Used — Fair' },
];

export default function SearchSidebar() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selectedCat, setSelectedCat] = useState(searchParams.get('category') || '');
  const [condition, setCondition] = useState(searchParams.get('condition') || '');
  const [minPrice, setMinPrice] = useState(searchParams.get('min_price') ? String(Number(searchParams.get('min_price')) / 100) : '');
  const [maxPrice, setMaxPrice] = useState(searchParams.get('max_price') ? String(Number(searchParams.get('max_price')) / 100) : '');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setSelectedCat(searchParams.get('category') || '');
    setCondition(searchParams.get('condition') || '');
  }, [searchParams]);

  function apply(closeMobile = false) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('category');
    params.delete('condition');
    params.delete('min_price');
    params.delete('max_price');
    params.delete('page');

    if (selectedCat) params.set('category', selectedCat);
    if (condition) params.set('condition', condition);
    if (minPrice) params.set('min_price', String(Math.round(parseFloat(minPrice) * 100)));
    if (maxPrice) params.set('max_price', String(Math.round(parseFloat(maxPrice) * 100)));

    router.push(`/listings?${params.toString()}`);
    if (closeMobile) setMobileOpen(false);
  }

  function reset() {
    setSelectedCat('');
    setCondition('');
    setMinPrice('');
    setMaxPrice('');
    const params = new URLSearchParams();
    const q = searchParams.get('q');
    if (q) params.set('q', q);
    router.push(`/listings?${params.toString()}`);
    setMobileOpen(false);
  }

  const hasFilters = selectedCat || condition || minPrice || maxPrice;
  const activeFilterCount = [selectedCat, condition, minPrice, maxPrice].filter(Boolean).length;

  // Shared filter fields — rendered in both mobile and desktop panels
  const filterFields = (
    <div className="px-5 py-4 space-y-6">
      {/* Category */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Category</p>
        <ul className="space-y-1.5">
          <li>
            <button
              onClick={() => setSelectedCat('')}
              className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors ${
                selectedCat === ''
                  ? 'bg-brand-700 text-white font-medium'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              All Categories
            </button>
          </li>
          {CATEGORIES.map((c) => (
            <li key={c.value}>
              <button
                onClick={() => setSelectedCat(c.value)}
                className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors ${
                  selectedCat === c.value
                    ? 'bg-brand-700 text-white font-medium'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Condition */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Condition</p>
        <div className="space-y-1.5">
          {CONDITIONS.map((c) => (
            <button
              key={c.value}
              onClick={() => setCondition(c.value)}
              className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors ${
                condition === c.value
                  ? 'bg-brand-50 text-brand-800 font-medium border border-brand-200'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Price */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Price (USD)</p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            placeholder="Min"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 transition-colors"
          />
          <span className="text-gray-300 font-bold">–</span>
          <input
            type="number"
            min="0"
            placeholder="Max"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 transition-colors"
          />
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* ── Mobile: collapsible toggle + panel (hidden on md+) ── */}
      <div className="md:hidden mb-4">
        <button
          onClick={() => setMobileOpen((o) => !o)}
          aria-expanded={mobileOpen}
          aria-controls="mobile-filters"
          className="flex items-center gap-2 w-full border border-gray-200 bg-white rounded-xl px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 transition-colors"
        >
          <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          <span>Filters</span>
          {activeFilterCount > 0 && (
            <span className="ml-1 bg-brand-700 text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0">
              {activeFilterCount}
            </span>
          )}
          <svg
            className={`w-4 h-4 ml-auto text-gray-400 transition-transform duration-200 ${mobileOpen ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {mobileOpen && (
          <div id="mobile-filters" className="mt-2 bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <p className="font-semibold text-gray-900 text-sm">Filters</p>
              {hasFilters && (
                <button onClick={reset} className="text-xs text-brand-700 font-medium hover:underline">
                  Clear all
                </button>
              )}
            </div>
            {filterFields}
            <div className="px-5 pb-5">
              <button
                onClick={() => apply(true)}
                className="w-full bg-brand-700 text-white text-sm font-semibold py-2.5 rounded-lg hover:bg-brand-800 transition-colors"
              >
                Apply Filters
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Desktop: fixed sidebar (hidden on mobile) ── */}
      <aside className="hidden md:block w-60 shrink-0">
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden sticky top-36">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <p className="font-semibold text-gray-900 text-sm">Filters</p>
            {hasFilters && (
              <button onClick={reset} className="text-xs text-brand-700 font-medium hover:underline">
                Clear all
              </button>
            )}
          </div>
          {filterFields}
          <div className="px-5 pb-5">
            <button
              onClick={() => apply()}
              className="w-full bg-brand-700 text-white text-sm font-semibold py-2.5 rounded-lg hover:bg-brand-800 transition-colors"
            >
              Apply Filters
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
