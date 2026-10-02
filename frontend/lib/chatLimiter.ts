// chatLimiter.ts — rate limiter for POST /api/chat.
//
// Dual-mode:
//   KV mode    — uses Vercel KV via REST API when KV_REST_API_URL and
//                KV_REST_API_TOKEN are set. Vercel sets these automatically
//                when you create a KV database and link it to the project.
//
//                Setup: Vercel Dashboard → Storage → KV → Create Database →
//                select your project → Connect. Vercel adds KV_REST_API_URL
//                and KV_REST_API_TOKEN to all environments automatically.
//                No npm package needed; uses fetch against the KV REST endpoint.
//
//   Memory mode — per-instance in-memory Map. ONLY used when
//                NODE_ENV !== 'production' (local dev and tests).
//                Resets on cold starts; does NOT share state across instances.
//
// PRODUCTION REQUIREMENT: KV must be configured when CHAT_ENABLED=true.
// If KV env vars are absent or the KV call fails, checkRateLimit returns
// unavailable=true and the route handler returns 503 without calling DeepSeek.
// This prevents unmetered access if the shared store is unreachable.

const LIMIT = 30;           // requests allowed per window
const WINDOW_SECS = 60;     // window duration in seconds
const MAX_MEM_IPS = 5000;   // cap memory Map size to prevent unbounded growth

// --- result type ------------------------------------------------------------

export type RateLimitResult =
  | { allowed: true;  retryAfter: 0 }
  | { allowed: false; retryAfter: number; unavailable?: true };

// --- in-memory store (dev / test only) --------------------------------------

interface MemEntry { count: number; windowStart: number }
const memStore = new Map<string, MemEntry>();

function memCheck(ip: string): RateLimitResult {
  const now = Date.now();
  const windowMs = WINDOW_SECS * 1000;

  // Evict stale entries periodically to bound memory.
  if (memStore.size > MAX_MEM_IPS) {
    const cutoff = now - windowMs * 2;
    memStore.forEach((v, k) => {
      if (v.windowStart < cutoff) memStore.delete(k);
    });
  }

  const entry = memStore.get(ip);
  if (!entry || now - entry.windowStart >= windowMs) {
    memStore.set(ip, { count: 1, windowStart: now });
    return { allowed: true, retryAfter: 0 };
  }
  if (entry.count >= LIMIT) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }
  entry.count++;
  return { allowed: true, retryAfter: 0 };
}

// --- Vercel KV store (REST, no npm package) ----------------------------------
// Uses INCR + EXPIRE pipeline. Key expires automatically after the window.

async function kvCheck(ip: string): Promise<RateLimitResult> {
  const url = process.env.KV_REST_API_URL!;
  const token = process.env.KV_REST_API_TOKEN!;
  const slot = Math.floor(Date.now() / (WINDOW_SECS * 1000));
  const key = `chat_rl:${ip}:${slot}`;

  let count: number;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(WINDOW_SECS * 2)],
      ]),
    });
    if (!res.ok) throw new Error(`KV pipeline ${res.status}`);
    const data = (await res.json()) as Array<{ result: number }>;
    count = data[0]?.result ?? 0;
  } catch (err) {
    // KV failure: fail CLOSED — unavailable rather than allowing unmetered access.
    console.error('[chatLimiter] KV error, returning unavailable:', err);
    return { allowed: false, retryAfter: WINDOW_SECS, unavailable: true };
  }

  if (count > LIMIT) {
    return { allowed: false, retryAfter: WINDOW_SECS };
  }
  return { allowed: true, retryAfter: 0 };
}

// --- public API -------------------------------------------------------------

export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return kvCheck(ip);
  }
  // KV not configured. In production this is a misconfiguration — return
  // unavailable so the route returns 503 without calling DeepSeek.
  if (process.env.NODE_ENV === 'production') {
    console.error('[chatLimiter] KV not configured in production');
    return { allowed: false, retryAfter: WINDOW_SECS, unavailable: true };
  }
  // Local dev / test: use in-memory limiter.
  return memCheck(ip);
}

// Exposed for unit tests only — reset the in-memory store between tests.
export function _resetMemStore(): void {
  memStore.clear();
}
