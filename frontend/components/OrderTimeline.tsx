interface OrderEvent {
  id: number;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

const EVENT_META: Record<string, { label: string; icon: string; color: string }> = {
  ORDER_CREATED:     { label: 'Order created',                        icon: 'M12 4v16m8-8H4',                                                                                                                                                color: 'bg-gray-500' },
  PAYMENT_CAPTURED:  { label: 'Payment captured — funds in escrow',   icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', color: 'bg-brand-700' },
  ORDER_SHIPPED:     { label: 'Marked as shipped',                    icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12',                                                                           color: 'bg-amber-500' },
  ORDER_DELIVERED:   { label: 'Marked as delivered',                  icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',       color: 'bg-orange-500' },
  BUYER_CONFIRMED:   { label: 'Buyer confirmed receipt',              icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',                                                                                                               color: 'bg-brand-700' },
  DISPUTE_FILED:     { label: 'Dispute filed',                        icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',                     color: 'bg-red-500' },
  DISPUTE_RESOLVED:  { label: 'Dispute resolved',                     icon: 'M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3',      color: 'bg-yellow-500' },
  FUNDS_RELEASED:    { label: 'Funds released to seller',             icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: 'bg-brand-700' },
  FUNDS_REFUNDED:    { label: 'Refunded to buyer',                    icon: 'M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6',                                                                                                                    color: 'bg-blue-500' },
  AUTO_RELEASED:     { label: 'Auto-released (delivery window expired)', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',                                                                                                             color: 'bg-brand-600' },
  ORDER_CANCELLED:   { label: 'Order cancelled',                      icon: 'M6 18L18 6M6 6l12 12',                                                                                                                                         color: 'bg-gray-500' },
};

export default function OrderTimeline({ events }: { events: OrderEvent[] }) {
  if (!events?.length) return <p className="text-gray-400 text-sm">No events yet.</p>;

  return (
    <ol className="space-y-0">
      {events.map((ev, idx) => {
        const meta = EVENT_META[ev.event_type] ?? { label: ev.event_type, icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: 'bg-gray-400' };
        const isLast = idx === events.length - 1;

        let extra = null;
        if (ev.payload_json) {
          try {
            const p = JSON.parse(ev.payload_json);
            if (p.reason) extra = <span className="italic">&ldquo;{p.reason}&rdquo;</span>;
            if (p.action) extra = <span>Admin action: <strong>{p.action}</strong></span>;
          } catch { /* ignore */ }
        }

        return (
          <li key={ev.id} className="flex gap-4">
            {/* Icon + line */}
            <div className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full ${meta.color} flex items-center justify-center shrink-0 ring-4 ring-white`}>
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={meta.icon} />
                </svg>
              </div>
              {!isLast && <div className="w-0.5 flex-1 bg-gray-200 my-1" />}
            </div>
            {/* Content */}
            <div className={`pb-6 ${isLast ? 'pb-0' : ''}`}>
              <p className="text-sm font-semibold text-gray-900 leading-tight">{meta.label}</p>
              {extra && <p className="text-xs text-gray-500 mt-0.5">{extra}</p>}
              <p className="text-xs text-gray-400 mt-1">
                {new Date(ev.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
