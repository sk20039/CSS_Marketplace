'use strict';

const { PostHog } = require('posthog-node');

const TIMEOUT_MS = 3000;
let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return null;
  try {
    _client = new PostHog(key, {
      host:          process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt:       1,
      flushInterval: 0,
    });
  } catch {
    _client = null;
  }
  return _client;
}

/**
 * Fire-and-forget PostHog capture. Must only be called after a DB COMMIT.
 * Never throws, never delays the caller, never logs keys/tokens/addresses/payloads.
 * All async rejection paths are caught internally to prevent unhandled rejections.
 */
function capture(distinctId, event, properties) {
  const client = getClient();
  if (!client) return;
  try {
    client.capture({ distinctId: String(distinctId), event, properties: properties || {}, disableGeoip: true });
  } catch {
    return;
  }
  // Detached async tail: fully catches both race branches so no rejection escapes.
  const flush = client.flush().catch(() => {});
  const timer = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
  Promise.race([flush, timer]).catch(() => {});
}

module.exports = { capture };
