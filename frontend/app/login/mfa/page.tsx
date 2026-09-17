'use client';

import { useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { authMfaVerify, authMfaVerifyRecovery, syncUserToEscrow } from '@/lib/api';
import { useAuth } from '@/lib/auth';

function MfaVerifyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { login } = useAuth();
  const token = searchParams.get('token') || '';

  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError('');
    setLoading(true);
    try {
      const res = useRecovery
        ? await authMfaVerifyRecovery({ mfa_token: token, recovery_code: code })
        : await authMfaVerify({ mfa_token: token, code });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Verification failed. Please try again.');
        return;
      }
      login(data.access_token, data.user);
      syncUserToEscrow(data.user).catch(() => {});
      router.push(
        data.user.role === 'seller'
          ? '/dashboard/seller'
          : data.user.role === 'admin'
          ? '/admin'
          : '/dashboard/buyer'
      );
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function toggleMode() {
    setUseRecovery(!useRecovery);
    setCode('');
    setError('');
  }

  if (!token) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center">
        <p className="text-gray-500 text-sm">
          Invalid or missing MFA token.{' '}
          <Link href="/login" className="text-brand-700 hover:underline">Return to sign in</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center -mt-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <span className="text-3xl font-extrabold text-gray-900 tracking-tight">
              Cricket<span className="text-brand-700">Market</span>
            </span>
          </Link>
          <h1 className="text-xl font-semibold text-gray-900 mt-3">Two-factor authentication</h1>
          <p className="text-sm text-gray-500 mt-1">
            {useRecovery
              ? 'Enter a recovery code to sign in'
              : 'Enter the 6-digit code from your authenticator app'}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5">
              <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {useRecovery ? 'Recovery code' : 'Authentication code'}
              </label>
              <input
                key={useRecovery ? 'recovery' : 'totp'}
                type="text"
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                maxLength={useRecovery ? 10 : 6}
                value={code}
                onChange={(e) => setCode(
                  useRecovery
                    ? e.target.value.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10)
                    : e.target.value.replace(/\D/g, '').slice(0, 6)
                )}
                className="w-full border-2 border-gray-200 rounded-lg px-4 py-3 text-center text-2xl tracking-[0.4em] font-mono focus:outline-none focus:border-brand-600 transition-colors"
                placeholder={useRecovery ? '··········' : '000000'}
              />
            </div>

            <button
              type="submit"
              disabled={loading || code.length < (useRecovery ? 8 : 6)}
              className="w-full bg-brand-700 text-white py-3 rounded-lg font-semibold hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>

          <div className="mt-5 pt-5 border-t border-gray-100 text-center">
            <button
              type="button"
              onClick={toggleMode}
              className="text-sm text-brand-700 hover:underline"
            >
              {useRecovery
                ? 'Use authenticator app instead'
                : "Can\u2019t access your authenticator? Use a recovery code"}
            </button>
          </div>
        </div>

        <p className="text-center text-sm text-gray-500 mt-5">
          <Link href="/login" className="text-brand-700 font-medium hover:underline">
            &#8592; Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function MfaVerifyPage() {
  return (
    <Suspense>
      <MfaVerifyContent />
    </Suspense>
  );
}
