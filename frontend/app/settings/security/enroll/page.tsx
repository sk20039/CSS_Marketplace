'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { authMfaEnrollStart, authMfaEnrollConfirm, syncUserToEscrow } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import QRCode from 'react-qr-code';

type Step = 'loading' | 'setup' | 'confirm' | 'done';

function EnrollContent({ enrollmentToken }: { enrollmentToken: string | null }) {
  const router = useRouter();
  const { login } = useAuth();
  const [step, setStep] = useState<Step>('loading');
  const [totpUri, setTotpUri] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    authMfaEnrollStart(enrollmentToken)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Failed to start MFA enrollment. Please try again.');
        } else {
          setTotpUri(data.totp_uri);
          setRecoveryCodes(data.recovery_codes);
        }
        setStep('setup');
      })
      .catch(() => {
        setError('Network error. Please try again.');
        setStep('setup');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authMfaEnrollConfirm({ code }, enrollmentToken);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Verification failed. Please check the code and try again.');
        return;
      }
      // Admin forced enrollment: full tokens returned → log in immediately.
      if (data.access_token) {
        login(data.access_token, data.user);
        syncUserToEscrow(data.user).catch(() => {});
        router.push('/admin');
        return;
      }
      setStep('done');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto py-8">
      <div className="text-center mb-8">
        <Link href="/" className="inline-block">
          <span className="text-3xl font-extrabold text-gray-900 tracking-tight">
            Cricket<span className="text-brand-700">Market</span>
          </span>
        </Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-3">
          {step === 'done' ? 'MFA enabled' : 'Set up two-factor authentication'}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {step === 'setup' && 'Scan the QR code with your authenticator app, then save your recovery codes'}
          {step === 'confirm' && 'Enter the 6-digit code from your authenticator app to confirm'}
          {step === 'done' && 'Your account is now protected with an authenticator app'}
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        {step === 'loading' && (
          <div className="text-center py-10 text-gray-400">Setting up&hellip;</div>
        )}

        {step === 'setup' && (
          <div className="space-y-6">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
                {error}
              </div>
            )}

            {totpUri && (
              <div className="flex flex-col items-center gap-3">
                <div className="p-4 bg-white border-2 border-gray-100 rounded-xl inline-block">
                  <QRCode value={totpUri} size={180} />
                </div>
                <p className="text-xs text-gray-500 text-center">
                  Scan with Google Authenticator, Authy, 1Password, or any TOTP app
                </p>
              </div>
            )}

            {recoveryCodes.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-gray-900 mb-1">Recovery codes</p>
                <p className="text-xs text-gray-500 mb-3">
                  Save these codes somewhere safe. Each code can be used once if you lose access to your authenticator.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {recoveryCodes.map((c) => (
                    <code
                      key={c}
                      className="bg-gray-50 border border-gray-200 rounded px-3 py-1.5 text-sm font-mono text-gray-700 text-center"
                    >
                      {c}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {totpUri && (
              <button
                onClick={() => { setStep('confirm'); setCode(''); setError(''); }}
                className="w-full bg-brand-700 text-white py-3 rounded-lg font-semibold hover:bg-brand-800 transition-colors"
              >
                I&apos;ve saved my recovery codes &rarr;
              </button>
            )}
          </div>
        )}

        {step === 'confirm' && (
          <form onSubmit={handleConfirm} className="space-y-5">
            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Authenticator code
              </label>
              <input
                type="text"
                required
                autoFocus
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full border-2 border-gray-200 rounded-lg px-4 py-3 text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:border-brand-600 transition-colors"
                placeholder="000000"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setStep('setup'); setError(''); }}
                className="flex-1 border border-gray-200 text-gray-700 py-2.5 rounded-lg font-semibold text-sm hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading || code.length < 6}
                className="flex-1 bg-brand-700 text-white py-2.5 rounded-lg font-semibold hover:bg-brand-800 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Enabling...' : 'Enable MFA'}
              </button>
            </div>
          </form>
        )}

        {step === 'done' && (
          <div className="text-center space-y-4 py-4">
            <div className="w-16 h-16 bg-brand-50 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-8 h-8 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <p className="text-sm text-gray-600">
              Two-factor authentication is now active on your account.
            </p>
            <Link
              href="/settings/security"
              className="inline-flex items-center text-sm text-brand-700 font-medium hover:underline"
            >
              &#8592; Back to security settings
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function EnrollPageInner() {
  const searchParams = useSearchParams();
  const enrollmentToken = searchParams.get('token') || null;

  if (enrollmentToken) {
    // Token present = admin forced enrollment; no AuthGuard needed (token IS the auth).
    return <EnrollContent enrollmentToken={enrollmentToken} />;
  }

  return (
    <AuthGuard allowedRoles={['buyer', 'seller', 'admin']}>
      <EnrollContent enrollmentToken={null} />
    </AuthGuard>
  );
}

export default function EnrollPage() {
  return (
    <Suspense>
      <EnrollPageInner />
    </Suspense>
  );
}
