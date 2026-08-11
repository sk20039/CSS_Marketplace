'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';

const CATEGORIES = [
  { value: 'bat',     label: 'Cricket Bats' },
  { value: 'helmet',  label: 'Helmets' },
  { value: 'pads',    label: 'Batting Pads' },
  { value: 'gloves',  label: 'Gloves' },
  { value: 'kit-bag', label: 'Kit Bags' },
  { value: 'other',   label: 'Accessories' },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) router.push(`/listings?q=${encodeURIComponent(query.trim())}`);
  }

  async function handleLogout() {
    await logout();
    router.push('/');
  }

  return (
    <header className="sticky top-0 z-50 w-full">
      {/* Announcement bar */}
      <div className="bg-brand-800 text-white text-xs text-center py-2 px-4 font-medium tracking-wide">
        Secure escrow on every order &mdash; buy with total confidence
      </div>

      {/* Main bar */}
      <div className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-4">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="text-2xl font-extrabold text-gray-900 tracking-tight">
              Cricket<span className="text-brand-700">Market</span>
            </span>
          </Link>

          {/* Search */}
          <form onSubmit={handleSearch} className="flex-1 max-w-2xl hidden sm:flex">
            <div className="relative w-full">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search bats, helmets, pads, gloves..."
                className="w-full border-2 border-gray-200 rounded-lg pl-4 pr-12 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
              />
              <button
                type="submit"
                className="absolute right-0 top-0 bottom-0 px-4 bg-brand-700 text-white rounded-r-lg hover:bg-brand-800 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
            </div>
          </form>

          {/* Right nav */}
          <div className="flex items-center gap-2 ml-auto">
            {user ? (
              <>
                {user.role === 'seller' && (
                  <Link
                    href="/listings/new"
                    className="hidden sm:inline-flex items-center gap-1.5 bg-brand-700 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-brand-800 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Sell
                  </Link>
                )}
                <Link
                  href={user.role === 'seller' ? '/dashboard/seller' : user.role === 'admin' ? '/admin' : '/dashboard/buyer'}
                  className="hidden sm:flex items-center gap-2 text-sm text-gray-700 hover:text-brand-700 font-medium px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {user.name}
                </Link>
                <button
                  onClick={handleLogout}
                  className="hidden sm:block text-sm text-gray-500 hover:text-red-600 px-3 py-2 rounded-lg hover:bg-red-50 transition-colors"
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden sm:block text-sm font-medium text-gray-700 hover:text-brand-700 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Login
                </Link>
                <Link
                  href="/register"
                  className="hidden sm:inline-flex bg-brand-700 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-brand-800 transition-colors"
                >
                  Register
                </Link>
              </>
            )}

            {/* Mobile menu button */}
            <button
              className="sm:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {mobileOpen
                  ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                }
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Category nav */}
      <div className="bg-gray-900 hidden sm:block">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-1">
            <Link
              href="/listings"
              className="text-gray-300 hover:text-white text-sm font-medium px-4 py-3 hover:bg-gray-800 transition-colors border-r border-gray-700"
            >
              All Gear
            </Link>
            {CATEGORIES.map((cat) => (
              <Link
                key={cat.value}
                href={`/listings?category=${cat.value}`}
                className="text-gray-300 hover:text-white text-sm font-medium px-4 py-3 hover:bg-gray-800 transition-colors whitespace-nowrap"
              >
                {cat.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile dropdown */}
      {mobileOpen && (
        <div className="sm:hidden bg-white border-b border-gray-200 shadow-lg">
          <div className="px-4 py-3">
            <form onSubmit={handleSearch} className="flex gap-2 mb-4">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search..."
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-600"
              />
              <button type="submit" className="bg-brand-700 text-white px-4 py-2 rounded-lg text-sm">
                Go
              </button>
            </form>
            <div className="space-y-1">
              {CATEGORIES.map((cat) => (
                <Link
                  key={cat.value}
                  href={`/listings?category=${cat.value}`}
                  className="block py-2 text-sm text-gray-700 hover:text-brand-700"
                  onClick={() => setMobileOpen(false)}
                >
                  {cat.label}
                </Link>
              ))}
              <div className="border-t border-gray-100 pt-3 mt-3 flex flex-col gap-2">
                {user ? (
                  <>
                    <Link href={user.role === 'seller' ? '/dashboard/seller' : '/dashboard/buyer'} className="text-sm text-gray-700 font-medium">
                      My Account ({user.name})
                    </Link>
                    {user.role === 'seller' && (
                      <Link href="/listings/new" className="text-sm text-brand-700 font-semibold">
                        + List Item for Sale
                      </Link>
                    )}
                    <button onClick={handleLogout} className="text-left text-sm text-red-600">
                      Logout
                    </button>
                  </>
                ) : (
                  <>
                    <Link href="/login" className="text-sm text-gray-700 font-medium">Login</Link>
                    <Link href="/register" className="text-sm text-brand-700 font-semibold">Register</Link>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
