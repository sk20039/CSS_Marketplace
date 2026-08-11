'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { listingFetch, getOrders, connectSellerStripe, getSellerConnectStatus, syncUserToEscrow, authMe } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ORDER_STATUS_STYLE } from '@/lib/constants';

interface Listing {
  id: number; title: string; price_cents: number; status: string; category: string;
  photos: { id: number; filename: string; display_order: number }[];
}
interface Order {
  id: number; status: string; amount_cents: number; listing_id: number; buyer_id: number;
}

type ConnectStatus = { connected: boolean; charges_enabled: boolean; details_submitted: boolean; stub?: boolean } | null;

export default function SellerDashboard() {
  return (
    <AuthGuard allowedRoles={['seller', 'admin']}>
      <SellerContent />
    </AuthGuard>
  );
}

function SellerContent() {
  const { user, accessToken } = useAuth();
  const searchParams = useSearchParams();
  const [listings, setListings] = useState<Listing[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

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
      listingFetch(`/listings/mine`).then((r) => r.json()).then((d) => setListings(d.listings || [])),
      getOrders({ seller_id: String(user.id) }).then(setOrders),
    ]).finally(() => setLoading(false));
  }, [user]);

  async function handleConnect() {
    setConnecting(true);
    setConnectError('');
    try {
      const data = await connectSellerStripe();
      if (data.stub) {
        setConnectError('Stripe is not configured. Add STRIPE_SECRET_KEY to escrow-service/.env to enable real payouts.');
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

  const activeOrders = orders.filter((o) => !['RELEASED', 'REFUNDED'].includes(o.status));
  const completedOrders = orders.filter((o) => ['RELEASED', 'REFUNDED'].includes(o.status));
  const totalEarned = completedOrders.filter((o) => o.status === 'RELEASED').reduce((s, o) => s + o.amount_cents, 0);
  const activeListings = listings.filter((l) => l.status === 'active');

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
          {Array.from({ length: 3 }).map((_, i) => (
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
          <h1 className="text-2xl font-bold text-gray-900">Seller Dashboard</h1>
        </div>
        <Link
          href="/listings/new"
          className="inline-flex items-center gap-2 bg-brand-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-brand-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Listing
        </Link>
      </div>

      {/* Stripe Connect banner */}
      {connectStatus && (
        <div className={`rounded-xl border p-5 ${
          connectStatus.charges_enabled
            ? 'bg-brand-50 border-brand-200'
            : connectStatus.stub
            ? 'bg-gray-50 border-gray-200'
            : 'bg-amber-50 border-amber-200'
        }`}>
          {connectStatus.charges_enabled ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-brand-700 rounded-full flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-brand-900 text-sm">Stripe Connected</p>
                <p className="text-xs text-brand-700 mt-0.5">You will receive payouts when orders are released.</p>
              </div>
            </div>
          ) : connectStatus.stub ? (
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-gray-200 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-gray-700 text-sm">Stripe not configured</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Running in stub mode. Set <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">STRIPE_SECRET_KEY</code> in{' '}
                  <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">escrow-service/.env</code> to enable real payouts.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 bg-amber-200 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                  <svg className="w-5 h-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-amber-900 text-sm">
                    {connectStatus.details_submitted ? 'Stripe: Pending Approval' : 'Connect Stripe to receive payouts'}
                  </p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    {connectStatus.details_submitted
                      ? 'Stripe is reviewing your account. This usually takes 1–2 business days.'
                      : 'Complete onboarding to receive funds when buyers confirm receipt.'}
                  </p>
                </div>
              </div>
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="shrink-0 bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {connecting ? 'Redirecting…' : connectStatus.details_submitted ? 'Complete Onboarding' : 'Connect Stripe'}
              </button>
            </div>
          )}
          {connectError && (
            <p className="text-red-600 text-xs mt-3 bg-red-50 border border-red-100 rounded px-3 py-2">{connectError}</p>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          {
            label: 'Active Listings', value: activeListings.length,
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />,
          },
          {
            label: 'Total Listings', value: listings.length,
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
          },
          {
            label: 'Active Orders', value: activeOrders.length,
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
          },
          {
            label: 'Total Earned', value: `$${(totalEarned / 100).toFixed(2)}`,
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

      {/* Active Orders */}
      {activeOrders.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Active Orders</h2>
          <div className="space-y-2">
            {activeOrders.map((o) => <OrderRow key={o.id} order={o} />)}
          </div>
        </section>
      )}

      {/* My Listings */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900">My Listings</h2>
          <Link href="/listings/new" className="text-sm text-brand-700 font-medium hover:underline">
            + Add new
          </Link>
        </div>
        {listings.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
            <svg className="w-14 h-14 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <p className="text-gray-500 font-medium">No listings yet</p>
            <Link href="/listings/new" className="mt-3 inline-flex items-center gap-1 text-brand-700 text-sm font-medium hover:underline">
              Create your first listing &rarr;
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {listings.map((l) => <ListingRow key={l.id} listing={l} />)}
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

function ListingRow({ listing: l }: { listing: Listing }) {
  const photo = l.photos?.[0];
  const imgUrl = photo ? `${process.env.NEXT_PUBLIC_LISTING_URL}/photos/${photo.filename}` : null;

  return (
    <Link
      href={`/listings/${l.id}`}
      className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-5 py-3.5 hover:shadow-md hover:border-brand-200 transition-all group"
    >
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-lg overflow-hidden bg-gray-100 shrink-0">
          {imgUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imgUrl} alt={l.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-300">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          )}
        </div>
        <p className="text-sm font-semibold text-gray-900 truncate max-w-xs">{l.title}</p>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-sm font-bold text-gray-900">${(l.price_cents / 100).toFixed(2)}</p>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
          l.status === 'active' ? 'bg-brand-100 text-brand-800' :
          l.status === 'sold'   ? 'bg-gray-100 text-gray-500' :
                                  'bg-amber-100 text-amber-700'
        }`}>
          {l.status.charAt(0).toUpperCase() + l.status.slice(1)}
        </span>
        <svg className="w-4 h-4 text-gray-300 group-hover:text-brand-600 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}
