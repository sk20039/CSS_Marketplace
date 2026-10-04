// chatSearch.test.ts — listing search intent detection, param extraction,
// response validation, and HTML stripping.

import {
  hasSearchIntent,
  extractSearchParams,
  fetchListingResults,
  formatListingsForPrompt,
  stripHtml,
} from '../lib/chatSearch';

// ── hasSearchIntent ──────────────────────────────────────────────────────────

describe('hasSearchIntent', () => {
  it('detects bat search', () => {
    expect(hasSearchIntent('I am looking for a used bat')).toBe(true);
  });
  it('detects helmets search', () => {
    expect(hasSearchIntent('show me helmets under $50')).toBe(true);
  });
  it('detects price range query', () => {
    expect(hasSearchIntent('bats between $30 and $80')).toBe(true);
  });
  it('detects "for sale" phrasing', () => {
    expect(hasSearchIntent('what gloves are for sale?')).toBe(true);
  });
  it('does not trigger on policy questions', () => {
    expect(hasSearchIntent('what is the platform fee?')).toBe(false);
    expect(hasSearchIntent('how do I cancel my order?')).toBe(false);
    expect(hasSearchIntent('how long does shipping take?')).toBe(false);
  });
  it('does not trigger on empty string', () => {
    expect(hasSearchIntent('')).toBe(false);
  });
});

// ── extractSearchParams ──────────────────────────────────────────────────────

describe('extractSearchParams', () => {
  it('extracts category bat', () => {
    const p = extractSearchParams('I want a bat');
    expect(p.category).toBe('bat');
  });
  it('extracts category helmet', () => {
    expect(extractSearchParams('any helmets?').category).toBe('helmet');
  });
  it('extracts category gloves', () => {
    expect(extractSearchParams('batting gloves').category).toBe('gloves');
  });
  it('extracts category kit-bag', () => {
    expect(extractSearchParams('kit bag please').category).toBe('kit-bag');
  });
  it('extracts condition new', () => {
    expect(extractSearchParams('new bat').condition).toBe('new');
  });
  it('maps "used" to used_good', () => {
    expect(extractSearchParams('used cricket bat').condition).toBe('used_good');
  });
  it('extracts max_price from "under $50"', () => {
    const p = extractSearchParams('bats under $50');
    expect(p.max_price).toBe(5000);
  });
  it('extracts max_price from "under 80"', () => {
    const p = extractSearchParams('helmet under 80');
    expect(p.max_price).toBe(8000);
  });
  it('extracts price range "$30 to $60"', () => {
    const p = extractSearchParams('bats $30 to $60');
    expect(p.min_price).toBe(3000);
    expect(p.max_price).toBe(6000);
  });
  it('sets limit to 5', () => {
    expect(extractSearchParams('any bats?').limit).toBe(5);
  });
  it('truncates q to 80 chars when no category', () => {
    const long = 'a'.repeat(100);
    expect(extractSearchParams(long).q?.length).toBeLessThanOrEqual(80);
  });

  // Fix 1: full conversational message must NOT become q when a category is present.
  it('does not set q for a purely conversational bat query', () => {
    const p = extractSearchParams('do you have any cricket bats for sale?');
    expect(p.category).toBe('bat');
    expect(p.q).toBeUndefined();
  });
  it('does not set q for "show me cricket bats"', () => {
    const p = extractSearchParams('show me cricket bats');
    expect(p.category).toBe('bat');
    expect(p.q).toBeUndefined();
  });

  // Brand + category: brand keyword must be preserved as q.
  it('preserves brand keyword when category is also detected', () => {
    const p = extractSearchParams('show me CEAT bats');
    expect(p.category).toBe('bat');
    expect(p.q).toBe('CEAT');
  });
  it('preserves multi-word brand keyword', () => {
    const p = extractSearchParams('show me English willow bats');
    expect(p.category).toBe('bat');
    expect(p.q).toMatch(/English\s+willow/i);
  });
});

