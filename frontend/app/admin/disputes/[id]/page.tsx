'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import OrderTimeline from '@/components/OrderTimeline';
import { getOrder, resolveDispute } from '@/lib/api';

interface Order {
  id: number; status: string; amount_cents: number; listing_id: number;
  buyer_id: number; seller_id: number; dispute_reason_text?: string;
  dispute_category?: string; seller_payout_cents: number; platform_fee_cents: number;
  events: { id: number; event_type: string; payload_json: string | null; created_at: string }[];
}

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
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getOrder(id).then(setOrder).catch(() => setError('Order not found')).finally(() => setLoading(false));
  }, [id]);

  async function handle(action: 'release' | 'refund') {
    setResolving(true);
    setError('');
    try {
      const res = await resolveDispute(id, action);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Resolution failed'); return; }
      router.push('/admin');
    } catch {
      setError('Network error');
    } finally {
      setResolving(false);
    }
  }

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;
  if (!order) return <div className="text-center py-20 text-red-500">{error}</div>;

  if (order.status !== 'DISPUTED') {
    return (
      <div className="max-w-lg mx-auto mt-12 text-center">
        <p className="text-gray-600">Order #{order.id} is not in DISPUTED status (current: <strong>{order.status}</strong>).</p>
        <Link href="/admin" className="text-green-600 hover:underline block mt-2">← Back to admin</Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link href="/admin" className="text-sm text-green-600 hover:underline">← Back to admin</Link>
      <h1 className="text-2xl font-bold text-gray-900">Resolve Dispute — Order #{order.id}</h1>

      {/* Dispute info */}
      <div className="bg-red-50 border border-red-200 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-red-700 font-medium text-sm">Dispute Reason</span>
          {order.dispute_category && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              order.dispute_category === 'valid' ? 'bg-red-200 text-red-700' :
              order.dispute_category === 'invalid' ? 'bg-gray-200 text-gray-600' : 'bg-yellow-100 text-yellow-700'
            }`}>
              Auto-tagged: {order.dispute_category}
            </span>
          )}
        </div>
        <p className="text-sm text-red-800 italic">
          "{order.dispute_reason_text || '(no reason provided)'}"
        </p>
      </div>

      {/* Financial summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-2 text-sm">
        <p className="font-semibold text-gray-700 mb-2">Financial Summary</p>
        <div className="flex justify-between"><span className="text-gray-500">Order total</span><span>${(order.amount_cents / 100).toFixed(2)}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">Platform fee</span><span>${(order.platform_fee_cents / 100).toFixed(2)}</span></div>
        <div className="flex justify-between font-medium"><span className="text-gray-500">Seller payout (if released)</span><span className="text-green-700">${(order.seller_payout_cents / 100).toFixed(2)}</span></div>
        <div className="flex justify-between font-medium"><span className="text-gray-500">Buyer refund (if refunded)</span><span className="text-blue-700">${(order.amount_cents / 100).toFixed(2)}</span></div>
      </div>

      {/* Resolution actions */}
      {error && <p className="text-red-600 text-sm bg-red-50 rounded p-2">{error}</p>}
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => handle('release')}
          disabled={resolving}
          className="bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 disabled:opacity-50 space-y-0.5"
        >
          <div>Release to Seller</div>
          <div className="text-xs font-normal opacity-80">Seller wins — funds released</div>
        </button>
        <button
          onClick={() => handle('refund')}
          disabled={resolving}
          className="bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 space-y-0.5"
        >
          <div>Refund Buyer</div>
          <div className="text-xs font-normal opacity-80">Buyer wins — full refund</div>
        </button>
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Order Timeline</h2>
        <OrderTimeline events={order.events || []} />
      </div>
    </div>
  );
}
