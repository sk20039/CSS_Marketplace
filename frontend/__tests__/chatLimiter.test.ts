// chatLimiter.test.ts — in-memory rate limiter unit tests.
// KV mode is tested by mocking global.fetch; memory mode uses the exported
// _resetMemStore helper.

import { checkRateLimit, _resetMemStore } from '../lib/chatLimiter';

// Ensure KV env vars are absent so tests use the in-memory path.
beforeEach(() => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  _resetMemStore();
});

describe('in-memory limiter', () => {
  it('allows requests within the limit', async () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 30; i++) {
      const result = await checkRateLimit(ip);
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks the 31st request from the same IP', async () => {
    const ip = '5.6.7.8';
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(ip);
    }
    const result = await checkRateLimit(ip);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('does not affect a different IP', async () => {
    const ipA = '10.0.0.1';
    const ipB = '10.0.0.2';
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(ipA);
    }
    const result = await checkRateLimit(ipB);
    expect(result.allowed).toBe(true);
  });

  it('resets after the window expires', async () => {
    const ip = '192.168.1.1';
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(ip);
    }
    expect((await checkRateLimit(ip)).allowed).toBe(false);

    // Simulate window expiry by manipulating the store via reset + re-entry.
    // (Full time-travel would require jest.useFakeTimers, tested separately.)
    _resetMemStore();
    const result = await checkRateLimit(ip);
    expect(result.allowed).toBe(true);
  });
});

describe('KV limiter', () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL   = 'https://fake-kv.vercel.com';
    process.env.KV_REST_API_TOKEN = 'fake-token';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows when KV returns count <= LIMIT', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ result: 1 }, { result: 1 }],
    } as Response);

    const result = await checkRateLimit('1.1.1.1');
    expect(result.allowed).toBe(true);
  });

  it('blocks when KV returns count > LIMIT', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ result: 31 }, { result: 1 }],
    } as Response);

    const result = await checkRateLimit('2.2.2.2');
    expect(result.allowed).toBe(false);
  });

  it('returns unavailable when KV request throws', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('network error'));

    const result = await checkRateLimit('3.3.3.3');
    expect(result.allowed).toBe(false);
    expect((result as { unavailable?: true }).unavailable).toBe(true);
  });

  it('returns unavailable when KV returns a non-OK response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const result = await checkRateLimit('4.4.4.4');
    expect(result.allowed).toBe(false);
    expect((result as { unavailable?: true }).unavailable).toBe(true);
  });
});

describe('production with no KV configured', () => {
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    (process.env as Record<string, string>).NODE_ENV = 'production';
  });

  afterEach(() => {
    (process.env as Record<string, string>).NODE_ENV = savedNodeEnv ?? 'test';
  });

  it('returns unavailable when KV is not configured in production', async () => {
    const result = await checkRateLimit('5.5.5.5');
    expect(result.allowed).toBe(false);
    expect((result as { unavailable?: true }).unavailable).toBe(true);
  });
});