// ── stripHtml ────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('strips HTML tags', () => {
    expect(stripHtml('<b>hello</b> world')).toBe('hello world');
  });
  it('strips script tags', () => {
    expect(stripHtml('<script>alert(1)</script>bat')).toBe('bat');
  });
  it('handles non-string input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(42)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });
  it('trims whitespace', () => {
    expect(stripHtml('  hello  ')).toBe('hello');
  });
});

// ── fetchListingResults ──────────────────────────────────────────────────────

describe('fetchListingResults', () => {
  afterEach(() => jest.restoreAllMocks());

  const signal = new AbortController().signal;

  it('returns validated results on success', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total: 2, page: 1, limit: 5,
        listings: [
          { id: 1, title: 'Gray-Nicolls Bat', price_cents: 8000, condition: 'used_good', category: 'bat', status: 'active', photos: [] },
          { id: 2, title: 'Kookaburra Helmet', price_cents: 4500, condition: 'new', category: 'helmet', status: 'active', photos: [] },
        ],
      }),
    } as Response);

    const results = await fetchListingResults({ limit: 5 }, 'http://listing', signal);
    expect(results).toHaveLength(2);
    expect(results![0].id).toBe(1);
    expect(results![0].title).toBe('Gray-Nicolls Bat');
    expect(results![1].condition).toBe('new');
  });

  it('strips HTML from listing titles', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        listings: [
          { id: 3, title: '<b>Bat</b>', price_cents: 1000, condition: 'new', category: 'bat' },
        ],
      }),
    } as Response);

    const results = await fetchListingResults({ limit: 5 }, 'http://listing', signal);
    expect(results![0].title).toBe('Bat');
  });

  it('returns null on HTTP error', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const results = await fetchListingResults({ limit: 5 }, 'http://listing', signal);
    expect(results).toBeNull();
  });

  it('returns null on network error', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('network'));
    const results = await fetchListingResults({ limit: 5 }, 'http://listing', signal);
    expect(results).toBeNull();
  });

  it('returns null when listings key is missing from response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total: 0 }),
    } as Response);
    const results = await fetchListingResults({ limit: 5 }, 'http://listing', signal);
    expect(results).toBeNull();
  });

  it('skips listings with non-numeric id strings', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        listings: [
          { id: 'bad-id', title: 'Bad', price_cents: 100, condition: 'new', category: 'bat' },
          { id: 4, title: 'Good', price_cents: 200, condition: 'new', category: 'bat' },
        ],
      }),
    } as Response);
    const results = await fetchListingResults({ limit: 5 }, 'http://listing', signal);
    expect(results).toHaveLength(1);
    expect(results![0].id).toBe(4);
  });

  // Fix 2: listing service returns BIGINT ids as strings ("21" not 21).
  it('accepts string numeric ids from the listing service (pg BIGINT)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        listings: [
          { id: '21', title: 'KSC Tapeball Bat', price_cents: 5999, condition: 'used_good', category: 'bat' },
          { id: '22', title: 'SG Pads', price_cents: 3000, condition: 'new', category: 'pads' },
        ],
      }),
    } as Response);
    const results = await fetchListingResults({ limit: 5 }, 'http://listing', signal);
    expect(results).toHaveLength(2);
    expect(results![0].id).toBe(21);
    expect(results![1].id).toBe(22);
  });
});

// ── formatListingsForPrompt ──────────────────────────────────────────────────

describe('formatListingsForPrompt', () => {
  it('formats listings as numbered plain-text lines', () => {
    const text = formatListingsForPrompt([
      { id: 1, title: 'Kookaburra Bat', price_cents: 7500, condition: 'used_good', category: 'bat' },
      { id: 2, title: 'SG Pads', price_cents: 3000, condition: 'new', category: 'pads' },
    ]);
    expect(text).toContain('1. Kookaburra Bat — $75.00 (Used – Good)');
    expect(text).toContain('2. SG Pads — $30.00 (New)');
  });
  it('returns empty string for empty array', () => {
    expect(formatListingsForPrompt([])).toBe('');
  });
});
