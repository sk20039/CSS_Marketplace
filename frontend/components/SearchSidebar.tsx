'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';

const CATEGORIES = [
  { value: 'bat', label: 'Bat' },
  { value: 'helmet', label: 'Helmet' },
  { value: 'pads', label: 'Pads' },
  { value: 'gloves', label: 'Gloves' },
  { value: 'kit-bag', label: 'Kit Bag' },
  { value: 'other', label: 'Other' },
];

const CONDITIONS = [
  { value: '', label: 'Any condition' },
  { value: 'new', label: 'New' },
  { value: 'used_good', label: 'Used - Good' },
  { value: 'used_fair', label: 'Used - Fair' },
];

export default function SearchSidebar() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selectedCats, setSelectedCats] = useState<string[]>(
    searchParams.get('category') ? [searchParams.get('category')!] : []
  );
  const [condition, setCondition] = useState(searchParams.get('condition') || '');
  const [minPrice, setMinPrice] = useState(searchParams.get('min_price') || '');
  const [maxPrice, setMaxPrice] = useState(searchParams.get('max_price') || '');

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('category');
    params.delete('condition');
    params.delete('min_price');
    params.delete('max_price');
    params.delete('page');

    if (selectedCats.length === 1) params.set('category', selectedCats[0]);
    if (condition) params.set('condition', condition);
    if (minPrice) params.set('min_price', String(Math.round(parseFloat(minPrice) * 100)));
    if (maxPrice) params.set('max_price', String(Math.round(parseFloat(maxPrice) * 100)));

    router.push(`/listings?${params.toString()}`);
  }

  function reset() {
    setSelectedCats([]);
    setCondition('');
    setMinPrice('');
    setMaxPrice('');
    const params = new URLSearchParams();
    const q = searchParams.get('q');
    if (q) params.set('q', q);
    router.push(`/listings?${params.toString()}`);
  }

  function toggleCat(val: string) {
    setSelectedCats((prev) =>
      prev.includes(val) ? prev.filter((c) => c !== val) : [val]
    );
  }

  // sync when URL changes externally
  useEffect(() => {
    setSelectedCats(searchParams.get('category') ? [searchParams.get('category')!] : []);
    setCondition(searchParams.get('condition') || '');
  }, [searchParams]);

  return (
    <aside className="w-56 shrink-0 space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Category</p>
        <ul className="space-y-1">
          {CATEGORIES.map((c) => (
            <li key={c.value}>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={selectedCats.includes(c.value)}
                  onChange={() => toggleCat(c.value)}
                  className="rounded text-green-600 focus:ring-green-500"
                />
                {c.label}
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Condition</p>
        <div className="space-y-1">
          {CONDITIONS.map((c) => (
            <label key={c.value} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
              <input
                type="radio"
                name="condition"
                value={c.value}
                checked={condition === c.value}
                onChange={() => setCondition(c.value)}
                className="text-green-600 focus:ring-green-500"
              />
              {c.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Price (USD)</p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            placeholder="Min"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
          />
          <span className="text-gray-400">–</span>
          <input
            type="number"
            min="0"
            placeholder="Max"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </div>
      </div>

      <div className="space-y-2">
        <button
          onClick={apply}
          className="w-full bg-green-600 text-white text-sm py-2 rounded-lg hover:bg-green-700"
        >
          Apply Filters
        </button>
        <button
          onClick={reset}
          className="w-full border border-gray-300 text-gray-600 text-sm py-2 rounded-lg hover:bg-gray-50"
        >
          Reset
        </button>
      </div>
    </aside>
  );
}
