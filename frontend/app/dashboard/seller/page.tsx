'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { listingFetch, getOrders, connectSellerStripe, getSellerConnectStatus, syncUserToEscrow, authMe } from '@/lib/api';
import { useAuth } from '@/lib/auth';

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

type ConnectStatus = { connected: boolean; charges_enabled: boolean; details_submitted: boolean; stub?: boolean } | null;

function SellerContent() {
  const { user, accessToken } = useAuth();
  const searchParams = useSearchParams();
  const [listings, setListings] = useState<Listing[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Fetch connect status; on stripe_return also sync the new stripe_account_id to escrow
  useEffect(() => {
    if (!user) return;
    const isReturn = searchParams.get('stripe_return') === '1';
    getSellerConnectStatus().then(async (status) => {
      setConnectStatus(status);
      if (isReturn && status.stripe_account_id && accessToken) {
        const fullUser = await authMe(accessToken);
        if (fullUser) syncUserToEscrow({ ...fullUser, stripe_account_id: fullUser.stripe_account_id ?? undefined }).catch(() => {});
      }
    }).catch(() => {});
  }, [user, accessToken, searchParams]);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      listingFetch(`/listings/mine`).then((r) => r.json()).then((d) => {
        setListings(d.listings || []);
      }),
      getOrders({ seller_id: String(user.id) }).then(setOrders),
    ]).finally(() => setLoading(false));
  }, [user]);

  async function handleConnect() {
    setConnecting(true);
    setConnectError('');
    try {
      const data = await connectSellerStripe();
      if (data.stub) {
        setConnectError('Stripe is not configured on this server. Add STRIPE_SECRET_KEY to your escrow-service .env to enable real payouts.');
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      } else {
        setConnectError(data.error || 'Failed to start Stripe onboarding');
      }
    } catch {
      setConnectError('Network error');
    } finally {
      setConnecting(false);
    }
  }

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

      {/* Stripe Connect */}
      {connectStatus && (
        <div className={`rounded-xl border p-4 ${
          connectStatus.charges_enabled ? 'bg-green-50 border-green-200' :
          connectStatus.stub ? 'bg-gray-50 border-gray-200' :
          'bg-amber-50 border-amber-200'
        }`}>
          {connectStatus.charges_enabled ? (
            <div className="flex items-center gap-2 text-green-800">
              <span className="text-lg">✓</span>
              <div>
                <p className="font-semibold text-sm">Stripe Connected</p>
                <p className="text-xs text-green-700">You will receive payouts when orders are released.</p>
              </div>
            </div>
          ) : connectStatus.stub ? (
            <div className="text-gray-600 text-sm">
              <p className="font-semibold">Stripe not configured</p>
              <p className="text-xs mt-0.5">Running in stub mode — set <code className="bg-gray-100 px-1 rounded">STRIPE_SECRET_KEY</code> in <code className="bg-gray-100 px-1 rounded">escrow-service/.env</code> and <code className="bg-gray-100 px-1 rounded">auth-service/.env</code> to enable real payouts.</p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <div className="text-amber-800">
                <p className="font-semibold text-sm">
                  {connectStatus.details_submitted ? 'Stripe: Pending Approval' : 'Connect Stripe to receive payouts'}
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  {connectStatus.details_submitted
                    ? 'Stripe is reviewing your account. This usually takes 1–2 business days.'
                    : 'Complete onboarding to receive funds when buyers confirm receipt.'}
                </p>
              </div>
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="shrink-0 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
              >
                {connecting ? 'Redirecting…' : connectStatus.details_submitted ? 'Complete Onboarding' : 'Connect Stripe'}
              </button>
            </div>
          )}
          {connectError && <p className="text-red-600 text-xs mt-2">{connectError}</p>}
        </div>
      )}

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
