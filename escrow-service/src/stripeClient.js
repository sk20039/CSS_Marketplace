// Thin Stripe client wrapper.
//
// Two modes behind the SAME interface, selected purely by whether
// process.env.STRIPE_SECRET_KEY is set:
//   - STUB mode (default): no network calls, no API key. Simulates
//     PaymentIntent create/capture/refund and Connect Transfer create with
//     fake ids and in-memory bookkeeping. Used for local/sandbox testing.
//   - REAL mode: wraps the real `stripe` npm package, Stripe Connect test
//     mode, "separate charges and transfers" pattern:
//       - PaymentIntent is created and captured on the PLATFORM's own
//         account (manual capture, no `transfer_data` on the intent).
//       - On release, a separate `stripe.transfers.create` moves the
//         seller payout (amount minus platform fee) to the seller's
//         connected account (`destination`), referencing the original
//         charge as `source_transaction`.
//       - Refunds are issued against the original PaymentIntent when a
//         dispute resolves in the buyer's favor.
//
// Interface (both modes implement all of these, all async):
//   createPaymentIntent({ amountCents, currency, metadata }) -> { id, status }
//   capturePaymentIntent(paymentIntentId)                   -> { id, status }
//   createTransfer({ amountCents, currency, destination, metadata, sourceTransactionId }) -> { id, status }
//   createRefund({ paymentIntentId, amountCents })           -> { id, status }

const crypto = require('crypto');

function fakeId(prefix) {
  return `${prefix}_stub_${crypto.randomBytes(8).toString('hex')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Optional artificial network latency for the stub client, OFF by default
// (0ms, no behavior change). Set STRIPE_STUB_LATENCY_MS to simulate
// realistic Stripe round-trip time in concurrency test harnesses - the
// stub's near-instant resolution otherwise hides check-then-act races that
// only manifest once the event loop actually gets a chance to interleave
// during the `await`.
const STUB_LATENCY_MS = Number(process.env.STRIPE_STUB_LATENCY_MS || 0);

class StubStripeClient {
  constructor() {
    this.mode = 'stub';
    this._intents = new Map(); // id -> { amountCents, status, chargeId }
  }

  async createPaymentIntent({ amountCents, currency = 'usd', metadata = {} }) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    const id = fakeId('pi');
    const chargeId = fakeId('ch');
    this._intents.set(id, {
      id,
      amountCents,
      currency,
      metadata,
      status: 'requires_capture', // manual capture flow, mirrors real Stripe
      chargeId,
    });
    return { id, status: 'requires_capture', chargeId };
  }

  async capturePaymentIntent(paymentIntentId) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    const intent = this._intents.get(paymentIntentId);
    if (!intent) {
      throw new Error(`[stripe:stub] Unknown PaymentIntent ${paymentIntentId}`);
    }
    intent.status = 'succeeded';
    return { id: intent.id, status: 'succeeded', chargeId: intent.chargeId };
  }

  async createTransfer({ amountCents, currency = 'usd', destination, metadata = {}, sourceTransactionId }) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    if (!destination) {
      throw new Error('[stripe:stub] createTransfer requires a destination connected account id');
    }
    const id = fakeId('tr');
    return {
      id,
      status: 'paid',
      amountCents,
      currency,
      destination,
      sourceTransactionId,
      metadata,
    };
  }

  async createRefund({ paymentIntentId, amountCents }) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    const intent = this._intents.get(paymentIntentId);
    if (!intent) {
      throw new Error(`[stripe:stub] Unknown PaymentIntent ${paymentIntentId}`);
    }
    const id = fakeId('re');
    return { id, status: 'succeeded', amountCents };
  }
}

class RealStripeClient {
  constructor(secretKey) {
    this.mode = 'real';
    // Lazily require so the `stripe` package is only touched when actually used.
    const Stripe = require('stripe');
    this._stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });
  }

  async createPaymentIntent({ amountCents, currency = 'usd', metadata = {} }) {
    // Separate-charges-and-transfers: PaymentIntent is created on the
    // platform account itself (no `transfer_data`/`on_behalf_of`), manual
    // capture so funds are authorized but held until we choose to capture.
    const intent = await this._stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      capture_method: 'manual',
      metadata,
      // In a real checkout flow a payment_method / confirm step would
      // happen client-side (Stripe Elements). For this backend-only pass
      // we assume the client has already attached & confirmed a payment
      // method, or a test PaymentMethod is used out-of-band.
    });
    return { id: intent.id, status: intent.status };
  }

  async capturePaymentIntent(paymentIntentId) {
    const intent = await this._stripe.paymentIntents.capture(paymentIntentId);
    const chargeId = intent.latest_charge || null;
    return { id: intent.id, status: intent.status, chargeId };
  }

  async createTransfer({ amountCents, currency = 'usd', destination, metadata = {}, sourceTransactionId }) {
    const transfer = await this._stripe.transfers.create({
      amount: amountCents,
      currency,
      destination,
      source_transaction: sourceTransactionId || undefined,
      metadata,
    });
    return { id: transfer.id, status: 'paid' };
  }

  async createRefund({ paymentIntentId, amountCents }) {
    const refund = await this._stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountCents,
    });
    return { id: refund.id, status: refund.status };
  }
}

function buildStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (key && key.trim().length > 0) {
    console.log('[stripe] STRIPE_SECRET_KEY detected -> using REAL Stripe client (test/live mode per key).');
    return new RealStripeClient(key.trim());
  }
  console.log('[stripe] No STRIPE_SECRET_KEY set -> using STUB Stripe client (simulated, no network calls).');
  return new StubStripeClient();
}

// Singleton, built once at process start based on env at that time.
const stripeClient = buildStripeClient();

module.exports = { stripeClient, StubStripeClient, RealStripeClient };
