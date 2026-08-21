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
//   createPaymentIntent({ amountCents, currency, metadata })
//     -> { id, status, client_secret }
//   capturePaymentIntent(paymentIntentId, { idempotencyKey })
//     -> { id, status, chargeId }
//   createTransfer({ amountCents, currency, destination, metadata, sourceTransactionId, idempotencyKey })
//     -> { id, status }
//   createRefund({ paymentIntentId, amountCents, metadata, idempotencyKey })
//     -> { id, status }
//
// Idempotency keys:
//   All money-moving calls accept an optional `idempotencyKey` string.
//   The real client passes it to Stripe as a request option, giving Stripe
//   24-hour idempotent replay semantics. The stub client enforces the same
//   contract in-process: the same key always returns the same result, and
//   reusing a key with different parameters throws to prevent silent bugs.

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

// Produces a deterministic JSON string for an object by sorting its keys
// (and nested object keys) before serialising. Used for idempotency
// fingerprints so that `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the
// same fingerprint — property insertion order must never affect cache lookup.
function stableFingerprint(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableFingerprint(value[k])}`)
      .join(',') +
    '}'
  );
}

class StubStripeClient {
  constructor() {
    this.mode = 'stub';
    this._intents = new Map(); // id -> { amountCents, status, chargeId }
    this._idempotencyCache = new Map(); // key -> { fingerprint: string, result: object }
  }

  // Returns the cached result if the key was seen before with the same
  // fingerprint. Throws an idempotency conflict error if the same key is
  // reused with a different fingerprint (matches Stripe's idempotency
  // conflict semantics). Calls resultFn() exactly once on the first use of
  // each key; subsequent calls with the same key short-circuit without
  // executing resultFn.
  _checkIdempotency(idempotencyKey, fingerprint, resultFn) {
    if (!idempotencyKey) return resultFn();
    if (this._idempotencyCache.has(idempotencyKey)) {
      const cached = this._idempotencyCache.get(idempotencyKey);
      if (cached.fingerprint !== fingerprint) {
        throw new Error(
          `[stripe:stub] Idempotency key '${idempotencyKey}' was already used with different parameters`
        );
      }
      return cached.result;
    }
    const result = resultFn();
    this._idempotencyCache.set(idempotencyKey, { fingerprint, result });
    return result;
  }

  async createPaymentIntent({ amountCents, currency = 'usd', metadata = {} }) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    const id = fakeId('pi');
    const chargeId = fakeId('ch');
    const client_secret = `${id}_secret_stub`;
    this._intents.set(id, {
      id,
      amountCents,
      currency,
      metadata,
      status: 'requires_capture', // manual capture flow, mirrors real Stripe
      chargeId,
      client_secret,
    });
    return { id, status: 'requires_capture', chargeId, client_secret };
  }

  // idempotencyKey fingerprint: the paymentIntentId (a different PI with the
  // same key is a conflict — you can only capture a specific intent once).
  async capturePaymentIntent(paymentIntentId, { idempotencyKey } = {}) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    const fingerprint = paymentIntentId;
    return this._checkIdempotency(idempotencyKey, fingerprint, () => {
      const intent = this._intents.get(paymentIntentId);
      if (!intent) {
        throw new Error(`[stripe:stub] Unknown PaymentIntent ${paymentIntentId}`);
      }
      intent.status = 'succeeded';
      return { id: intent.id, status: 'succeeded', chargeId: intent.chargeId };
    });
  }

  // idempotencyKey fingerprint: all financial parameters plus metadata.
  // Metadata is included because a different operationType or orderId on the
  // same key indicates a different intended operation (mirrors real Stripe
  // idempotency conflict semantics). Keys are sorted via stableFingerprint so
  // property insertion order never affects cache lookup.
  async createTransfer({ amountCents, currency = 'usd', destination, metadata = {}, sourceTransactionId, idempotencyKey }) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    if (!destination) {
      throw new Error('[stripe:stub] createTransfer requires a destination connected account id');
    }
    const fingerprint = stableFingerprint({ amountCents, currency, destination, sourceTransactionId, metadata });
    return this._checkIdempotency(idempotencyKey, fingerprint, () => {
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
    });
  }

  // idempotencyKey fingerprint: PaymentIntent ID, refund amount, and metadata.
  // Metadata is included for the same reason as createTransfer. Keys are
  // sorted via stableFingerprint so property insertion order never matters.
  async createRefund({ paymentIntentId, amountCents, metadata = {}, idempotencyKey }) {
    if (STUB_LATENCY_MS > 0) await sleep(STUB_LATENCY_MS);
    const intent = this._intents.get(paymentIntentId);
    if (!intent) {
      throw new Error(`[stripe:stub] Unknown PaymentIntent ${paymentIntentId}`);
    }
    const fingerprint = stableFingerprint({ paymentIntentId, amountCents, metadata });
    return this._checkIdempotency(idempotencyKey, fingerprint, () => {
      const id = fakeId('re');
      return { id, status: 'succeeded', amountCents, metadata };
    });
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
      payment_method_types: ['card'],
      metadata,
    });
    return { id: intent.id, status: intent.status, client_secret: intent.client_secret };
  }

  async capturePaymentIntent(paymentIntentId, { idempotencyKey } = {}) {
    const options = idempotencyKey ? { idempotencyKey } : {};
    const intent = await this._stripe.paymentIntents.capture(paymentIntentId, {}, options);
    const chargeId = intent.latest_charge || null;
    return { id: intent.id, status: intent.status, chargeId };
  }

  async createTransfer({ amountCents, currency = 'usd', destination, metadata = {}, sourceTransactionId, idempotencyKey }) {
    const options = idempotencyKey ? { idempotencyKey } : {};
    const transfer = await this._stripe.transfers.create(
      {
        amount: amountCents,
        currency,
        destination,
        source_transaction: sourceTransactionId || undefined,
        metadata,
      },
      options
    );
    return { id: transfer.id, status: 'paid' };
  }

  async createRefund({ paymentIntentId, amountCents, metadata = {}, idempotencyKey }) {
    const options = idempotencyKey ? { idempotencyKey } : {};
    const refund = await this._stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: amountCents,
        metadata,
      },
      options
    );
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
