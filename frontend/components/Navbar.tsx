'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
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
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // Scroll lock, focus-on-open, focus trap, Escape handler
  useEffect(() => {
    if (!mobileOpen) return;

    // 1. Scroll lock
    document.body.style.overflow = 'hidden';

    // 2. Move focus into the drawer (defer one frame so the DOM is painted)
    const raf = requestAnimationFrame(() => {
      const drawer = document.getElementById('mobile-nav');
      if (!drawer) return;
      const focusable = drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length > 0) focusable[0].focus();
    });

    // 3. Escape + focus trap (Tab / Shift+Tab)
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeMobileMenu();
        return;
      }
      if (e.key === 'Tab') {
        const drawer = document.getElementById('mobile-nav');
        if (!drawer) return;
        const focusable = Array.from(
          drawer.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [mobileOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  function closeMobileMenu() {
    setMobileOpen(false);
    hamburgerRef.current?.focus();
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/listings?q=${encodeURIComponent(query.trim())}`);
      closeMobileMenu();
    }
  }

  async function handleLogout() {
    await logout();
    closeMobileMenu();
    router.push('/');
  }

  return (
    <header className="sticky top-0 z-50 w-full">
      {/* Announcement bar */}
      <div className="bg-brand-800 text-white text-xs text-center py-2 px-4 font-medium tracking-wide">
        Secure payments on every order &mdash; buy with total confidence
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

          {/* Search — desktop only */}
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

            {/* Mobile hamburger button */}
            <button
              ref={hamburgerRef}
              className="sm:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1"
              onClick={() => (mobileOpen ? closeMobileMenu() : setMobileOpen(true))}
              aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
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

      {/* Category nav — desktop only */}
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

      {/* Mobile navigation drawer — full-screen overlay */}
      {mobileOpen && (
        <div className="sm:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 z-[60]"
            aria-hidden="true"
            onClick={closeMobileMenu}
          />

          {/* Drawer panel */}
          <nav
            id="mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="fixed inset-x-0 top-0 z-[70] bg-white shadow-2xl flex flex-col max-h-screen overflow-y-auto"
          >
            {/* Drawer header row */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-gray-200 sticky top-0 bg-white z-10">
              <Link
                href="/"
                onClick={closeMobileMenu}
                className="text-2xl font-extrabold text-gray-900 tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded"
              >
                Cricket<span className="text-brand-700">Market</span>
              </Link>
              <button
                onClick={closeMobileMenu}
                className="p-2 rounded-lg text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                aria-label="Close navigation menu"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Search */}
            <div className="px-4 py-4 border-b border-gray-100">
              <form onSubmit={handleSearch} className="flex gap-2">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search gear..."
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus:border-brand-600 transition-colors"
                />
                <button
                  type="submit"
                  className="bg-brand-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 transition-colors"
                >
                  Go
                </button>
              </form>
            </div>

            {/* Browse categories */}
            <div className="px-4 py-4 border-b border-gray-100">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2 px-3">Browse</p>
              <div className="space-y-0.5">
                <Link
                  href="/listings"
                  onClick={closeMobileMenu}
                  className="flex items-center px-3 py-3 text-sm font-semibold text-gray-900 rounded-lg hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  All Gear
                </Link>
                {CATEGORIES.map((cat) => (
                  <Link
                    key={cat.value}
                    href={`/listings?category=${cat.value}`}
                    onClick={closeMobileMenu}
                    className="flex items-center px-3 py-3 text-sm text-gray-700 rounded-lg hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    {cat.label}
                  </Link>
                ))}
              </div>
            </div>

            {/* Account */}
            <div className="px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2 px-3">Account</p>
              <div className="space-y-0.5">
                {user ? (
                  <>
                    <Link
                      href={user.role === 'seller' ? '/dashboard/seller' : user.role === 'admin' ? '/admin' : '/dashboard/buyer'}
                      onClick={closeMobileMenu}
                      className="flex items-center gap-2 px-3 py-3 text-sm font-medium text-gray-900 rounded-lg hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                      {user.name}
                    </Link>
                    {user.role === 'seller' && (
                      <Link
                        href="/listings/new"
                        onClick={closeMobileMenu}
                        className="flex items-center gap-2 px-3 py-3 text-sm font-semibold text-brand-700 rounded-lg hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                      >
                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        List Item for Sale
                      </Link>
                    )}
                    <button
                      onClick={handleLogout}
                      className="flex w-full items-center gap-2 px-3 py-3 text-sm text-red-600 rounded-lg hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                    >
                      Logout
                    </button>
                  </>
                ) : (
                  <>
                    <Link
                      href="/login"
                      onClick={closeMobileMenu}
                      className="flex items-center px-3 py-3 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Login
                    </Link>
                    <Link
                      href="/register"
                      onClick={closeMobileMenu}
                      className="flex items-center px-3 py-3 text-sm font-semibold text-brand-700 rounded-lg hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Create account
                    </Link>
                  </>
                )}
              </div>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
