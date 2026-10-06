'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { authOtpVerify, syncUserToEscrow } from '@/lib/api';

function CheckoutVerifyContent() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const listingId    = searchParams.get('listing');
  const email        = decodeURIComponent(searchParams.get('email') || '');
  const { login }    = useAuth();

  const [code,        setCode]        = useState('');
  const [error,       setError]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [syncError,   setSyncError]   = useState(false);
  const [syncRetrying,setSyncRetrying]= useState(false);
  // Stored after OTP consumed — needed for sync retry without re-verifying
  const [verified,    setVerified]    = useState<{ token: string; user: { id: number; name: string; email: string; role: string } } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res  = await authOtpVerify({ email, code });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Invalid or expired code. Please try again.');
        return;
      }

      // OTP consumed — session is valid. Store for sync retry if needed.
      setVerified({ token: data.access_token, user: data.user });

      // Log the user in immediately (session is valid regardless of sync)
      login(data.access_token, data.user);

      // Sync to escrow — if it fails we show a recoverable retry UI
      const syncRes = await syncUserToEscrow(data.user);
      if (!syncRes.ok) {
        setSyncError(true);
        return;
      }

      redirect(data.user);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSyncRetry() {
    if (!verified) return;
    setSyncRetrying(true);
    setSyncError(false);
    try {
      const syncRes = await syncUserToEscrow(verified.user);
      if (!syncRes.ok) {
        setSyncError(true);
      } else {
        redirect(verified.user);
      }
    } catch {
      setSyncError(true);
    } finally {
      setSyncRetrying(false);
    }
  }

  function redirect(user: { role: string }) {
    if (user.role === 'buyer' && listingId) {
      router.push(`/listings/${listingId}?buy=1`);
    } else if (user.role === 'buyer') {
      router.push('/listings');
    } else {
      router.push('/dashboard');
    }
  }

  if (!email) {
    return (
      <div className="text-center py-24">
        <p className="text-gray-500">Missing email address.</p>
        <Link href="/checkout/start" className="text-brand-700 hover:underline text-sm mt-2 inline-block">
          Start over
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-8 py-10">

          {syncError ? (
            <div className="text-center">
              <div className="w-12 h-12 bg-amber-50 rounded-xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-gray-900 mb-2">Almost there</h2>
              <p className="text-sm text-gray-500 mb-6">
                Your identity was verified but we hit a temporary issue setting up your account.
                Your session is active — tap Retry to continue.
              </p>
              <button
                onClick={handleSyncRetry}
                disabled={syncRetrying}
                className="w-full bg-brand-700 text-white font-semibold py-3 rounded-xl hover:bg-brand-800 transition-colors disabled:opacity-50"
              >
                {syncRetrying ? 'Retrying…' : 'Retry'}
              </button>
              <button
                onClick={() => setSyncError(false)}
                className="w-full mt-2 text-sm text-gray-500 hover:text-gray-700 py-2"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <div className="text-center mb-7">
                <div className="w-12 h-12 bg-brand-50 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h1 className="text-xl font-bold text-gray-900">Enter your code</h1>
                <p className="text-sm text-gray-500 mt-1.5">
                  We sent a 6-digit code to<br />
                  <span className="font-medium text-gray-700">{email}</span>
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="code" className="block text-sm font-medium text-gray-700 mb-1">
                    Verification code
                  </label>
                  <input
                    id="code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    className="w-full border border-gray-300 rounded-lg px-3.5 py-3 text-xl font-mono tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  />
                </div>

                {error && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || code.length !== 6}
                  className="w-full bg-brand-700 text-white font-semibold py-3 rounded-xl hover:bg-brand-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Verifying…' : 'Verify & continue'}
                </button>
              </form>

              <p className="text-center text-xs text-gray-400 mt-5">
                Didn&apos;t receive a code?{' '}
                <Link
                  href={listingId ? `/checkout/start?listing=${listingId}` : '/checkout/start'}
                  className="text-brand-700 hover:underline font-medium"
                >
                  Request a new one
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CheckoutVerifyPage() {
  return <Suspense><CheckoutVerifyContent /></Suspense>;
}
