'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import { getOrder, captureOrder } from '@/lib/api';

interface Order {
  id: number; status: string; amount_cents: number; platform_fee_cents: number;
  seller_payout_cents: number; listing_id: number; buyer_id: number;
}

export default function CheckoutPage() {
  return (
    <AuthGuard allowedRoles={['buyer', 'admin']}>
      <CheckoutContent />
    </AuthGuard>
  );
}

function CheckoutContent() {
  const { orderId } = useParams<{ orderId: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getOrder(orderId).then(setOrder).catch(() => setError('Order not found')).finally(() => setLoading(false));
  }, [orderId]);

  async function handleCapture() {
    if (!order) return;
    setCapturing(true);
    setError('');
    try {
      const res = await captureOrder(order.id);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Payment failed'); return; }
      router.push(`/orders/${order.id}`);
    } catch {
      setError('Network error');
    } finally {
      setCapturing(false);
    }
  }

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;
  if (!order) return <div className="text-center py-20 text-red-500">{error}</div>;

  if (order.status !== 'CREATED') {
    return (
      <div className="max-w-md mx-auto mt-12 text-center">
        <p className="text-gray-600">This order is already in status <strong>{order.status}</strong>.</p>
        <a href={`/orders/${order.id}`} className="text-green-600 hover:underline block mt-2">View order →</a>
      </div>
    );
  }

  const subtotal = (order.amount_cents / 100).toFixed(2);
  const fee = (order.platform_fee_cents / 100).toFixed(2);

  return (
    <div className="max-w-md mx-auto mt-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Checkout</h1>
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Order #{order.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Item price</span>
            <span>${subtotal}</span>
          </div>
          <div className="flex justify-between text-gray-500 text-xs">
            <span>Platform fee (3%)</span>
            <span>${fee}</span>
          </div>
          <div className="border-t pt-2 flex justify-between font-bold text-base">
            <span>Total</span>
            <span className="text-green-700">${subtotal}</span>
          </div>
        </div>

        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
          <strong>Secure escrow payment.</strong> Funds are held until you confirm receipt of the item.
        </div>

        {error && <p className="text-red-600 text-sm bg-red-50 rounded p-2">{error}</p>}

        <button
          onClick={handleCapture}
          disabled={capturing}
          className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold text-lg hover:bg-green-700 disabled:opacity-50"
        >
          {capturing ? 'Processing payment...' : `Pay $${subtotal} — Secure Escrow`}
        </button>
        <p className="text-xs text-gray-400 text-center">
          Payment is held in escrow and released to the seller only after you confirm receipt.
        </p>
      </div>
    </div>
  );
}
