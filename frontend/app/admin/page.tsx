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

const STATUS_COLOR: Record<string, string> = {
  DISPUTED: 'bg-red-100 text-red-700', HELD: 'bg-blue-100 text-blue-700',
  SHIPPED: 'bg-yellow-100 text-yellow-700', DELIVERED: 'bg-orange-100 text-orange-700',
  RELEASED: 'bg-green-100 text-green-700', REFUNDED: 'bg-gray-100 text-gray-600',
};

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

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;

  const disputed = orders.filter((o) => o.status === 'DISPUTED');
  const filtered = filter === 'ALL' ? orders : orders.filter((o) => o.status === filter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
        <div className="text-sm text-red-600 font-medium">
          {disputed.length} dispute{disputed.length !== 1 ? 's' : ''} pending
        </div>
      </div>

      {/* Status filter */}
      <div className="flex gap-2 flex-wrap">
        {['DISPUTED', 'ALL', 'HELD', 'SHIPPED', 'DELIVERED', 'RELEASED', 'REFUNDED'].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
              filter === s ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s === 'ALL' ? `All (${orders.length})` : `${s} (${orders.filter((o) => o.status === s).length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <p className="text-gray-400">No orders in this status.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((o) => (
            <div key={o.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800">Order #{o.id}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLOR[o.status] || 'bg-gray-100 text-gray-600'}`}>
                      {o.status}
                    </span>
                    {o.dispute_category && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        o.dispute_category === 'valid' ? 'bg-red-50 text-red-600' :
                        o.dispute_category === 'invalid' ? 'bg-gray-50 text-gray-500' : 'bg-yellow-50 text-yellow-600'
                      }`}>
                        {o.dispute_category}
                      </span>
                    )}
                  </div>
                  {o.dispute_reason_text && (
                    <p className="text-xs text-gray-500 italic">"{o.dispute_reason_text}"</p>
                  )}
                  <p className="text-xs text-gray-400">
                    Listing #{o.listing_id} · Buyer #{o.buyer_id} · Seller #{o.seller_id} · ${(o.amount_cents / 100).toFixed(2)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link href={`/orders/${o.id}`} className="text-xs text-green-600 hover:underline">View</Link>
                  {o.status === 'DISPUTED' && (
                    <Link href={`/admin/disputes/${o.id}`}
                      className="bg-red-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-red-700">
                      Resolve
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
