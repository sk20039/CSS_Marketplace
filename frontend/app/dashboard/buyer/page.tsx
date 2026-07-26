'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { getOrders } from '@/lib/api';
import { useUser } from '@/lib/auth';

interface Order {
  id: number; status: string; amount_cents: number; listing_id: number; seller_id: number;
}

const STATUS_COLOR: Record<string, string> = {
  HELD: 'bg-blue-100 text-blue-700', SHIPPED: 'bg-yellow-100 text-yellow-700',
  DELIVERED: 'bg-orange-100 text-orange-700', DISPUTED: 'bg-red-100 text-red-700',
  RELEASED: 'bg-green-100 text-green-700', REFUNDED: 'bg-gray-100 text-gray-600',
  CREATED: 'bg-purple-100 text-purple-700',
};

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

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;

  const activeOrders = orders.filter((o) => !['RELEASED', 'REFUNDED'].includes(o.status));
  const completedOrders = orders.filter((o) => ['RELEASED', 'REFUNDED'].includes(o.status));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">My Purchases</h1>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {[
          { label: 'Total Orders', value: orders.length },
          { label: 'Active', value: activeOrders.length },
          { label: 'Completed', value: completedOrders.length },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <p className="text-2xl font-bold text-green-700">{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <p className="text-gray-400">No orders yet.</p>
          <Link href="/listings" className="text-green-600 hover:underline text-sm mt-2 block">Browse listings →</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <Link key={o.id} href={`/orders/${o.id}`}
              className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-4 py-3 hover:shadow-sm transition-shadow">
              <div>
                <span className="text-sm font-medium text-gray-800">Order #{o.id}</span>
                <span className="text-xs text-gray-400 ml-2">Listing #{o.listing_id}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-green-700">${(o.amount_cents / 100).toFixed(2)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLOR[o.status] || 'bg-gray-100 text-gray-600'}`}>
                  {o.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
