// Order lifecycle email notifications.
// All exported functions are async and meant to be called fire-and-forget
// (.catch(() => {})) — a failed email must never block a state transition.

const db = require('./db');
const { sendEmail } = require('./emailer');

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3003';

function getUser(id) {
  return db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id);
}

function orderUrl(id) {
  return `${BASE_URL}/orders/${id}`;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---- HELD: payment captured ----
async function notifyOrderCaptured(order) {
  const buyer = getUser(order.buyer_id);
  const seller = getUser(order.seller_id);
  const link = orderUrl(order.id);
  const amount = money(order.amount_cents);

  await Promise.allSettled([
    buyer && sendEmail({
      to: buyer.email,
      subject: `Payment confirmed — Order #${order.id}`,
      text:
        `Hi ${buyer.name},\n\n` +
        `Your payment of ${amount} is held securely in escrow. ` +
        `The seller has been notified to ship your item.\n\n` +
        `View order: ${link}`,
    }),
    seller && sendEmail({
      to: seller.email,
      subject: `New order to ship — Order #${order.id}`,
      text:
        `Hi ${seller.name},\n\n` +
        `You have a new order! Payment of ${amount} is held in escrow and will be released ` +
        `to you once the buyer confirms receipt.\n\n` +
        `Please ship the item and mark it as shipped.\n\n` +
        `Manage order: ${link}`,
    }),
  ]);
}

// ---- SHIPPED ----
async function notifyShipped(order) {
  const buyer = getUser(order.buyer_id);
  if (!buyer) return;
  await sendEmail({
    to: buyer.email,
    subject: `Your order has been shipped — Order #${order.id}`,
    text:
      `Hi ${buyer.name},\n\n` +
      `The seller has shipped your order (${money(order.amount_cents)}). ` +
      `Once you receive it, please confirm receipt. ` +
      `You have 48 hours after delivery is marked to confirm or file a dispute.\n\n` +
      `View order: ${orderUrl(order.id)}`,
  });
}

// ---- DELIVERED ----
async function notifyDelivered(order) {
  const buyer = getUser(order.buyer_id);
  if (!buyer) return;
  await sendEmail({
    to: buyer.email,
    subject: `Delivery marked — please confirm receipt — Order #${order.id}`,
    text:
      `Hi ${buyer.name},\n\n` +
      `The seller has marked Order #${order.id} (${money(order.amount_cents)}) as delivered.\n\n` +
      `Please confirm receipt to release payment to the seller. ` +
      `If there is a problem with your item, you can file a dispute instead. ` +
      `Funds will be automatically released after 48 hours if no action is taken.\n\n` +
      `View order: ${orderUrl(order.id)}`,
  });
}

// ---- CANCELLED ----
async function notifyCancelled(order, { cancelledBy }) {
  const buyer = getUser(order.buyer_id);
  const seller = getUser(order.seller_id);
  const link = orderUrl(order.id);
  const amount = money(order.amount_cents);
  const by = cancelledBy === 'buyer' ? 'the buyer' : cancelledBy === 'seller' ? 'the seller' : 'an admin';

  await Promise.allSettled([
    buyer && sendEmail({
      to: buyer.email,
      subject: `Order cancelled — full refund issued — Order #${order.id}`,
      text:
        `Hi ${buyer.name},\n\n` +
        `Order #${order.id} has been cancelled by ${by}. ` +
        `A full refund of ${amount} has been issued to your original payment method. ` +
        `Please allow 5–10 business days for it to appear.\n\n` +
        `View order: ${link}`,
    }),
    seller && sendEmail({
      to: seller.email,
      subject: `Order cancelled — Order #${order.id}`,
      text:
        `Hi ${seller.name},\n\n` +
        `Order #${order.id} (${amount}) has been cancelled by ${by}. ` +
        `The buyer has been fully refunded and the listing is active again.\n\n` +
        `View order: ${link}`,
    }),
  ]);
}

// ---- DISPUTED ----
async function notifyDisputed(order) {
  const seller = getUser(order.seller_id);
  if (!seller) return;
  await sendEmail({
    to: seller.email,
    subject: `Dispute filed on your order — Order #${order.id}`,
    text:
      `Hi ${seller.name},\n\n` +
      `The buyer has filed a dispute on Order #${order.id} (${money(order.amount_cents)}). ` +
      `An admin will review the dispute and make a decision.\n\n` +
      `View order: ${orderUrl(order.id)}`,
  });
}

// ---- RELEASED ----
async function notifyReleased(order, { triggeredBy }) {
  const buyer = getUser(order.buyer_id);
  const seller = getUser(order.seller_id);
  const link = orderUrl(order.id);
  const trigger =
    triggeredBy === 'buyer_confirm' ? 'the buyer confirmed receipt' :
    triggeredBy === 'auto_release_sweep' ? 'the 48-hour window elapsed' :
    'an admin resolved the dispute';

  await Promise.allSettled([
    seller && sendEmail({
      to: seller.email,
      subject: `Funds released — Order #${order.id}`,
      text:
        `Hi ${seller.name},\n\n` +
        `Your payout of ${money(order.seller_payout_cents)} for Order #${order.id} has been ` +
        `released (${trigger}). It will appear in your connected Stripe account shortly.\n\n` +
        `View order: ${link}`,
    }),
    buyer && sendEmail({
      to: buyer.email,
      subject: `Transaction complete — Order #${order.id}`,
      text:
        `Hi ${buyer.name},\n\n` +
        `Order #${order.id} is complete — the seller has been paid. ` +
        `Thank you for using USA Cricket Marketplace!\n\n` +
        `View order: ${link}`,
    }),
  ]);
}

// ---- REFUNDED ----
async function notifyRefunded(order, { triggeredBy }) {
  const buyer = getUser(order.buyer_id);
  const seller = getUser(order.seller_id);
  const link = orderUrl(order.id);
  const amount = money(order.amount_cents);

  await Promise.allSettled([
    buyer && sendEmail({
      to: buyer.email,
      subject: `Refund issued — Order #${order.id}`,
      text:
        `Hi ${buyer.name},\n\n` +
        `The dispute on Order #${order.id} has been resolved in your favour. ` +
        `A full refund of ${amount} has been issued to your original payment method. ` +
        `Please allow 5–10 business days for it to appear.\n\n` +
        `View order: ${link}`,
    }),
    seller && sendEmail({
      to: seller.email,
      subject: `Dispute resolved — buyer refunded — Order #${order.id}`,
      text:
        `Hi ${seller.name},\n\n` +
        `The dispute on Order #${order.id} has been resolved in the buyer's favour. ` +
        `The buyer has been refunded ${amount}.\n\n` +
        `View order: ${link}`,
    }),
  ]);
}

module.exports = {
  notifyOrderCaptured,
  notifyShipped,
  notifyDelivered,
  notifyCancelled,
  notifyDisputed,
  notifyReleased,
  notifyRefunded,
};
