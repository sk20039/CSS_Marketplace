'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import OrderTimeline from '@/components/OrderTimeline';
import { getOrder, shipOrder, deliverOrder, confirmOrder, disputeOrder } from '@/lib/api';
import { useUser } from '@/lib/auth';

interface Order {
  id: number; status: string; amount_cents: number;
  listing_id: number; buyer_id: number; seller_id: number;
  events: { id: number; event_type: string; payload_json: string | null; created_at: string }[];
}

const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Created', CAPTURING: 'Capturing payment', HELD: 'Payment held in escrow',
  SHIPPED: 'Shipped', DELIVERED: 'Delivered', DISPUTED: 'Under dispute',
  RELEASING: 'Releasing funds', REFUNDING: 'Processing refund',
  RELEASED: 'Funds released to seller', REFUNDED: 'Refunded to buyer',
};

const STATUS_COLOR: Record<string, string> = {
  HELD: 'bg-blue-100 text-blue-800', SHIPPED: 'bg-yellow-100 text-yellow-800',
  DELIVERED: 'bg-orange-100 text-orange-800', DISPUTED: 'bg-red-100 text-red-800',
  RELEASED: 'bg-green-100 text-green-800', REFUNDED: 'bg-gray-100 text-gray-800',
};

export default function OrderPage() {
  return (
    <AuthGuard>
      <OrderContent />
    </AuthGuard>
  );
}

function OrderContent() {
  const { id } = useParams<{ id: string }>();
  const user = useUser();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [acting, setActing] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [showDispute, setShowDispute] = useState(false);

  const refresh = useCallback(() => {
    getOrder(id).then(setOrder).catch(() => setError('Order not found')).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  async function act(fn: () => Promise<Response>) {
    setActing(true);
    setActionError('');
    try {
      const res = await fn();
      const data = await res.json();
      if (!res.ok) { setActionError(data.error || 'Action failed'); return; }
      setOrder(data.order || data);
      refresh();
    } catch {
      setActionError('Network error');
    } finally {
      setActing(false);
    }
  }

  async function handleDispute() {
    if (!disputeReason.trim()) return;
    await act(() => disputeOrder(id, disputeReason));
    setShowDispute(false);
    setDisputeReason('');
  }

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;
  if (!order) return <div className="text-center py-20 text-red-500">{error}</div>;

  const isSeller = user && String(user.id) === String(order.seller_id);
  const isBuyer = user && String(user.id) === String(order.buyer_id);
  const statusColor = STATUS_COLOR[order.status] || 'bg-gray-100 text-gray-700';

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Order #{order.id}</h1>
        <span className={`text-sm px-3 py-1 rounded-full font-medium ${statusColor}`}>
          {STATUS_LABELS[order.status] || order.status}
        </span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Amount</span>
          <span className="font-semibold">${(order.amount_cents / 100).toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Listing ID</span>
          <a href={`/listings/${order.listing_id}`} className="text-green-600 hover:underline">#{order.listing_id}</a>
        </div>
      </div>

      {/* Action buttons */}
      {actionError && <p className="text-red-600 text-sm bg-red-50 rounded p-2">{actionError}</p>}
      <div className="flex flex-wrap gap-2">
        {isSeller && order.status === 'HELD' && (
          <button onClick={() => act(() => shipOrder(id))} disabled={acting}
            className="bg-yellow-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-yellow-600 disabled:opacity-50">
            Mark as Shipped
          </button>
        )}
        {isSeller && order.status === 'SHIPPED' && (
          <button onClick={() => act(() => deliverOrder(id))} disabled={acting}
            className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 disabled:opacity-50">
            Mark as Delivered
          </button>
        )}
        {isBuyer && order.status === 'DELIVERED' && (
          <>
            <button onClick={() => act(() => confirmOrder(id))} disabled={acting}
              className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
              Confirm Receipt
            </button>
            <button onClick={() => setShowDispute(true)} disabled={acting}
              className="bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-600 disabled:opacity-50">
              Dispute
            </button>
          </>
        )}
      </div>

      {showDispute && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-red-800">File a dispute</p>
          <textarea
            rows={3}
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            placeholder="Describe the issue (item not as described, not received, etc.)"
            className="w-full border border-red-300 rounded-lg px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button onClick={handleDispute} disabled={acting || !disputeReason.trim()}
              className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
              Submit Dispute
            </button>
            <button onClick={() => setShowDispute(false)}
              className="border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Order Timeline</h2>
        <OrderTimeline events={order.events || []} />
      </div>
    </div>
  );
}
