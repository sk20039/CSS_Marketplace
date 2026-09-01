'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authLogin, syncUserToEscrow, authResendVerification } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resendSent, setResendSent] = useState(false);

  async function handleResend() {
    if (!unverifiedEmail) return;
    setResendSent(false);
    try {
      await authResendVerification({ email: unverifiedEmail });
      setResendSent(true);
    } catch {
      // ignore — the backend always returns 200 for this endpoint
      setResendSent(true);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setUnverifiedEmail('');
    setResendSent(false);
    setLoading(true);
    try {
      const res = await authLogin({ email, password });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 403) {
          setUnverifiedEmail(email);
        }
        setError(data.error || 'Login failed');
        return;
      }
      login(data.access_token, data.user);
      syncUserToEscrow(data.user).catch(() => {});
      router.push(data.user.role === 'seller' ? '/dashboard/seller' : data.user.role === 'admin' ? '/admin' : '/dashboard/buyer');
    } catch {
      setError('Network error. Is the auth service running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center -mt-8">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <span className="text-3xl font-extrabold text-gray-900 tracking-tight">
              Cricket<span className="text-brand-700">Market</span>
            </span>
          </Link>
          <h1 className="text-xl font-semibold text-gray-900 mt-3">Welcome back</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to your account to continue</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          {error && (
            <div className={`text-sm rounded-lg px-4 py-3 mb-5 ${unverifiedEmail ? 'bg-amber-50 border border-amber-200 text-amber-800' : 'flex items-center gap-2 bg-red-50 border border-red-200 text-red-700'}`}>
              {!unverifiedEmail && (
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              )}
              <div>
                <p>{error}</p>
                {unverifiedEmail && (
                  <div className="mt-2">
                    {resendSent ? (
                      <p className="text-sm font-medium text-amber-700">Verification email sent — check your inbox.</p>
                    ) : (
                      <button
                        type="button"
                        onClick={handleResend}
                        className="text-sm font-medium underline hover:no-underline"
                      >
                        Resend verification email
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Email address
              </label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border-2 border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-gray-700">
                  Password
                </label>
                <Link href="/forgot-password" className="text-xs text-brand-700 hover:underline">
                  Forgot password?
                </Link>
              </div>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border-2 border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-brand-700 text-white py-3 rounded-lg font-semibold hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Signing in...
                </span>
              ) : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-5">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-brand-700 font-medium hover:underline">
            Create one free
          </Link>
        </p>

        {/* Trust note */}
        <div className="flex items-center justify-center gap-1.5 mt-6 text-xs text-gray-400">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          Secured with buyer-protected payments
        </div>
      </div>
    </div>
  );
}
