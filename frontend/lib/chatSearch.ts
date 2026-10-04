// chatSearch.ts — detect listing search intent and query the public listing API.
//
// The listing-service GET /listings endpoint requires no auth and supports:
//   q           text substring match on title + description
//   category    bat | helmet | pads | gloves | kit-bag | other
//   condition   new | used_good | used_fair
//   min_price   integer cents
//   max_price   integer cents
//   limit       max 50 (we use 5)
//
// All listing data is treated as untrusted. HTML tags are stripped before
// the data is injected into the system prompt or returned to the client.

const VALID_CATEGORIES = ['bat', 'helmet', 'pads', 'gloves', 'kit-bag', 'other'] as const;
const VALID_CONDITIONS = ['new', 'used_good', 'used_fair'] as const;

type Category = typeof VALID_CATEGORIES[number];
type Condition = typeof VALID_CONDITIONS[number];

// Words that suggest the user wants to browse or find equipment.
const SEARCH_INTENT_RE =
  /\b(bat|bats|helmet|helmets?|pad|pads?|glove|gloves?|kit.?bag|kitbag|equipment|gear|looking\s+for|find|show\s+me|browse|available|for\s+sale|search|listing|listings?|buy|purchase|under\s+\$?\d|between\s+\$?\d|\$\s*\d+)\b/i;

// Category keywords → canonical category value.
const CATEGORY_MAP: Array<[RegExp, Category]> = [
  [/\bbats?\b/i,                   'bat'],
  [/\bhelmets?\b/i,                'helmet'],
  [/\bpads?\b/i,                   'pads'],
  [/\bgloves?\b/i,                 'gloves'],
  [/\bkit.?bags?\b|\bkitbags?\b/i, 'kit-bag'],
  [/\baccessor(?:y|ies)\b|\bother\b|\bball\b|\bgrip\b/i, 'other'],
];

// Condition keywords → canonical condition value.
const CONDITION_MAP: Array<[RegExp, Condition]> = [
  [/\bnew\b/i,                      'new'],
  [/\bused.?good\b|\bgood condition\b/i, 'used_good'],
  [/\bused.?fair\b|\bfair condition\b|\bused\b/i, 'used_good'], // default "used" → used_good
];

// Price pattern: "under $50", "under 50", "$30 to $60", "between 30 and 60"
const MAX_PRICE_RE = /\bunder\s+\$?\s*(\d+(?:\.\d{1,2})?)\b/i;
const MIN_MAX_PRICE_RE =
  /\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:to|–|-|and)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;

export interface SearchParams {
  q?: string;
  category?: Category;
  condition?: Condition;
  min_price?: number;  // cents
  max_price?: number;  // cents
  limit: number;
}

export interface ListingResult {
  id: number;
  title: string;
  price_cents: number;
  condition: string;
  category: string;
}

// Strip HTML tags and trim whitespace — used before injecting any listing
// field into the system prompt or returning to the client.
export function stripHtml(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '') // remove script/style with their content
    .replace(/<[^>]*>/g, '')                               // remove remaining tags
    .trim();
}

// Detect whether a user message contains listing search intent.
export function hasSearchIntent(message: string): boolean {
  return SEARCH_INTENT_RE.test(message);
}

// Extract search parameters from the user message.
export function extractSearchParams(message: string): SearchParams {
  const params: SearchParams = { limit: 5 };

  // Category
  for (const [re, cat] of CATEGORY_MAP) {
    if (re.test(message)) {
      params.category = cat;
      break;
    }
  }

  // Condition
  for (const [re, cond] of CONDITION_MAP) {
    if (re.test(message)) {
      params.condition = cond;
      break;
    }
  }

  // Price
  const maxMatch = MAX_PRICE_RE.exec(message);
  if (maxMatch) {
    params.max_price = Math.round(parseFloat(maxMatch[1]) * 100);
  }
  const rangeMatch = MIN_MAX_PRICE_RE.exec(message);
  if (rangeMatch) {
    const a = Math.round(parseFloat(rangeMatch[1]) * 100);
    const b = Math.round(parseFloat(rangeMatch[2]) * 100);
    params.min_price = Math.min(a, b);
    params.max_price = Math.max(a, b);
  }

  // q: only pass a text search when no category was detected.
  // When a category is present the category filter alone is sufficient;
  // passing the full conversational message as q causes a full-phrase LIKE
  // that never matches any listing title.
  if (!params.category) {
    const q = message.slice(0, 80).trim();
    if (q) params.q = q;
  }

  return params;
}

// Validate that a listing object from the API has the expected shape.
// Returns null if the object is malformed.
function validateListing(raw: unknown): ListingResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // id may be a number or a numeric string (pg BIGINT → string via pg driver)
  const rawId = r.id;
  const id = typeof rawId === 'number' ? rawId : Number(rawId);
  if (
    !Number.isFinite(id) ||
    typeof r.title !== 'string' ||
    typeof r.price_cents !== 'number' ||
    typeof r.condition !== 'string' ||
    typeof r.category !== 'string'
  ) {
    return null;
  }
  return {
    id,
    title: stripHtml(r.title).slice(0, 120),
    price_cents: r.price_cents,
    condition: stripHtml(r.condition).slice(0, 20),
    category: stripHtml(r.category).slice(0, 20),
  };
}

// formatForPrompt formats listing results as plain text for injection into
// the system prompt. Titles and conditions are already stripped of HTML.
export function formatListingsForPrompt(listings: ListingResult[]): string {
  return listings
    .map((l, i) => {
      const price = (l.price_cents / 100).toFixed(2);
      const cond = conditionLabel(l.condition);
      return `${i + 1}. ${l.title} — $${price} (${cond})`;
    })
    .join('\n');
}

function conditionLabel(raw: string): string {
  switch (raw) {
    case 'new':       return 'New';
    case 'used_good': return 'Used – Good';
    case 'used_fair': return 'Used – Fair';
    default:          return raw;
  }
}

// fetchListingResults calls the public listing-service API and returns
// up to 5 validated listing results, or null on failure.
// The caller should degrade gracefully (chat works without search results).
export async function fetchListingResults(
  params: SearchParams,
  listingServiceUrl: string,
  signal: AbortSignal
): Promise<ListingResult[] | null> {
  const qs = new URLSearchParams();
  if (params.q)          qs.set('q',         params.q);
  if (params.category)   qs.set('category',  params.category);
  if (params.condition)  qs.set('condition', params.condition);
  if (params.min_price != null) qs.set('min_price', String(params.min_price));
  if (params.max_price != null) qs.set('max_price', String(params.max_price));
  qs.set('limit', String(params.limit));

  const url = `${listingServiceUrl}/listings?${qs.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch {
    return null; // timeout or network error — degrade gracefully
  }

  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null) return null;
  const data = body as Record<string, unknown>;
  if (!Array.isArray(data.listings)) return null;

  const results: ListingResult[] = [];
  for (const raw of data.listings) {
    const validated = validateListing(raw);
    if (validated) results.push(validated);
    if (results.length >= params.limit) break;
  }
  return results;
}
