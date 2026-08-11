'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import OrderTimeline from '@/components/OrderTimeline';
import { getOrder, resolveDispute } from '@/lib/api';
import ErrorAlert from '@/components/ErrorAlert';

interface Order {
  id: number; status: string; amount_cents: number; listing_id: number;
  buyer_id: number; seller_id: number; dispute_reason_text?: string;
  dispute_category?: string; seller_payout_cents: number; platform_fee_cents: number;
  events: { id: number; event_type: string; payload_json: string | null; created_at: string }[];
}

const DISPUTE_CATEGORY_META: Record<string, { label: string; cls: string; desc: string }> = {
  valid:     { label: 'Valid',     cls: 'bg-red-100 text-red-700 border border-red-200',   desc: 'Likely a genuine buyer complaint' },
  invalid:   { label: 'Invalid',   cls: 'bg-gray-100 text-gray-600 border border-gray-200', desc: 'May be a frivolous claim' },
  ambiguous: { label: 'Ambiguous', cls: 'bg-amber-100 text-amber-700 border border-amber-200', desc: 'Requires careful review' },
};

export default function DisputeResolutionPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <DisputeContent />
    </AuthGuard>
  );
}

function DisputeContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<'release' | 'refund' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getOrder(id).then(setOrder).catch(() => setError('Order not found')).finally(() => setLoading(false));
  }, [id]);

  async function handle(action: 'release' | 'refund') {
    setResolving(action);
    setError('');
    try {
      const res = await resolveDispute(id, action);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Resolution failed'); return; }
      router.push('/admin');
    } catch {
      setError('Network error');
    } finally {
      setResolving(null);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="h-5 bg-gray-200 rounded w-28 animate-pulse" />
        <div className="h-8 bg-gray-200 rounded w-64 animate-pulse" />
        <div className="bg-white rounded-2xl border border-gray-200 h-32 animate-pulse" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-20 bg-gray-200 rounded-2xl animate-pulse" />
          <div className="h-20 bg-gray-200 rounded-2xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-24">
        <p className="text-gray-500 font-medium">{error || 'Order not found'}</p>
        <Link href="/admin" className="mt-3 inline-block text-brand-700 text-sm font-medium hover:underline">&larr; Back to admin</Link>
      </div>
    );
  }

  if (order.status !== 'DISPUTED') {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10">
          <svg className="w-12 h-12 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-gray-700 font-medium mb-1">Not in dispute</p>
          <p className="text-gray-500 text-sm mb-6">
            Order #{order.id} is currently <span className="font-semibold">{order.status}</span>.
          </p>
          <Link href="/admin" className="inline-flex items-center gap-2 bg-brand-700 text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-brand-800 transition-colors text-sm">
            &larr; Back to admin
          </Link>
        </div>
      </div>
    );
  }

  const dcm = order.dispute_category ? DISPUTE_CATEGORY_META[order.dispute_category] : null;

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      {/* Breadcrumb + header */}
      <div>
        <nav className="flex items-center gap-2 text-sm text-gray-400 mb-3">
          <Link href="/admin" className="hover:text-gray-700 transition-colors">Admin</Link>
          <span>/</span>
          <span className="text-gray-600 font-medium">Dispute — Order #{order.id}</span>
        </nav>
        <h1 className="text-2xl font-bold text-gray-900">Resolve Dispute</h1>
      </div>

      {/* Dispute reason */}
      <div className="bg-red-50 border border-red-200 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-red-200 flex items-center gap-3">
          <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-red-900">Buyer&apos;s Dispute Reason</p>
            {dcm && (
              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${dcm.cls}`}>
                Auto-tagged: {dcm.label}
              </span>
            )}
          </div>
        </div>
        <div className="px-6 py-4">
          <p className="text-sm text-red-800 leading-relaxed italic">
            &ldquo;{order.dispute_reason_text || '(no reason provided)'}&rdquo;
          </p>
          {dcm && (
            <p className="text-xs text-red-600 mt-2">{dcm.desc}</p>
          )}
        </div>
      </div>

      {/* Financial summary */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-700">Financial Summary</p>
        </div>
        <div className="px-6 py-4 space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Order total</span>
            <span className="font-medium">${(order.amount_cents / 100).toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Platform fee</span>
            <span className="font-medium">${(order.platform_fee_cents / 100).toFixed(2)}</span>
          </div>
          <div className="border-t border-gray-100 pt-3 space-y-2">
            <div className="flex justify-between">
              <span className="text-brand-700 font-medium">If you release → seller receives</span>
              <span className="font-bold text-brand-700">${(order.seller_payout_cents / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-blue-600 font-medium">If you refund → buyer receives</span>
              <span className="font-bold text-blue-600">${(order.amount_cents / 100).toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Resolution actions */}
      <ErrorAlert message={error} />

      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => handle('release')}
          disabled={!!resolving}
          className="bg-brand-700 text-white py-4 rounded-2xl font-semibold hover:bg-brand-800 disabled:opacity-50 transition-colors flex flex-col items-center gap-1"
        >
          <div className="flex items-center gap-2">
            {resolving === 'release' ? (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V7m0 1v8m0 0v1" />
              </svg>
            )}
            Release to Seller
          </div>
          <span className="text-xs font-normal opacity-75">Seller wins — funds released</span>
        </button>
        <button
          onClick={() => handle('refund')}
          disabled={!!resolving}
          className="bg-blue-600 text-white py-4 rounded-2xl font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors flex flex-col items-center gap-1"
        >
          <div className="flex items-center gap-2">
            {resolving === 'refund' ? (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
            )}
            Refund Buyer
          </div>
          <span className="text-xs font-normal opacity-75">Buyer wins — full refund</span>
        </button>
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-700">Order Timeline</p>
        </div>
        <div className="px-6 py-5">
          <OrderTimeline events={order.events || []} />
        </div>
      </div>
    </div>
  );
}
