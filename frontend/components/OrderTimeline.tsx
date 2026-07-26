interface OrderEvent {
  id: number;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

const EVENT_LABELS: Record<string, string> = {
  ORDER_CREATED: 'Order created',
  PAYMENT_CAPTURED: 'Payment captured — funds in escrow',
  ORDER_SHIPPED: 'Marked as shipped',
  ORDER_DELIVERED: 'Marked as delivered',
  BUYER_CONFIRMED: 'Buyer confirmed receipt',
  DISPUTE_FILED: 'Dispute filed',
  DISPUTE_RESOLVED: 'Dispute resolved',
  FUNDS_RELEASED: 'Funds released to seller',
  FUNDS_REFUNDED: 'Refunded to buyer',
  AUTO_RELEASED: 'Auto-released (delivery window expired)',
};

const EVENT_COLORS: Record<string, string> = {
  FUNDS_RELEASED: 'bg-green-500',
  FUNDS_REFUNDED: 'bg-blue-500',
  DISPUTE_FILED: 'bg-red-500',
  DISPUTE_RESOLVED: 'bg-yellow-500',
  PAYMENT_CAPTURED: 'bg-green-400',
};

export default function OrderTimeline({ events }: { events: OrderEvent[] }) {
  if (!events?.length) return <p className="text-gray-500 text-sm">No events yet.</p>;

  return (
    <ol className="relative border-l border-gray-200 space-y-4 pl-4">
      {events.map((ev) => {
        const dotColor = EVENT_COLORS[ev.event_type] || 'bg-gray-400';
        const label = EVENT_LABELS[ev.event_type] || ev.event_type;
        const date = new Date(ev.created_at).toLocaleString();
        let extra = null;
        if (ev.payload_json) {
          try {
            const p = JSON.parse(ev.payload_json);
            if (p.reason) extra = <span className="text-gray-500 italic">"{p.reason}"</span>;
            if (p.action) extra = <span className="text-gray-500">Action: {p.action}</span>;
          } catch { /* ignore */ }
        }
        return (
          <li key={ev.id} className="relative">
            <span className={`absolute -left-6 top-1 w-3 h-3 rounded-full ${dotColor} ring-2 ring-white`} />
            <p className="text-sm font-medium text-gray-900">{label}</p>
            {extra && <p className="text-xs mt-0.5">{extra}</p>}
            <p className="text-xs text-gray-400 mt-0.5">{date}</p>
          </li>
        );
      })}
    </ol>
  );
}
