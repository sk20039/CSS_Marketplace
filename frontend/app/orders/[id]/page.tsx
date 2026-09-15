'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import OrderTimeline from '@/components/OrderTimeline';
import { getOrder, cancelOrder, purchaseLabel, shipOrder, deliverOrder, confirmOrder, disputeOrder, getMessages, sendMessage, submitReview, getOrderReview, uploadEvidence, listEvidence, downloadEvidence, submitSellerResponse, getSellerResponse } from '@/lib/api';
import type { EvidenceItem, SellerDisputeResponse } from '@/lib/api';
import { useUser } from '@/lib/auth';
import ErrorAlert from '@/components/ErrorAlert';

interface ShippingAddress {
  name: string; line1: string; line2?: string | null;
  city: string; state: string; zip: string;
}

interface Order {
  id: number; status: string; amount_cents: number;
  listing_id: number; buyer_id: number; seller_id: number;
  item_price_cents: number | null;
  shipping_cents: number | null;
  label_cost_cents: number | null;
  label_id: string | null;
  label_url: string | null;
  label_voided_at: string | null;
  label_void_refund_cents: number | null;
  tracking_number: string | null;
  tracking_status: string | null;
  last_tracking_event_at: string | null;
  carrier: string | null;
  carrier_service: string | null;
  ship_by_date: string | null;
  shippo_rate_id: string | null;
  shipping_address: ShippingAddress | null;
  created_at: string;
  events: { id: number; event_type: string; payload_json: string | null; created_at: string }[];
}

// Tracking status display metadata
const TRACKING_STATUS_META: Record<string, { label: string; cls: string }> = {
  UNKNOWN:     { label: 'Status unknown',    cls: 'bg-gray-100 text-gray-500' },
  PRE_TRANSIT: { label: 'Label created',     cls: 'bg-blue-50  text-blue-600' },
  TRANSIT:     { label: 'In transit',        cls: 'bg-amber-100 text-amber-700' },
  DELIVERED:   { label: 'Delivered',         cls: 'bg-green-100 text-green-700' },
  RETURNED:    { label: 'Returned to sender', cls: 'bg-orange-100 text-orange-700' },
  FAILURE:     { label: 'Delivery issue',    cls: 'bg-red-100 text-red-700' },
};

// Carrier tracking page URLs for known safe carriers only.
const CARRIER_TRACKING_URLS: Record<string, string> = {
  usps:  'https://tools.usps.com/go/TrackConfirmAction?tLabels=',
  ups:   'https://www.ups.com/track?tracknum=',
  fedex: 'https://www.fedex.com/fedextrack/?trknbr=',
  dhl:   'https://www.dhl.com/en/express/tracking.html?AWB=',
};

function carrierTrackingUrl(carrier: string | null, trackingNumber: string | null): string | null {
  if (!carrier || !trackingNumber) return null;
  const base = CARRIER_TRACKING_URLS[carrier.toLowerCase()];
  return base ? `${base}${encodeURIComponent(trackingNumber)}` : null;
}

