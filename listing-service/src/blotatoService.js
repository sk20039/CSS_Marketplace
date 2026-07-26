// Optional integration: auto-post new listings to social media via Blotato
// (https://www.blotato.com). This module is fully dormant unless
// BLOTATO_ENABLED=true and BLOTATO_API_KEY are both set - with no config it
// is a silent no-op and never touches the listing-creation request/response.
// Safe to leave committed and deployed as-is.
//
// To turn it on later (no code changes needed):
//   1. Create a Blotato account and connect the social accounts you want to
//      post to (X/Twitter, Instagram, TikTok, LinkedIn, Facebook, etc).
//   2. Get an API key from Blotato (Settings -> API keys) and find each
//      connected account's accountId (GET /v2/users/me/accounts on
//      Blotato's API - see help.blotato.com/api/accounts).
//   3. Set these env vars on this service (see .env.example for the shape):
//        BLOTATO_ENABLED=true
//        BLOTATO_API_KEY=<your key>
//        BLOTATO_ACCOUNTS=<JSON array, one entry per account to post to>
//        PUBLIC_BASE_URL=<this service's own public URL, for photo links>
//      FRONTEND_ORIGIN (already set for CORS) is reused to build the
//      "view listing" link in the post text.
//
// Design notes:
//   - Fire-and-forget: postNewListingToSocial() never throws and is never
//     awaited by the caller, so a Blotato outage, bad config, or rate limit
//     can NEVER break or slow down listing creation. This is pure marketing
//     upside bolted onto a critical path, not core functionality - it must
//     stay isolated from it.
//   - Each connected account is posted to independently and failures are
//     logged per-account, so one bad account config doesn't stop the others.

const BLOTATO_API_BASE = 'https://backend.blotato.com/v2';

function isEnabled() {
  return process.env.BLOTATO_ENABLED === 'true' && !!process.env.BLOTATO_API_KEY;
}

// BLOTATO_ACCOUNTS is a JSON array of:
//   { "platform": "twitter", "accountId": "...", "target": { "targetType": "..." } }
// One entry per connected social account you want new listings posted to.
// (Facebook/Pinterest/YouTube targets need extra fields - see
// help.blotato.com/api/publish-post for the exact shape per platform.)
function parseAccounts() {
  const raw = process.env.BLOTATO_ACCOUNTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[blotato] BLOTATO_ACCOUNTS is not valid JSON - skipping social post:', err.message);
    return [];
  }
}

function buildCaption(listing) {
  const price = (listing.price_cents / 100).toFixed(2);
  const link = `${process.env.FRONTEND_ORIGIN || ''}/listings/${listing.id}`;
  return `New listing on Cricket Market: ${listing.title} - $${price}\n${link}`;
}

// Blotato takes plain public media URLs, no upload step - so this only
// works for photos already reachable at this service's public URL.
// New listings normally have zero photos at creation time (photos are
// uploaded via a separate follow-up call), so mediaUrls will often be
// empty here; that's expected, not a bug - Blotato accepts an empty array.
function buildMediaUrls(listing) {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base || !Array.isArray(listing.photos) || listing.photos.length === 0) return [];
  return listing.photos.map((p) => `${base}/photos/${p.filename}`);
}

async function postToAccount(account, text, mediaUrls) {
  const res = await fetch(`${BLOTATO_API_BASE}/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'blotato-api-key': process.env.BLOTATO_API_KEY,
    },
    body: JSON.stringify({
      post: {
        accountId: account.accountId,
        content: { text, mediaUrls, platform: account.platform },
        target: account.target,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Blotato returned ${res.status}: ${body}`);
  }
  return res.json();
}

async function postNewListingToSocial(listing) {
  if (!isEnabled()) return;

  const accounts = parseAccounts();
  if (accounts.length === 0) {
    console.warn('[blotato] BLOTATO_ENABLED=true but BLOTATO_ACCOUNTS is empty - nothing to post to');
    return;
  }

  const text = buildCaption(listing);
  const mediaUrls = buildMediaUrls(listing);

  for (const account of accounts) {
    try {
      const result = await postToAccount(account, text, mediaUrls);
      console.log(
        `[blotato] posted listing ${listing.id} to ${account.platform} (${account.accountId}) - submission ${result.postSubmissionId}`
      );
    } catch (err) {
      console.error(`[blotato] post to ${account.platform} (${account.accountId}) failed:`, err.message);
    }
  }
}

module.exports = { postNewListingToSocial, isEnabled };
