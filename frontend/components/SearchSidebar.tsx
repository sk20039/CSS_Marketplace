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

  useEffect(() => {
    setSelectedCat(searchParams.get('category') || '');
    setCondition(searchParams.get('condition') || '');
  }, [searchParams]);

  function apply() {
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
  }

  const hasFilters = selectedCat || condition || minPrice || maxPrice;

  return (
    <aside className="w-60 shrink-0">
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden sticky top-36">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <p className="font-semibold text-gray-900 text-sm">Filters</p>
          {hasFilters && (
            <button onClick={reset} className="text-xs text-brand-700 font-medium hover:underline">
              Clear all
            </button>
          )}
        </div>

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

        {/* Apply */}
        <div className="px-5 pb-5">
          <button
            onClick={apply}
            className="w-full bg-brand-700 text-white text-sm font-semibold py-2.5 rounded-lg hover:bg-brand-800 transition-colors"
          >
            Apply Filters
          </button>
        </div>
      </div>
    </aside>
  );
}