interface Message {
  id: number; sender_id: number; sender_name: string; body: string; created_at: string;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  CREATED:   { label: 'Created',                  cls: 'bg-purple-100 text-purple-700' },
  CAPTURING: { label: 'Capturing payment',         cls: 'bg-gray-100 text-gray-600' },
  HELD:      { label: 'Payment held securely',    cls: 'bg-blue-100 text-blue-700' },
  LABELING:  { label: 'Purchasing label',          cls: 'bg-blue-50 text-blue-500' },
  SHIPPED:   { label: 'Shipped',                   cls: 'bg-amber-100 text-amber-700' },
  DELIVERED: { label: 'Delivered',                 cls: 'bg-orange-100 text-orange-700' },
  DISPUTED:  { label: 'Under dispute',             cls: 'bg-red-100 text-red-700' },
  RELEASING: { label: 'Releasing funds',           cls: 'bg-gray-100 text-gray-600' },
  RELEASED:  { label: 'Funds released to seller',  cls: 'bg-brand-100 text-brand-800' },
  REFUNDING: { label: 'Processing refund',         cls: 'bg-gray-100 text-gray-600' },
  REFUNDED:  { label: 'Refunded to buyer',         cls: 'bg-gray-100 text-gray-500' },
  CANCELLING:{ label: 'Cancelling',                cls: 'bg-gray-100 text-gray-500' },
  CANCELLED: { label: 'Cancelled',                 cls: 'bg-gray-100 text-gray-500' },
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
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [purchasingLabel, setPurchasingLabel] = useState(false);
  const [labelError, setLabelError] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [msgInput, setMsgInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [existingReview, setExistingReview] = useState<{ id: number; rating: number; body: string | null } | null | undefined>(undefined);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  // Evidence state (dispute phase)
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const [sellerResponse, setSellerResponse] = useState<SellerDisputeResponse | null | undefined>(undefined);
  const [responseBody, setResponseBody] = useState('');
  const [submittingResponse, setSubmittingResponse] = useState(false);
  const [responseError, setResponseError] = useState('');

  const refresh = useCallback(() => {
    getOrder(id).then(setOrder).catch(() => setError('Order not found')).finally(() => setLoading(false));
  }, [id]);

  const refreshMessages = useCallback(() => {
    getMessages(id).then(setMessages).catch(() => {});
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (order?.status === 'RELEASED' && user && String(user.id) === String(order.buyer_id)) {
      getOrderReview(id).then(setExistingReview).catch(() => setExistingReview(null));
    }
  }, [order?.status, order?.buyer_id, user, id]);

  useEffect(() => {
    if (order?.status === 'DISPUTED') {
      setEvidenceLoading(true);
      Promise.all([
        listEvidence(id).then(setEvidence).catch(() => {}),
        getSellerResponse(id).then(setSellerResponse).catch(() => setSellerResponse(null)),
      ]).finally(() => setEvidenceLoading(false));
    }
  }, [order?.status, id]);

  useEffect(() => {
    refreshMessages();
    const interval = setInterval(refreshMessages, 5000);
    return () => clearInterval(interval);
  }, [refreshMessages]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

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

  async function handlePurchaseLabel() {
    if (purchasingLabel) return;
    setPurchasingLabel(true);
    setLabelError('');
    try {
      const res = await purchaseLabel(id);
      const data = await res.json();
      if (!res.ok) { setLabelError(data.error || 'Label purchase failed'); return; }
      setOrder(data.order || data);
      refresh();
    } catch {
      setLabelError('Network error — please try again');
    } finally {
      setPurchasingLabel(false);
    }
  }

  async function handleSubmitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!reviewRating || submittingReview) return;
    setReviewError('');
    setSubmittingReview(true);
    try {
      const res = await submitReview(id, reviewRating, reviewBody);
      const data = await res.json();
      if (!res.ok) { setReviewError(data.error || 'Failed to submit review'); return; }
      setExistingReview(data);
    } catch {
      setReviewError('Network error');
    } finally {
      setSubmittingReview(false);
    }
  }

