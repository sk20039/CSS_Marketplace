'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { getMfaStatus, disableMfa } from '@/lib/api';

export default function SecurityPage() {
  return (
    <AuthGuard allowedRoles={['buyer', 'seller', 'admin']}>
      <SecurityContent />
    </AuthGuard>
  );
}

function SecurityContent() {
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabling, setDisabling] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [showDisableForm, setShowDisableForm] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getMfaStatus()
      .then((data) => setMfaEnabled(data.mfa_enabled))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setDisabling(true);
    try {
      const res = await disableMfa({ code: disableCode });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to disable MFA');
        return;
      }
      setMfaEnabled(false);
      setShowDisableForm(false);
      setDisableCode('');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setDisabling(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8 py-8">
      <div>
        <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Settings</p>
        <h1 className="text-2xl font-bold text-gray-900">Account Security</h1>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
              mfaEnabled ? 'bg-brand-700' : 'bg-gray-100'
            }`}>
              <svg
                className={`w-5 h-5 ${mfaEnabled ? 'text-white' : 'text-gray-400'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-gray-900">Two-Factor Authentication (TOTP)</p>
              {loading ? (
                <p className="text-sm text-gray-400 mt-0.5">Loading&hellip;</p>
              ) : (
                <p className={`text-sm mt-0.5 ${mfaEnabled ? 'text-brand-700' : 'text-gray-500'}`}>
                  {mfaEnabled
                    ? 'Enabled \u2014 your account is protected with an authenticator app'
                    : 'Not enabled \u2014 add an authenticator app for stronger security'}
                </p>
              )}
            </div>
          </div>

          {!loading && (
            mfaEnabled ? (
              <button
                onClick={() => { setShowDisableForm(!showDisableForm); setError(''); setDisableCode(''); }}
                className="shrink-0 text-sm font-semibold px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
              >
                Disable
              </button>
            ) : (
              <Link
                href="/settings/security/enroll"
                className="shrink-0 bg-brand-700 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-brand-800 transition-colors"
              >
                Enable
              </Link>
            )
          )}
        </div>

        {showDisableForm && (
          <form onSubmit={handleDisable} className="mt-5 space-y-4 border-t border-gray-100 pt-5">
            <p className="text-sm text-gray-600">
              Enter the 6-digit code from your authenticator app to confirm disabling MFA.
            </p>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <input
              type="text"
              required
              autoFocus
              inputMode="numeric"
              maxLength={6}
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full border-2 border-gray-200 rounded-lg px-4 py-2.5 text-center text-xl tracking-widest font-mono focus:outline-none focus:border-brand-600 transition-colors"
              placeholder="000000"
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowDisableForm(false)}
                className="flex-1 border border-gray-200 text-gray-700 py-2 rounded-lg font-semibold text-sm hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={disabling || disableCode.length < 6}
                className="flex-1 bg-red-600 text-white py-2 rounded-lg font-semibold text-sm hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {disabling ? 'Disabling...' : 'Disable MFA'}
              </button>
            </div>
          </form>
        )}
      </div>

      <p className="text-sm text-gray-400">
        <Link href="/dashboard/buyer" className="hover:text-gray-600 hover:underline">&#8592; Back to dashboard</Link>
      </p>
    </div>
  );
}
