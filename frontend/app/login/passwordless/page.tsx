'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { authOtpRequest, authOtpVerify, syncUserToEscrow } from '@/lib/api';
import TurnstileWidget from '@/components/TurnstileWidget';
import type { TurnstileInstance } from '@marsidev/react-turnstile';

type Step = 'request' | 'verify';

function PasswordlessContent() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const redirect     = searchParams.get('redirect') || '/dashboard';
  const { user, initializing, login } = useAuth();

  const [step,    setStep]    = useState<Step>('request');
  const [email,   setEmail]   = useState('');
  const [code,    setCode]    = useState('');
  const [tsToken, setTsToken] = useState('');
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const tsRef = useRef<TurnstileInstance>(null);

  useEffect(() => {
    if (!initializing && user) router.replace(redirect);
  }, [user, initializing, redirect, router]);

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!tsToken) { setError('Please complete the security check.'); return; }
    setLoading(true);
    try {
      const res  = await authOtpRequest({ email, turnstile_token: tsToken });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not send code. Please try again.');
        tsRef.current?.reset();
        setTsToken('');
        return;
      }
      setStep('verify');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res  = await authOtpVerify({ email, code });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Invalid or expired code.');
        return;
      }
      login(data.access_token, data.user);
      // Sync best-effort — sign-in shouldn't fail due to escrow
      syncUserToEscrow(data.user).catch(() => {});
      router.replace(redirect);
    } catch {
      setError('Network error. Please try again.');
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
            <h1 className="text-xl font-bold text-gray-900">
              {step === 'request' ? 'Sign in with email' : 'Enter your code'}
            </h1>
            <p className="text-sm text-gray-500 mt-1.5">
              {step === 'request'
                ? 'No password needed — we\'ll email you a verification code.'
                : <>We sent a code to <span className="font-medium text-gray-700">{email}</span></>
              }
            </p>
          </div>

          {step === 'request' ? (
            <form onSubmit={handleRequest} className="space-y-4">
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
              <div className="flex justify-center pt-1">
                <TurnstileWidget
                  ref={tsRef}
                  onSuccess={setTsToken}
                  onExpire={() => setTsToken('')}
                  onError={() => setTsToken('')}
                />
              </div>
              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
              )}
              <button
                type="submit"
                disabled={loading || !tsToken}
                className="w-full bg-brand-700 text-white font-semibold py-3 rounded-xl hover:bg-brand-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending code…' : 'Send verification code'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-4">
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
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
              )}
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full bg-brand-700 text-white font-semibold py-3 rounded-xl hover:bg-brand-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setStep('request'); setCode(''); setError(''); }}
                className="w-full text-sm text-gray-500 hover:text-gray-700 py-1"
              >
                Use a different email
              </button>
            </form>
          )}

          <p className="text-center text-xs text-gray-400 mt-5">
            Have a password?{' '}
            <Link href="/login" className="text-brand-700 hover:underline font-medium">
              Sign in with password
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function PasswordlessSignInPage() {
  return <Suspense><PasswordlessContent /></Suspense>;
}
