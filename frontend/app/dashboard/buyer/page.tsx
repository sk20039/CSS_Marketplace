'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { getOrders } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { ORDER_STATUS_STYLE } from '@/lib/constants';

interface Order {
  id: number; status: string; amount_cents: number; listing_id: number; seller_id: number;
}

export default function BuyerDashboard() {
  return (
    <AuthGuard allowedRoles={['buyer', 'admin']}>
      <BuyerContent />
    </AuthGuard>
  );
}

function BuyerContent() {
  const user = useUser();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    getOrders({ buyer_id: String(user.id) })
      .then(setOrders)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  const activeOrders = orders.filter((o) => !['RELEASED', 'REFUNDED'].includes(o.status));
  const completedOrders = orders.filter((o) => ['RELEASED', 'REFUNDED'].includes(o.status));
  const totalSpent = completedOrders.filter((o) => o.status === 'RELEASED').reduce((s, o) => s + o.amount_cents, 0);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-gray-200 rounded w-48 animate-pulse" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 h-24 animate-pulse" />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 h-16 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">Dashboard</p>
          <h1 className="text-2xl font-bold text-gray-900">My Purchases</h1>
        </div>
        <Link
          href="/listings"
          className="inline-flex items-center gap-2 bg-brand-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-brand-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          Browse Gear
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Orders', value: orders.length,
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />,
          },
          {
            label: 'Active Orders', value: activeOrders.length,
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
          },
          {
            label: 'Completed', value: completedOrders.length,
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
          },
          {
            label: 'Total Spent', value: `$${(totalSpent / 100).toFixed(2)}`,
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
          },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{s.label}</p>
              <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {s.icon}
                </svg>
              </div>
            </div>
            <p className="text-2xl font-bold text-gray-900">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Active orders */}
      {activeOrders.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Active Orders</h2>
          <div className="space-y-2">
            {activeOrders.map((o) => <OrderRow key={o.id} order={o} />)}
          </div>
        </section>
      )}

      {/* All orders */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          {activeOrders.length > 0 ? 'Order History' : 'All Orders'}
        </h2>
        {orders.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
            <svg className="w-14 h-14 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
            </svg>
            <p className="text-gray-500 font-medium">No orders yet</p>
            <Link href="/listings" className="mt-3 inline-flex items-center gap-1 text-brand-700 text-sm font-medium hover:underline">
              Browse listings &rarr;
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => <OrderRow key={o.id} order={o} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function OrderRow({ order: o }: { order: Order }) {
  const s = ORDER_STATUS_STYLE[o.status] ?? { label: o.status, cls: 'bg-gray-100 text-gray-600' };
  return (
    <Link
      href={`/orders/${o.id}`}
      className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-5 py-4 hover:shadow-md hover:border-brand-200 transition-all group"
    >
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 group-hover:bg-brand-50 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">Order #{o.id}</p>
          <p className="text-xs text-gray-400">Listing #{o.listing_id}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-sm font-bold text-gray-900">${(o.amount_cents / 100).toFixed(2)}</p>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${s.cls}`}>{s.label}</span>
        <svg className="w-4 h-4 text-gray-300 group-hover:text-brand-600 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}
