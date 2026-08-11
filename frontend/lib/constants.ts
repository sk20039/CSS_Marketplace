export const ORDER_STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  CREATED:    { label: 'Created',      cls: 'bg-purple-100 text-purple-700' },
  CAPTURING:  { label: 'Capturing',    cls: 'bg-gray-100 text-gray-600' },
  HELD:       { label: 'Payment Held', cls: 'bg-blue-100 text-blue-700' },
  SHIPPED:    { label: 'Shipped',      cls: 'bg-amber-100 text-amber-700' },
  DELIVERED:  { label: 'Delivered',    cls: 'bg-orange-100 text-orange-700' },
  DISPUTED:   { label: 'Disputed',     cls: 'bg-red-100 text-red-700' },
  RELEASING:  { label: 'Releasing',    cls: 'bg-gray-100 text-gray-600' },
  RELEASED:   { label: 'Released',     cls: 'bg-brand-100 text-brand-800' },
  REFUNDING:  { label: 'Refunding',    cls: 'bg-gray-100 text-gray-600' },
  REFUNDED:   { label: 'Refunded',     cls: 'bg-gray-100 text-gray-500' },
  CANCELLING: { label: 'Cancelling',   cls: 'bg-gray-100 text-gray-500' },
  CANCELLED:  { label: 'Cancelled',    cls: 'bg-gray-100 text-gray-500' },
};

export const CONDITION_LABELS: Record<string, { label: string; cls: string }> = {
  new:       { label: 'New',         cls: 'bg-brand-700 text-white' },
  used_good: { label: 'Used – Good', cls: 'bg-blue-600 text-white' },
  used_fair: { label: 'Used – Fair', cls: 'bg-amber-500 text-white' },
};

export const CATEGORY_LABELS: Record<string, string> = {
  bat:       'Cricket Bat',
  helmet:    'Helmet',
  pads:      'Batting Pads',
  gloves:    'Gloves',
  'kit-bag': 'Kit Bag',
  other:     'Accessories',
};
