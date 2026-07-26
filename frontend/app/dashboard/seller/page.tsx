'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { listingFetch, getOrders } from '@/lib/api';
import { useUser } from '@/lib/auth';

interface Listing {
  id: number; title: string; price_cents: number; status: string; category: string;
  photos: { id: number; filename: string; display_order: number }[];
}
interface Order {
  id: number; status: string; amount_cents: number; listing_id: number; buyer_id: number;
}

export default function SellerDashboard() {
  return (
    <AuthGuard allowedRoles={['seller', 'admin']}>
      <SellerContent />
    </AuthGuard>
  );
}

function SellerContent() {
  const user = useUser();
  const [listings, setListings] = useState<Listing[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      // /listings/mine (not the public /listings search, which only ever
      // returns status='active') so sold/inactive listings still show up
      // here with their real status instead of silently disappearing.
      listingFetch(`/listings/mine`).then((r) => r.json()).then((d) => {
        setListings(d.listings || []);
      }),
      getOrders({ seller_id: String(user.id) }).then(setOrders),
    ]).finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;

  const myListings = listings; // /listings/mine already scopes to the current seller, any status

  const activeOrders = orders.filter((o) => !['RELEASED', 'REFUNDED'].includes(o.status));
  const completedOrders = orders.filter((o) => ['RELEASED', 'REFUNDED'].includes(o.status));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Seller Dashboard</h1>
        <Link href="/listings/new" className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700">
          + New Listing
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Active Listings', value: myListings.filter((l) => l.status === 'active').length },
          { label: 'Total Listings', value: myListings.length },
          { label: 'Active Orders', value: activeOrders.length },
          { label: 'Completed Sales', value: completedOrders.length },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <p className="text-2xl font-bold text-green-700">{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Active Orders */}
      {activeOrders.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Active Orders</h2>
          <div className="space-y-2">
            {activeOrders.map((o) => (
              <Link key={o.id} href={`/orders/${o.id}`}
                className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-4 py-3 hover:shadow-sm transition-shadow">
                <span className="text-sm font-medium text-gray-800">Order #{o.id} — Listing #{o.listing_id}</span>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-green-700">${(o.amount_cents / 100).toFixed(2)}</span>
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{o.status}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* My Listings */}
      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-3">My Listings</h2>
        {myListings.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
            <p className="text-gray-400">No listings yet.</p>
            <Link href="/listings/new" className="text-green-600 hover:underline text-sm mt-2 block">Create your first listing →</Link>
          </div>
        ) : (
          <div className="space-y-2">
            {myListings.map((l) => (
              <Link key={l.id} href={`/listings/${l.id}`}
                className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-4 py-3 hover:shadow-sm transition-shadow">
                <span className="text-sm font-medium text-gray-800 truncate max-w-sm">{l.title}</span>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-green-700">${(l.price_cents / 100).toFixed(2)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    l.status === 'active' ? 'bg-green-100 text-green-700' :
                    l.status === 'sold' ? 'bg-gray-200 text-gray-600' : 'bg-yellow-100 text-yellow-700'
                  }`}>{l.status}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
