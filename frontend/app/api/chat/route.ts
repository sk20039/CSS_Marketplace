// POST /api/chat — customer chatbot endpoint.
//
// DeepSeek model: deepseek-flash (current recommended model, Nov 2025+).
// Auth: DEEPSEEK_API_KEY (server-side only — never NEXT_PUBLIC_).
// Gate: CHAT_ENABLED=true must be set; returns 503 otherwise.
// Rate: 30 req / 60 s per IP. Requires Vercel KV in production (see
//       lib/chatLimiter.ts). Returns 503 if KV is unavailable or not set.
// Timeout: 15 s to DeepSeek (separate 5 s budget for listing search).
// Body: max 10 KB; max 6 messages; each message max 500 chars; user/assistant roles only.
// No account, order, or payment data is ever accessed or returned.
// Listing searches call the public, unauthenticated GET /listings endpoint only.

import { NextRequest, NextResponse } from 'next/server';
import { buildSystemPrompt }         from '@/lib/chatPolicy';
import { checkRateLimit }            from '@/lib/chatLimiter';
import { validateMessages, MAX_BODY_BYTES } from '@/lib/chatValidate';
import {
  hasSearchIntent,
  extractSearchParams,
  fetchListingResults,
  formatListingsForPrompt,
  type ListingResult,
} from '@/lib/chatSearch';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL        = 'deepseek-flash';
const MAX_TOKENS   = 400;   // caps per-call output cost to ~$0.00048 at peak pricing
const TIMEOUT_MS   = 15_000;
const SEARCH_TIMEOUT_MS = 5_000;

// Vercel overwrites x-forwarded-for with the real client IP (cannot be spoofed).
// x-real-ip is identical on Vercel. We split defensively; Vercel sets one value.
function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── gate ─────────────────────────────────────────────────────────────────
  if (process.env.CHAT_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Chat is not available at this time.' },
      { status: 503 }
    );
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('[chat] DEEPSEEK_API_KEY is not set');
    return NextResponse.json(
      { error: 'Chat is not available at this time.' },
      { status: 503 }
    );
  }

  // ── body size ─────────────────────────────────────────────────────────────
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: 'Failed to read request body.' }, { status: 400 });
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body too large (max ${MAX_BODY_BYTES} bytes).` },
      { status: 413 }
    );
  }

  // ── parse ─────────────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const body = parsed as Record<string, unknown>;

  // ── validate messages ─────────────────────────────────────────────────────
  const validation = validateMessages(body.messages);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }
  const { messages } = validation;

  // ── rate limit ───────────────────────────────────────────────────────────
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    if (rl.unavailable) {
      return NextResponse.json(
        { error: 'Chat is temporarily unavailable. Please try again shortly.' },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: 'Too many requests — please wait before sending another message.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rl.retryAfter) },
      }
    );
  }

  // ── listing search ───────────────────────────────────────────────────────
  const lastUserMessage = messages[messages.length - 1].content;
  let searchResults: ListingResult[] | null = null;

  if (hasSearchIntent(lastUserMessage)) {
    const listingUrl = process.env.NEXT_PUBLIC_LISTING_URL;
    if (listingUrl) {
      const params = extractSearchParams(lastUserMessage);
      const searchAbort = new AbortController();
      const searchTimer = setTimeout(() => searchAbort.abort(), SEARCH_TIMEOUT_MS);
      try {
        searchResults = await fetchListingResults(params, listingUrl, searchAbort.signal);
      } finally {
        clearTimeout(searchTimer);
      }
    }
  }

  // ── build prompt ─────────────────────────────────────────────────────────
  const listingContext = searchResults && searchResults.length > 0
    ? formatListingsForPrompt(searchResults)
    : null;

  const systemPrompt = buildSystemPrompt(listingContext);

  const deepseekMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // ── call DeepSeek ────────────────────────────────────────────────────────
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  let deepseekRes: Response;
  try {
    deepseekRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: deepseekMessages,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: abort.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    console.error('[chat] DeepSeek fetch error:', isAbort ? 'timeout' : err);
    return NextResponse.json(
      { error: isAbort ? 'Request timed out.' : 'AI service unavailable.' },
      { status: isAbort ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!deepseekRes.ok) {
    console.error('[chat] DeepSeek HTTP error:', deepseekRes.status);
    return NextResponse.json({ error: 'AI service unavailable.' }, { status: 502 });
  }

  let dsBody: unknown;
  try {
    dsBody = await deepseekRes.json();
  } catch {
    return NextResponse.json({ error: 'AI service returned an invalid response.' }, { status: 502 });
  }

  // ── extract reply ─────────────────────────────────────────────────────────
  // Validate response shape before trusting any field.
  if (
    typeof dsBody !== 'object' ||
    dsBody === null ||
    !Array.isArray((dsBody as Record<string, unknown>).choices)
  ) {
    console.error('[chat] Unexpected DeepSeek response shape');
    return NextResponse.json({ error: 'AI service returned an invalid response.' }, { status: 502 });
  }

  const choices = (dsBody as Record<string, unknown[]>).choices;
  const firstChoice = choices[0];
  if (
    typeof firstChoice !== 'object' ||
    firstChoice === null ||
    typeof (firstChoice as Record<string, unknown>).message !== 'object'
  ) {
    return NextResponse.json({ error: 'AI service returned an invalid response.' }, { status: 502 });
  }

  const msg = (firstChoice as Record<string, Record<string, unknown>>).message;
  const replyText = msg?.content;
  if (typeof replyText !== 'string') {
    return NextResponse.json({ error: 'AI service returned an invalid response.' }, { status: 502 });
  }

  // ── return ───────────────────────────────────────────────────────────────
  return NextResponse.json({
    reply: replyText,
    search_results: searchResults ?? [],
  });
}
