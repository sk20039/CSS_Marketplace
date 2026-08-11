'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import OrderTimeline from '@/components/OrderTimeline';
import { getOrder, cancelOrder, shipOrder, deliverOrder, confirmOrder, disputeOrder, getMessages, sendMessage, submitReview, getOrderReview } from '@/lib/api';
import { useUser } from '@/lib/auth';

interface Order {
  id: number; status: string; amount_cents: number;
  listing_id: number; buyer_id: number; seller_id: number;
  events: { id: number; event_type: string; payload_json: string | null; created_at: string }[];
}

interface Message {
  id: number; sender_id: number; sender_name: string; body: string; created_at: string;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  CREATED:   { label: 'Created',                  cls: 'bg-purple-100 text-purple-700' },
  CAPTURING: { label: 'Capturing payment',         cls: 'bg-gray-100 text-gray-600' },
  HELD:      { label: 'Payment held in escrow',    cls: 'bg-blue-100 text-blue-700' },
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [msgInput, setMsgInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [existingReview, setExistingReview] = useState<{ id: number; rating: number; body: string | null } | null | undefined>(undefined);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

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
    refreshMessages();
    const interval = setInterval(refreshMessages, 5000);
    return () => clearInterval(interval);
  }, [refreshMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
  const statusMeta = STATUS_META[order.status] ?? { label: order.status, cls: 'bg-gray-100 text-gray-600' };

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <nav className="flex items-center gap-2 text-sm text-gray-400 mb-3">
          <Link href={isSeller ? '/dashboard/seller' : '/dashboard/buyer'} className="hover:text-gray-700 transition-colors">
            Dashboard
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

      {/* Action buttons */}
      {actionError && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          {actionError}
        </div>
      )}

      {(isSeller && ['HELD', 'SHIPPED'].includes(order.status)) ||
       (isBuyer && ['DELIVERED', 'HELD'].includes(order.status)) ? (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-700">Actions</p>
          </div>
          <div className="px-6 py-4 flex flex-wrap gap-3">
            {isSeller && order.status === 'HELD' && (
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
            {(isBuyer || isSeller) && order.status === 'HELD' && (
              <ActionButton
                onClick={() => act(() => cancelOrder(id))}
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
          <div className="space-y-3 max-h-72 overflow-y-auto mb-4 pr-1">
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
            <div ref={messagesEndRef} />
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