  async function handleEvidenceUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || uploadingEvidence) return;
    e.target.value = '';
    setUploadingEvidence(true);
    setEvidenceError('');
    try {
      const res = await uploadEvidence(id, file);
      const data = await res.json();
      if (!res.ok) { setEvidenceError(data.error || 'Upload failed'); return; }
      setEvidence((prev) => [...prev, data]);
    } catch {
      setEvidenceError('Network error during upload');
    } finally {
      setUploadingEvidence(false);
    }
  }

  async function handleDownloadEvidence(evidenceId: number, filename: string) {
    try {
      const res = await downloadEvidence(id, evidenceId);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { /* silent */ }
  }

  async function handleSubmitSellerResponse(e: React.FormEvent) {
    e.preventDefault();
    if (!responseBody.trim() || submittingResponse) return;
    setSubmittingResponse(true);
    setResponseError('');
    try {
      const res = await submitSellerResponse(id, responseBody.trim());
      const data = await res.json();
      if (!res.ok) { setResponseError(data.error || 'Failed to submit response'); return; }
      setSellerResponse(data);
    } catch {
      setResponseError('Network error');
    } finally {
      setSubmittingResponse(false);
    }
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!msgInput.trim() || sending) return;
    setSending(true);
    try {
      const res = await sendMessage(id, msgInput.trim());
      if (res.ok) {
        const msg = await res.json();
        setMessages((prev) => [...prev, msg]);
        setMsgInput('');
      }
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="h-8 bg-gray-200 rounded w-40 animate-pulse" />
        <div className="bg-white rounded-2xl border border-gray-200 h-32 animate-pulse" />
        <div className="bg-white rounded-2xl border border-gray-200 h-48 animate-pulse" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-24">
        <p className="text-gray-500 font-medium">{error || 'Order not found'}</p>
      </div>
    );
  }

  const isSeller = user && String(user.id) === String(order.seller_id);
  const isBuyer = user && String(user.id) === String(order.buyer_id);
  const isAdmin = user?.role === 'admin';
  const statusMeta = STATUS_META[order.status] ?? { label: order.status, cls: 'bg-gray-100 text-gray-600' };
  const dashboardHref = isAdmin ? '/admin' : isSeller ? '/dashboard/seller' : '/dashboard/buyer';
  const dashboardLabel = isAdmin ? 'Admin' : 'Dashboard';

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <nav className="flex items-center gap-2 text-sm text-gray-400 mb-3">
          <Link href={dashboardHref} className="hover:text-gray-700 transition-colors">
            {dashboardLabel}
          </Link>
          <span>/</span>
          <span className="text-gray-600 font-medium">Order #{order.id}</span>
        </nav>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-gray-900">Order #{order.id}</h1>
          <span className={`text-sm font-semibold px-3 py-1.5 rounded-full ${statusMeta.cls}`}>
            {statusMeta.label}
          </span>
        </div>
      </div>

      {/* Payment pending banner — buyer only, CREATED status */}
      {isBuyer && order.status === 'CREATED' && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex items-start gap-3 flex-1">
            <div className="w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center shrink-0 mt-0.5">
              <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-900">Payment Pending</p>
              <p className="text-xs text-amber-700 mt-0.5">
                Your order has been created, but payment has not been completed.
              </p>
            </div>
          </div>
          <Link
            href={`/checkout/${order.id}`}
            className="inline-flex items-center justify-center gap-2 bg-green-600 text-white font-semibold text-sm px-5 py-2.5 rounded-xl hover:bg-green-700 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            Continue to Payment
          </Link>
        </div>
      )}

      {/* Order summary card */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700">Order Details</p>
          <Link href={`/listings/${order.listing_id}`} className="text-xs text-brand-700 font-medium hover:underline">
            View listing &rarr;
          </Link>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Listing</span>
            <span className="font-medium text-gray-900">#{order.listing_id}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Amount</span>
            <span className="font-bold text-gray-900 text-base">${(order.amount_cents / 100).toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">{isSeller ? 'Buyer' : 'Seller'} ID</span>
            <span className="font-medium text-gray-700">#{isSeller ? order.buyer_id : order.seller_id}</span>
          </div>
        </div>
      </div>

      {/* Shipping section — seller sees buy-label UI; buyer sees tracking if available */}
      {(isSeller && ['HELD', 'LABELING', 'SHIPPED', 'DELIVERED'].includes(order.status)) ||
       (isBuyer && order.tracking_number) ? (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10" />
            </svg>
            <p className="text-sm font-semibold text-gray-700">Shipping</p>
          </div>
          <div className="px-6 py-4 space-y-4">
            {isSeller && order.shipping_address && (
              <div>
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Ship to</p>
                <p className="text-sm text-gray-800 font-medium">{order.shipping_address.name}</p>
                <p className="text-sm text-gray-600">{order.shipping_address.line1}{order.shipping_address.line2 ? `, ${order.shipping_address.line2}` : ''}</p>
                <p className="text-sm text-gray-600">{order.shipping_address.city}, {order.shipping_address.state} {order.shipping_address.zip}</p>
              </div>
            )}

            {(order.carrier || order.carrier_service || order.shipping_cents != null) && (
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {(order.carrier || order.carrier_service) && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Service</p>
                    <p className="text-sm text-gray-800">
                      {[order.carrier, order.carrier_service].filter(Boolean).join(' — ')}
                    </p>
                  </div>
                )}
                {order.shipping_cents != null && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Shipping</p>
                    <p className="text-sm text-gray-800">${(order.shipping_cents / 100).toFixed(2)}</p>
                  </div>
                )}
                {isSeller && order.ship_by_date && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Ship by</p>
                    <p className="text-sm text-gray-800">{new Date(order.ship_by_date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                  </div>
                )}
              </div>
            )}

            {/* Seller: label purchase or label info */}
            {isSeller && order.status === 'LABELING' && (
              <div className="flex items-center gap-2 text-sm text-blue-600">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Label purchase in progress…
              </div>
            )}

            {isSeller && order.status === 'HELD' && !order.label_id && (
              <div className="space-y-2">
                {labelError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{labelError}</p>
                )}
                <button
                  onClick={handlePurchaseLabel}
                  disabled={purchasingLabel}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg disabled:opacity-50 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                  {purchasingLabel ? 'Purchasing…' : 'Purchase Shipping Label'}
                </button>
              </div>
            )}

            {isSeller && order.label_id && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-green-700 font-medium">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Label purchased
                </div>
                {order.tracking_number && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Tracking</p>
                    <p className="text-sm font-mono text-gray-800">{order.tracking_number}</p>
                  </div>
                )}
                {order.tracking_status ? (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Carrier status</p>
                    <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full ${(TRACKING_STATUS_META[order.tracking_status] ?? TRACKING_STATUS_META.UNKNOWN).cls}`}>
                      {(TRACKING_STATUS_META[order.tracking_status] ?? TRACKING_STATUS_META.UNKNOWN).label}
                    </span>
                    {(order.tracking_status === 'PRE_TRANSIT' || order.tracking_status === 'UNKNOWN') && (
                      <p className="text-xs text-gray-400 italic mt-1">Waiting for carrier scan…</p>
                    )}
                  </div>
                ) : order.status === 'HELD' ? (
                  <p className="text-xs text-gray-400 italic">Waiting for carrier scan…</p>
                ) : null}
                {order.label_voided_at && (
                  <div className="text-xs text-gray-500">
                    <span className="font-medium text-gray-600">Label voided</span>
                    {' '}on {new Date(order.label_voided_at).toLocaleDateString()}
                    {order.label_void_refund_cents != null && order.label_void_refund_cents > 0 && (
                      <span> · Shippo credit: ${(order.label_void_refund_cents / 100).toFixed(2)}</span>
                    )}
                  </div>
                )}
                {!order.label_voided_at && order.status === 'CANCELLED' && (
                  <p className="text-xs text-amber-600 italic">Label void pending — contact support if this persists.</p>
                )}
                {order.label_url && !order.label_voided_at && (
                  <a
                    href={order.label_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    View / Print Shipping Label
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            )}

            {/* Buyer: show tracking number if label was purchased */}
            {isBuyer && order.tracking_number && (
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Tracking number</p>
                  <p className="text-sm font-mono text-gray-800">{order.tracking_number}</p>
                  {(order.carrier || order.carrier_service) && (
                    <p className="text-xs text-gray-500 mt-0.5">{[order.carrier, order.carrier_service].filter(Boolean).join(' — ')}</p>
                  )}
                </div>
                {order.tracking_status && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Carrier status</p>
                    <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full ${(TRACKING_STATUS_META[order.tracking_status] ?? TRACKING_STATUS_META.UNKNOWN).cls}`}>
                      {(TRACKING_STATUS_META[order.tracking_status] ?? TRACKING_STATUS_META.UNKNOWN).label}
                    </span>
                  </div>
                )}
                {(!order.tracking_status || order.tracking_status === 'PRE_TRANSIT' || order.tracking_status === 'UNKNOWN') && (
                  <p className="text-xs text-gray-400 italic">Waiting for carrier scan…</p>
                )}
                {carrierTrackingUrl(order.carrier, order.tracking_number) && (
                  <a
                    href={carrierTrackingUrl(order.carrier, order.tracking_number)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Track on carrier website
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Shipping exception banner (RETURNED / FAILURE) — buyer-facing CTA */}
      {isBuyer &&
        (order.tracking_status === 'RETURNED' || order.tracking_status === 'FAILURE') &&
        ['SHIPPED', 'DELIVERED'].includes(order.status) && (
        <div className="bg-red-50 border border-red-200 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-red-200 flex items-center gap-2">
            <svg className="w-4 h-4 text-red-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm font-semibold text-red-800">
              {order.tracking_status === 'RETURNED' ? 'Package returned to sender' : 'Delivery failed'}
            </p>
          </div>
          <div className="px-6 py-4 space-y-3">
            <p className="text-sm text-red-700">
              {order.tracking_status === 'RETURNED'
                ? 'The carrier returned this package to the seller. If you have not received your item, you can file a dispute below.'
                : 'The carrier was unable to deliver this package. If you have not received your item, you can file a dispute below.'}
            </p>
            {!showDispute && order.status !== 'DISPUTED' && (
              <button
                onClick={() => setShowDispute(true)}
                className="inline-flex items-center gap-2 bg-red-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-red-700 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                File a Dispute
              </button>
            )}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <ErrorAlert message={actionError} />

      {/* Show the Actions card only when at least one action is available.
          Sellers with a platform label in HELD status have no manual actions
          (the carrier TRANSIT scan drives HELD→SHIPPED automatically). */}
      {((isSeller && order.status === 'HELD' && !order.label_id) ||
        (isSeller && order.status === 'SHIPPED') ||
        (isBuyer && ['DELIVERED', 'HELD'].includes(order.status))) ? (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-700">Actions</p>
          </div>
          <div className="px-6 py-4 flex flex-wrap gap-3">
            {/* Mark as Shipped: only for non-label orders (legacy / non-Shippo flow).
                Platform label orders transition via Shippo carrier webhook. */}
            {isSeller && order.status === 'HELD' && !order.label_id && (
              <ActionButton
                onClick={() => act(() => shipOrder(id))}
                disabled={acting}
                color="amber"
                icon="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12"
                label="Mark as Shipped"
              />
            )}
            {isSeller && order.status === 'SHIPPED' && (
              <ActionButton
                onClick={() => act(() => deliverOrder(id))}
                disabled={acting}
                color="orange"
                icon="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                label="Mark as Delivered"
              />
            )}
            {isBuyer && order.status === 'DELIVERED' && (
              <ActionButton
                onClick={() => act(() => confirmOrder(id))}
                disabled={acting}
                color="brand"
                icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                label="Confirm Receipt"
              />
            )}
            {isBuyer && order.status === 'HELD' && !showCancelConfirm && (
              <ActionButton
                onClick={() => setShowCancelConfirm(true)}
                disabled={acting}
                color="gray"
                icon="M6 18L18 6M6 6l12 12"
                label="Cancel Order"
              />
            )}
            {isBuyer && order.status === 'DELIVERED' && !showDispute && (
              <button
                onClick={() => setShowDispute(true)}
                className="inline-flex items-center gap-2 bg-red-50 text-red-700 border border-red-200 text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-red-100 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                File Dispute
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* Cancel confirmation */}
      {showCancelConfirm && (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm font-semibold text-gray-700">Cancel this order?</p>
          </div>
          <div className="px-6 py-4 space-y-3">
            <p className="text-sm text-gray-600">
              The payment hold will be voided and both parties will be notified. This cannot be undone.
              {order.label_id && (
                <span className="block mt-1 text-xs text-gray-500">
                  A shipping label was purchased for this order — it will be voided and the cost credited to the platform&apos;s Shippo account.
                </span>
              )}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => { act(() => cancelOrder(id)); setShowCancelConfirm(false); }}
                disabled={acting}
                className="bg-gray-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
              >
                Yes, cancel order
              </button>
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="border border-gray-200 text-gray-600 text-sm px-5 py-2.5 rounded-lg hover:bg-white transition-colors"
              >
                Keep order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dispute form */}
      {showDispute && (
        <div className="bg-red-50 border border-red-200 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-red-200 flex items-center gap-2">
            <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm font-semibold text-red-800">File a Dispute</p>
          </div>
          <div className="px-6 py-4 space-y-3">
            <p className="text-xs text-red-700">Describe the issue clearly. Our team will review and resolve within 2 business days.</p>
            <textarea
              rows={4}
              value={disputeReason}
              onChange={(e) => setDisputeReason(e.target.value)}
              placeholder="e.g. Item not as described — bat arrived with a crack not shown in photos."
              className="w-full border border-red-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-500 bg-white resize-none"
            />
            <div className="flex gap-3">
              <button
                onClick={handleDispute}
                disabled={acting || !disputeReason.trim()}
                className="bg-red-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                Submit Dispute
              </button>
              <button
                onClick={() => { setShowDispute(false); setDisputeReason(''); }}
                className="border border-gray-200 text-gray-600 text-sm px-5 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dispute Evidence Panel — visible to buyer and seller when DISPUTED */}
      {order.status === 'DISPUTED' && (isBuyer || isSeller) && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            <p className="text-sm font-semibold text-gray-700">Dispute Evidence</p>
          </div>
          <div className="px-6 py-5 space-y-5">
            {/* Shared-visibility warning */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
              <span className="font-semibold">Note:</span> Evidence you upload is visible to the other party and to our admin team. Do not include personal information beyond what is necessary for your case.
            </div>

            {/* Evidence list */}
            {evidenceLoading ? (
              <div className="space-y-2">
                {[1,2].map((i) => <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />)}
              </div>
            ) : evidence.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No evidence uploaded yet.</p>
            ) : (
              <div className="space-y-2">
                {evidence.map((ev) => (
                  <div key={ev.id} className="flex items-center justify-between gap-3 bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                        ev.uploader_role === 'buyer'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}>
                        {ev.uploader_role}
                      </span>
                      <span className="text-sm text-gray-700 truncate">{ev.original_filename}</span>
                      <span className="text-xs text-gray-400 shrink-0">{(ev.file_size_bytes / 1024).toFixed(0)} KB</span>
                    </div>
                    <button
                      onClick={() => handleDownloadEvidence(ev.id, ev.original_filename)}
                      className="text-xs text-brand-700 hover:text-brand-800 font-medium shrink-0"
                    >
                      Download
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Upload section */}
            {evidenceError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{evidenceError}</p>
            )}
            <div>
              <p className="text-xs text-gray-500 mb-2">
                Upload up to 5 files ({isBuyer ? 'buyer' : 'seller'} slot). Accepted: JPG, PNG, WEBP, PDF · Max 10 MB each.
              </p>
              <label className={`inline-flex items-center gap-2 cursor-pointer bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors ${uploadingEvidence ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                {uploadingEvidence ? 'Uploading…' : 'Upload file'}
                <input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" className="hidden" onChange={handleEvidenceUpload} disabled={uploadingEvidence} />
              </label>
            </div>

            {/* Seller response section */}
            {isSeller && (
              <div className="border-t border-gray-100 pt-5">
                <p className="text-sm font-semibold text-gray-700 mb-1">Your Formal Response</p>
                <p className="text-xs text-gray-400 mb-3">Submit one official written statement visible to the buyer and admin. This cannot be edited once submitted.</p>
                {sellerResponse ? (
                  <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                    <p className="text-xs text-gray-400 mb-1">Submitted {new Date(sellerResponse.created_at).toLocaleDateString()}</p>
                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{sellerResponse.body}</p>
                  </div>
                ) : (
                  <form onSubmit={handleSubmitSellerResponse} className="space-y-3">
                    {responseError && (
                      <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{responseError}</p>
                    )}
                    <textarea
                      rows={4}
                      value={responseBody}
                      onChange={(e) => setResponseBody(e.target.value)}
                      placeholder="Describe your side of the dispute clearly and factually…"
                      className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-500 resize-none text-gray-700 placeholder-gray-400"
                    />
                    <button
                      type="submit"
                      disabled={submittingResponse || !responseBody.trim()}
                      className="bg-brand-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-brand-800 disabled:opacity-50 transition-colors"
                    >
                      {submittingResponse ? 'Submitting…' : 'Submit Response'}
                    </button>
                  </form>
                )}
              </div>
            )}

            {/* Buyer: view seller response */}
            {isBuyer && sellerResponse && (
              <div className="border-t border-gray-100 pt-5">
                <p className="text-sm font-semibold text-gray-700 mb-2">Seller&apos;s Formal Response</p>
                <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                  <p className="text-xs text-gray-400 mb-1">Submitted {new Date(sellerResponse.created_at).toLocaleDateString()}</p>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{sellerResponse.body}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-700">Order Timeline</p>
        </div>
        <div className="px-6 py-5">
          <OrderTimeline events={order.events || []} />
        </div>
      </div>

      {/* Review */}
      {order.status === 'RELEASED' && isBuyer && existingReview !== undefined && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-700">Rate this Seller</p>
          </div>
          <div className="px-6 py-5">
            {existingReview ? (
              <div>
                <div className="flex gap-1 mb-2">
                  {[1,2,3,4,5].map((s) => (
                    <svg key={s} className={`w-6 h-6 ${s <= existingReview.rating ? 'text-amber-400' : 'text-gray-200'}`} fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  ))}
                </div>
                {existingReview.body && (
                  <p className="text-sm text-gray-600 italic mb-1">&ldquo;{existingReview.body}&rdquo;</p>
                )}
                <p className="text-xs text-gray-400">Review submitted — thank you!</p>
              </div>
            ) : (
              <form onSubmit={handleSubmitReview} className="space-y-4">
                {reviewError && (
                  <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{reviewError}</div>
                )}
                <div>
                  <p className="text-sm text-gray-600 mb-3">How was your experience with this seller?</p>
                  <div className="flex gap-1">
                    {[1,2,3,4,5].map((s) => (
                      <button
                        key={s} type="button"
                        aria-label={`Rate ${s} star${s !== 1 ? 's' : ''}`}
                        onClick={() => setReviewRating(s)}
                        className="transition-transform hover:scale-110"
                      >
                        <svg className={`w-8 h-8 transition-colors ${s <= reviewRating ? 'text-amber-400' : 'text-gray-200 hover:text-amber-300'}`} fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  rows={3}
                  value={reviewBody}
                  onChange={(e) => setReviewBody(e.target.value)}
                  placeholder="Share your experience (optional)"
                  className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-600 transition-colors resize-none"
                />
                <button
                  type="submit"
                  disabled={!reviewRating || submittingReview}
                  className="bg-brand-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-brand-800 disabled:opacity-50 transition-colors"
                >
                  {submittingReview ? 'Submitting…' : 'Submit Review'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <p className="text-sm font-semibold text-gray-700">Messages</p>
        </div>
        <div className="px-6 py-4">
          <div ref={messagesContainerRef} className="space-y-3 max-h-72 overflow-y-auto mb-4 pr-1">
            {messages.length === 0 ? (
              <div className="text-center py-8">
                <svg className="w-10 h-10 text-gray-200 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-gray-400 text-sm">No messages yet. Start the conversation.</p>
              </div>
            ) : messages.map((m) => {
              const isOwn = user && String(m.sender_id) === String(user.id);
              return (
                <div key={m.id} className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
                  <span className="text-xs text-gray-400 mb-1 px-1">
                    {isOwn ? 'You' : m.sender_name} &middot; {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div className={`px-4 py-2.5 rounded-2xl text-sm max-w-xs break-words leading-relaxed ${
                    isOwn
                      ? 'bg-brand-700 text-white rounded-tr-sm'
                      : 'bg-gray-100 text-gray-900 rounded-tl-sm'
                  }`}>
                    {m.body}
                  </div>
                </div>
              );
            })}
          </div>
          <form onSubmit={handleSendMessage} className="flex gap-2">
            <input
              type="text"
              value={msgInput}
              onChange={(e) => setMsgInput(e.target.value)}
              placeholder="Type a message…"
              className="flex-1 border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-brand-600 transition-colors"
            />
            <button
              type="submit"
              disabled={sending || !msgInput.trim()}
              className="bg-brand-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-800 disabled:opacity-50 transition-colors"
            >
              {sending ? '…' : 'Send'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function ActionButton({ onClick, disabled, color, icon, label }: {
  onClick: () => void; disabled: boolean; color: string; icon: string; label: string;
}) {
  const colors: Record<string, string> = {
    brand:  'bg-brand-700 hover:bg-brand-800 text-white',
    amber:  'bg-amber-500 hover:bg-amber-600 text-white',
    orange: 'bg-orange-500 hover:bg-orange-600 text-white',
    gray:   'bg-gray-200 hover:bg-gray-300 text-gray-700',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-lg disabled:opacity-50 transition-colors ${colors[color] ?? colors.gray}`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
      </svg>
      {label}
    </button>
  );
}
