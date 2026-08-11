'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { getOrders } from '@/lib/api';

interface Order {
  id: number; status: string; amount_cents: number;
  listing_id: number; buyer_id: number; seller_id: number;
  dispute_reason_text?: string; dispute_category?: string;
}

const STATUS_META: Record<string, { cls: string; label: string }> = {
  DISPUTED:  { cls: 'bg-red-100 text-red-700',    label: 'Disputed' },
  HELD:      { cls: 'bg-blue-100 text-blue-700',   label: 'Held' },
  SHIPPED:   { cls: 'bg-amber-100 text-amber-700', label: 'Shipped' },
  DELIVERED: { cls: 'bg-orange-100 text-orange-700', label: 'Delivered' },
  RELEASED:  { cls: 'bg-brand-100 text-brand-800', label: 'Released' },
  REFUNDED:  { cls: 'bg-gray-100 text-gray-600',   label: 'Refunded' },
  CANCELLED: { cls: 'bg-gray-100 text-gray-500',   label: 'Cancelled' },
};

const DISPUTE_CATEGORY_META: Record<string, { cls: string }> = {
  valid:     { cls: 'bg-red-50 border border-red-200 text-red-700' },
  invalid:   { cls: 'bg-gray-50 border border-gray-200 text-gray-500' },
  ambiguous: { cls: 'bg-amber-50 border border-amber-200 text-amber-700' },
};

const FILTER_OPTIONS = ['DISPUTED', 'ALL', 'HELD', 'SHIPPED', 'DELIVERED', 'RELEASED', 'REFUNDED'];

export default function AdminPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <AdminContent />
    </AuthGuard>
  );
}

function AdminContent() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('DISPUTED');

  useEffect(() => {
    getOrders({}).then(setOrders).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const disputed = orders.filter((o) => o.status === 'DISPUTED');
  const filtered = filter === 'ALL' ? orders : orders.filter((o) => o.status === filter);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-gray-200 rounded w-48 animate-pulse" />
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-8 bg-gray-200 rounded-full w-24 animate-pulse" />)}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-white rounded-xl border border-gray-200 h-20 animate-pulse" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Admin</p>
          <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
        </div>
        {disputed.length > 0 && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-xl text-sm font-semibold">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            {disputed.length} dispute{disputed.length !== 1 ? 's' : ''} need resolution
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Orders', value: orders.length },
          { label: 'Disputes',     value: disputed.length, alert: disputed.length > 0 },
          { label: 'Released',     value: orders.filter((o) => o.status === 'RELEASED').length },
          { label: 'Refunded',     value: orders.filter((o) => o.status === 'REFUNDED').length },
        ].map((s) => (
          <div key={s.label} className={`bg-white rounded-xl border p-4 ${s.alert ? 'border-red-200' : 'border-gray-200'}`}>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{s.label}</p>
            <p className={`text-2xl font-bold ${s.alert ? 'text-red-600' : 'text-gray-900'}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_OPTIONS.map((s) => {
          const count = s === 'ALL' ? orders.length : orders.filter((o) => o.status === s).length;
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${
                filter === s
                  ? s === 'DISPUTED'
                    ? 'bg-red-600 text-white'
                    : 'bg-brand-700 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()} ({count})
            </button>
          );
        })}
      </div>

      {/* Order list */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <svg className="w-12 h-12 text-gray-200 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <p className="text-gray-400 font-medium">No orders in this status</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((o) => {
            const sm = STATUS_META[o.status] ?? { cls: 'bg-gray-100 text-gray-600', label: o.status };
            const dcm = o.dispute_category ? DISPUTE_CATEGORY_META[o.dispute_category] : null;
            return (
              <div key={o.id} className="bg-white rounded-xl border border-gray-200 px-5 py-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">Order #{o.id}</span>
                      <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${sm.cls}`}>{sm.label}</span>
                      {o.dispute_category && dcm && (
                        <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${dcm.cls}`}>
                          {o.dispute_category}
                        </span>
                      )}
                    </div>
                    {o.dispute_reason_text && (
                      <p className="text-xs text-gray-500 italic truncate max-w-lg">&ldquo;{o.dispute_reason_text}&rdquo;</p>
                    )}
                    <p className="text-xs text-gray-400">
                      Listing #{o.listing_id} &middot; Buyer #{o.buyer_id} &middot; Seller #{o.seller_id} &middot; <span className="font-medium text-gray-600">${(o.amount_cents / 100).toFixed(2)}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      href={`/orders/${o.id}`}
                      className="text-xs text-brand-700 font-medium hover:underline px-3 py-1.5 rounded-lg hover:bg-brand-50 transition-colors"
                    >
                      View
                    </Link>
                    {o.status === 'DISPUTED' && (
                      <Link
                        href={`/admin/disputes/${o.id}`}
                        className="inline-flex items-center gap-1.5 bg-red-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-red-700 transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                        </svg>
                        Resolve
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
