'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import { getOrder, captureOrder, getOrderClientSecret } from '@/lib/api';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';

const STRIPE_PUB_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';

// Instantiated once at module level so Stripe.js is only loaded once per page load.
const stripePromise = STRIPE_PUB_KEY ? loadStripe(STRIPE_PUB_KEY) : null;

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
  const [clientSecret, setClientSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getOrder(orderId)
      .then(async (o: Order) => {
        setOrder(o);
        if (STRIPE_PUB_KEY && o.status === 'CREATED') {
          const d = await getOrderClientSecret(o.id);
          if (d?.client_secret) setClientSecret(d.client_secret);
        }
      })
      .catch(() => setError('Order not found'))
      .finally(() => setLoading(false));
  }, [orderId]);

  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>;
  if (!order) return <div className="text-center py-20 text-red-500">{error || 'Order not found'}</div>;

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

        {STRIPE_PUB_KEY ? (
          clientSecret ? (
            <Elements stripe={stripePromise}>
              <CardPaymentForm
                order={order}
                clientSecret={clientSecret}
                onError={setError}
                onSuccess={() => router.push(`/orders/${order.id}`)}
              />
            </Elements>
          ) : (
            <div className="text-center text-gray-400 text-sm py-4">Loading payment form…</div>
          )
        ) : (
          <StubPayButton
            order={order}
            onError={setError}
            onSuccess={() => router.push(`/orders/${order.id}`)}
          />
        )}

        <p className="text-xs text-gray-400 text-center">
          Payment is held in escrow and released to the seller only after you confirm receipt.
        </p>
      </div>
    </div>
  );
}

// Real Stripe card form — only rendered when NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is set
function CardPaymentForm({ order, clientSecret, onError, onSuccess }: {
  order: Order; clientSecret: string; onError: (e: string) => void; onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    onError('');

    const cardElement = elements.getElement(CardElement);
    if (!cardElement) { setSubmitting(false); return; }

    // Authorize the card — with capture_method:'manual' this puts the
    // PaymentIntent into requires_capture (funds authorized, not yet moved).
    const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: { card: cardElement },
    });

    if (stripeError) {
      onError(stripeError.message || 'Card declined');
      setSubmitting(false);
      return;
    }

    if (paymentIntent?.status !== 'requires_capture') {
      onError(`Unexpected payment status: ${paymentIntent?.status}`);
      setSubmitting(false);
      return;
    }

    // Card authorized — tell the escrow service to capture the hold
    try {
      const res = await captureOrder(order.id);
      const data = await res.json();
      if (!res.ok) { onError(data.error || 'Capture failed'); setSubmitting(false); return; }
      onSuccess();
    } catch {
      onError('Network error during capture');
      setSubmitting(false);
    }
  }

  const subtotal = (order.amount_cents / 100).toFixed(2);

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="border border-gray-300 rounded-lg p-3 bg-white">
        <CardElement
          options={{
            style: {
              base: { fontSize: '16px', color: '#374151', '::placeholder': { color: '#9ca3af' } },
              invalid: { color: '#dc2626' },
            },
          }}
        />
      </div>
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold text-lg hover:bg-green-700 disabled:opacity-50"
      >
        {submitting ? 'Processing payment...' : `Pay $${subtotal} — Secure Escrow`}
      </button>
    </form>
  );
}

// Stub mode — no Stripe key configured; capture directly without card collection
function StubPayButton({ order, onError, onSuccess }: {
  order: Order; onError: (e: string) => void; onSuccess: () => void;
}) {
  const [capturing, setCapturing] = useState(false);

  async function handleCapture() {
    setCapturing(true);
    onError('');
    try {
      const res = await captureOrder(order.id);
      const data = await res.json();
      if (!res.ok) { onError(data.error || 'Payment failed'); return; }
      onSuccess();
    } catch {
      onError('Network error');
    } finally {
      setCapturing(false);
    }
  }

  return (
    <button
      onClick={handleCapture}
      disabled={capturing}
      className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold text-lg hover:bg-green-700 disabled:opacity-50"
    >
      {capturing ? 'Processing payment...' : `Pay $${(order.amount_cents / 100).toFixed(2)} — Secure Escrow`}
    </button>
  );
}
