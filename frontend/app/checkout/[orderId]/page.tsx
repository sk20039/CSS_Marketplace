'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { getOrder, captureOrder, getOrderClientSecret } from '@/lib/api';
import ErrorAlert from '@/components/ErrorAlert';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';

const STRIPE_PUB_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
const stripePromise = STRIPE_PUB_KEY ? loadStripe(STRIPE_PUB_KEY) : null;

interface Order {
  id: number; status: string; amount_cents: number; platform_fee_cents: number;
  seller_payout_cents: number; listing_id: number; buyer_id: number;
  item_price_cents?: number; shipping_cents?: number;
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
          try {
            const d = await getOrderClientSecret(o.id);
            if (d?.client_secret) {
              setClientSecret(d.client_secret);
            } else {
              setError('Could not load payment form. Please refresh and try again.');
            }
          } catch {
            setError('Could not load payment form. Please refresh and try again.');
          }
        }
      })
      .catch(() => setError('Order not found'))
      .finally(() => setLoading(false));
  }, [orderId]);

  if (loading) {
    return (
      <div className="max-w-lg mx-auto space-y-4 mt-8">
        <div className="h-7 bg-gray-200 rounded w-32 animate-pulse" />
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-4 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 h-24 animate-pulse" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-24">
        <p className="text-gray-500 font-medium">{error || 'Order not found'}</p>
        <Link href="/listings" className="mt-3 inline-block text-brand-700 text-sm font-medium hover:underline">
          &larr; Back to listings
        </Link>
      </div>
    );
  }

  if (order.status !== 'CREATED') {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10">
          <svg className="w-12 h-12 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-gray-700 font-medium mb-1">Order already processed</p>
          <p className="text-gray-500 text-sm mb-6">
            This order is currently in <span className="font-semibold text-gray-700">{order.status}</span> status.
          </p>
          <Link
            href={`/orders/${order.id}`}
            className="inline-flex items-center gap-2 bg-brand-700 text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-brand-800 transition-colors text-sm"
          >
            View Order &rarr;
          </Link>
        </div>
      </div>
    );
  }

  const total = (order.amount_cents / 100).toFixed(2);
  const fee = (order.platform_fee_cents / 100).toFixed(2);
  const itemPrice = ((order.item_price_cents ?? order.amount_cents) / 100).toFixed(2);

  return (
    <div className="max-w-lg mx-auto">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/listings" className="hover:text-gray-700 transition-colors">Listings</Link>
        <span>/</span>
        <Link href={`/listings/${order.listing_id}`} className="hover:text-gray-700 transition-colors">Listing #{order.listing_id}</Link>
        <span>/</span>
        <span className="text-gray-600 font-medium">Checkout</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">Checkout</h1>

      <div className="space-y-4">
        {/* Order summary */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-700">Order Summary</p>
          </div>
          <div className="px-6 py-4 space-y-3">
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-500">Order</span>
              <Link href={`/listings/${order.listing_id}`} className="text-brand-700 font-medium hover:underline text-xs">
                Listing #{order.listing_id}
              </Link>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-600">Item price</span>
              <span className="font-medium">${itemPrice}</span>
            </div>
            <div className="flex justify-between items-center text-xs text-gray-400">
              <span>Platform fee (8%, min $2.00)</span>
              <span>${fee}</span>
            </div>
            <div className="border-t border-gray-100 pt-3 flex justify-between items-center">
              <span className="font-semibold text-gray-900">Total charged</span>
              <span className="text-xl font-bold text-brand-700">${total}</span>
            </div>
          </div>
        </div>

        {/* Payment protection banner */}
        <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 flex items-start gap-3">
          <div className="w-8 h-8 bg-brand-700 rounded-full flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-brand-900">Secure Payment</p>
            <p className="text-xs text-brand-700 mt-0.5">
              Funds are held safely and only released to the seller after you confirm receipt of the item.
            </p>
          </div>
        </div>

        <ErrorAlert message={error} />

        {/* Payment form */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-700">Payment Details</p>
          </div>
          <div className="px-6 py-5">
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
              ) : !error ? (
                <div className="text-center text-gray-400 text-sm py-6">
                  <svg className="animate-spin w-5 h-5 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Loading payment form…
                </div>
              ) : null
            ) : (
              <StubPayButton
                order={order}
                onError={setError}
                onSuccess={() => router.push(`/orders/${order.id}`)}
              />
            )}
          </div>
        </div>

        <p className="text-xs text-gray-400 text-center pb-4">
          By completing this purchase you agree to our payment terms. Funds are held until you confirm delivery.
        </p>
      </div>
    </div>
  );
}

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

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="border-2 border-gray-200 rounded-xl p-4 focus-within:border-brand-600 transition-colors">
        <CardElement
          options={{
            style: {
              base: { fontSize: '16px', color: '#111827', fontFamily: 'Inter, system-ui, sans-serif', '::placeholder': { color: '#9ca3af' } },
              invalid: { color: '#dc2626' },
            },
          }}
        />
      </div>
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full bg-brand-700 text-white py-3.5 rounded-xl font-bold text-base hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {submitting ? (
          <>
            <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Processing payment…
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Pay ${(order.amount_cents / 100).toFixed(2)} — Secure Payment
          </>
        )}
      </button>
    </form>
  );
}

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
    <div className="space-y-3">
      <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
        <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-xs text-amber-800">
          <span className="font-semibold">Stub mode</span> — no real card required. Stripe key not configured.
        </p>
      </div>
      <button
        onClick={handleCapture}
        disabled={capturing}
        className="w-full bg-brand-700 text-white py-3.5 rounded-xl font-bold text-base hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {capturing ? (
          <>
            <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Processing…
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Pay ${(order.amount_cents / 100).toFixed(2)} — Secure Payment
          </>
        )}
      </button>
    </div>
  );
}
