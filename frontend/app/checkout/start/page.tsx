'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { authOtpRequest } from '@/lib/api';
import TurnstileWidget from '@/components/TurnstileWidget';
import type { TurnstileInstance } from '@marsidev/react-turnstile';

function CheckoutStartContent() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const listingId    = searchParams.get('listing');
  const { user, initializing } = useAuth();

  const [email,    setEmail]    = useState('');
  const [name,     setName]     = useState('');
  const [tsToken,  setTsToken]  = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const tsRef = useRef<TurnstileInstance>(null);

  // Authenticated buyers go directly to the listing
  useEffect(() => {
    if (initializing) return;
    if (user?.role === 'buyer') {
      const dest = listingId ? `/listings/${listingId}?buy=1` : '/listings';
      router.replace(dest);
    }
  }, [user, initializing, listingId, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!tsToken) {
      setError('Please complete the security check.');
      return;
    }

    setLoading(true);
    try {
      const res = await authOtpRequest({ email, name, turnstile_token: tsToken });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not send verification code. Please try again.');
        tsRef.current?.reset();
        setTsToken('');
        return;
      }
      // Carry listing ID through to verify page
      const verifyUrl = listingId
        ? `/checkout/verify?listing=${listingId}&email=${encodeURIComponent(email)}`
        : `/checkout/verify?email=${encodeURIComponent(email)}`;
      router.push(verifyUrl);
    } catch {
      setError('Network error. Please try again.');
      tsRef.current?.reset();
      setTsToken('');
    } finally {
      setLoading(false);
    }
  }

  if (initializing) return null;

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-8 py-10">
          <div className="text-center mb-7">
            <div className="w-12 h-12 bg-brand-50 rounded-xl flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-gray-900">Check out with email</h1>
            <p className="text-sm text-gray-500 mt-1.5">
              We&apos;ll send a 6-digit code to verify your email address.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
            </div>

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Your name <span className="text-gray-400 font-normal">(first-time only)</span>
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
            </div>

            <div className="flex justify-center pt-1">
              <TurnstileWidget
                ref={tsRef}
                onSuccess={setTsToken}
                onExpire={() => setTsToken('')}
                onError={() => setTsToken('')}
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !tsToken}
              className="w-full bg-brand-700 text-white font-semibold py-3 rounded-xl hover:bg-brand-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Sending code…' : 'Send verification code'}
            </button>
          </form>

          <p className="text-center text-xs text-gray-400 mt-5">
            Already have an account?{' '}
            <Link href="/login" className="text-brand-700 hover:underline font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CheckoutStartPage() {
  return <Suspense><CheckoutStartContent /></Suspense>;
}
