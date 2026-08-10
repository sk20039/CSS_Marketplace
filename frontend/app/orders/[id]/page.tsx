'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
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

const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Created', CAPTURING: 'Capturing payment', HELD: 'Payment held in escrow',
  SHIPPED: 'Shipped', DELIVERED: 'Delivered', DISPUTED: 'Under dispute',
  RELEASING: 'Releasing funds', REFUNDING: 'Processing refund',
  RELEASED: 'Funds released to seller', REFUNDED: 'Refunded to buyer',
  CANCELLING: 'Cancelling', CANCELLED: 'Cancelled',
};

const STATUS_COLOR: Record<string, string> = {
  HELD: 'bg-blue-100 text-blue-800', SHIPPED: 'bg-yellow-100 text-yellow-800',
  DELIVERED: 'bg-orange-100 text-orange-800', DISPUTED: 'bg-red-100 text-red-800',
  RELEASED: 'bg-green-100 text-green-800', REFUNDED: 'bg-gray-100 text-gray-800',
  CANCELLING: 'bg-gray-100 text-gray-600', CANCELLED: 'bg-gray-100 text-gray-500',
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

  // Messaging state
  const [messages, setMessages] = useState<Message[]>([]);
  const [msgInput, setMsgInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Review state
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

  // Fetch existing review once order loads (only relevant when RELEASED + buyer)
  useEffect(() => {
    if (order?.status === 'RELEASED' && user && String(user.id) === String(order.buyer_id)) {
      getOrderReview(id).then(setExistingReview).catch(() => setExistingReview(null));
    }
  }, [order?.status, order?.buyer_id, user, id]);

  // Poll messages every 5s
  useEffect(() => {
    refreshMessages();
    const interval = setInterval(refreshMessages, 5000);
    return () => clearInterval(interval);
  }, [refreshMessages]);

  // Scroll to bottom when new messages arrive
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
        {(isBuyer || isSeller) && order.status === 'HELD' && (
          <button onClick={() => act(() => cancelOrder(id))} disabled={acting}
            className="bg-gray-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-600 disabled:opacity-50">
            Cancel Order
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

      {/* Review — visible to buyer after RELEASED */}
      {order.status === 'RELEASED' && isBuyer && existingReview !== undefined && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Rate this seller</h2>
          {existingReview ? (
            <div>
              <div className="flex gap-1 mb-2">
                {[1,2,3,4,5].map((s) => (
                  <span key={s} className={`text-xl ${s <= existingReview.rating ? 'text-yellow-400' : 'text-gray-200'}`}>★</span>
                ))}
              </div>
              {existingReview.body && <p className="text-sm text-gray-600 italic">&ldquo;{existingReview.body}&rdquo;</p>}
              <p className="text-xs text-gray-400 mt-1">Review submitted</p>
            </div>
          ) : (
            <form onSubmit={handleSubmitReview} className="space-y-3">
              {reviewError && <p className="text-red-600 text-sm bg-red-50 rounded p-2">{reviewError}</p>}
              <div>
                <p className="text-sm text-gray-600 mb-2">How was your experience?</p>
                <div className="flex gap-1">
                  {[1,2,3,4,5].map((s) => (
                    <button
                      key={s} type="button"
                      onClick={() => setReviewRating(s)}
                      className={`text-2xl transition-colors ${s <= reviewRating ? 'text-yellow-400' : 'text-gray-200 hover:text-yellow-300'}`}
                    >★</button>
                  ))}
                </div>
              </div>
              <textarea
                rows={3}
                value={reviewBody}
                onChange={(e) => setReviewBody(e.target.value)}
                placeholder="Share your experience (optional)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
              <button
                type="submit"
                disabled={!reviewRating || submittingReview}
                className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {submittingReview ? 'Submitting…' : 'Submit Review'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Messages</h2>
        <div className="space-y-3 max-h-80 overflow-y-auto mb-4 pr-1">
          {messages.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-4">No messages yet. Start the conversation.</p>
          ) : (
            messages.map((m) => {
              const isOwn = user && String(m.sender_id) === String(user.id);
              return (
                <div key={m.id} className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
                  <span className="text-xs text-gray-400 mb-1">
                    {isOwn ? 'You' : m.sender_name} · {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div className={`px-3 py-2 rounded-2xl text-sm max-w-xs break-words ${
                    isOwn ? 'bg-green-600 text-white rounded-tr-sm' : 'bg-gray-100 text-gray-900 rounded-tl-sm'
                  }`}>
                    {m.body}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
        <form onSubmit={handleSendMessage} className="flex gap-2">
          <input
            type="text"
            value={msgInput}
            onChange={(e) => setMsgInput(e.target.value)}
            placeholder="Type a message…"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            type="submit"
            disabled={sending || !msgInput.trim()}
            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
