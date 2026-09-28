import type { CaptureResult } from 'posthog-js';

/**
 * URL-bearing properties that PostHog automatically attaches to every event.
 * Each can contain query strings or fragments that must not be sent.
 */
const URL_PROPS = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
] as const;

/**
 * Strip query string and fragment from a URL, returning only origin + pathname.
 *
 * Sentinels (e.g. '$direct') and empty/undefined values are returned unchanged.
 * Malformed URLs that cannot be parsed are returned unchanged.
 */
export function sanitizeUrl(raw: string | undefined): string | undefined {
  if (!raw || raw.startsWith('$')) return raw;
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return raw;
  }
}

/**
 * PostHog before_send callback.
 *
 * For every event before transmission:
 * - Strips query strings and fragments from all automatic URL properties.
 * - Adds $geoip_disable:true so the PostHog ingest server skips GeoIP enrichment.
 *
 * Does not drop events (never returns null) and does not touch non-URL properties.
 */
export function sanitizeBeforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null;
  const props: Record<string, unknown> = { ...event.properties };
  for (const key of URL_PROPS) {
    if (typeof props[key] === 'string') {
      props[key] = sanitizeUrl(props[key] as string);
    }
  }
  props.$geoip_disable = true;
  return { ...event, properties: props };
}
