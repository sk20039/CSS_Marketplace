'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';

export default function Navbar() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState('');

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/listings?q=${encodeURIComponent(query)}`);
  }

  async function handleLogout() {
    await logout();
    router.push('/');
  }

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-4">
        <Link href="/" className="text-xl font-bold text-green-700 whitespace-nowrap">
          Cricket Market
        </Link>

        <form onSubmit={handleSearch} className="flex-1 max-w-xl">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search bats, helmets, pads..."
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </form>

        <div className="flex items-center gap-3 ml-auto text-sm">
          <Link href="/listings" className="text-gray-600 hover:text-green-700">Browse</Link>

          {user ? (
            <>
              {user.role === 'seller' && (
                <Link href="/listings/new" className="bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700">
                  + Sell
                </Link>
              )}
              <Link
                href={user.role === 'seller' ? '/dashboard/seller' : user.role === 'admin' ? '/admin' : '/dashboard/buyer'}
                className="text-gray-600 hover:text-green-700"
              >
                {user.name}
              </Link>
              <button onClick={handleLogout} className="text-gray-500 hover:text-red-600">
                Logout
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="text-gray-600 hover:text-green-700">Login</Link>
              <Link href="/register" className="bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700">
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
