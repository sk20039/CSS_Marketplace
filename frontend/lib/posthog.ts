import posthog from 'posthog-js';

/** Module-level suppress flag. Starts true; PostHogProvider sets it false after init. */
let _suppress = true;

export function setSuppressCapture(val: boolean) {
  _suppress = val;
}

/**
 * Bucket a price in cents into an ordinal band.
 * Bands are intentionally coarse to avoid exposing exact transaction values.
 */
export function priceBand(cents: number): string {
  const d = cents / 100;
  if (d < 50)  return 'under_50';
  if (d < 100) return '50_to_100';
  if (d < 200) return '100_to_200';
  if (d < 500) return '200_to_500';
  return 'over_500';
}

/** Thin capture wrapper. No-op when suppressed or on any error. */
export const analytics = {
  capture(event: string, props?: Record<string, unknown>) {
    if (_suppress) return;
    try { posthog.capture(event, props); } catch { /* quiet no-op */ }
  },
};

export default posthog;
