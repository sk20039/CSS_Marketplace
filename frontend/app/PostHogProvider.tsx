'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import posthog from 'posthog-js';
import { useAuth } from '@/lib/auth';
import { analytics, setSuppressCapture } from '@/lib/posthog';

const PH_KEY  = process.env.NEXT_PUBLIC_POSTHOG_KEY  ?? '';
const PH_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { user, initializing } = useAuth();
  const pathname = usePathname();
  const phReady  = useRef(false);
  const lastUid  = useRef<string | null>(null);

  // Initialize PostHog once on client mount.
  useEffect(() => {
    if (!PH_KEY || phReady.current) return;
    try {
      posthog.init(PH_KEY, {
        api_host:                       PH_HOST,
        persistence:                    'memory',
        capture_pageview:               false,
        autocapture:                    false,
        disable_session_recording:      true,
        enable_heatmaps:                false,
        advanced_disable_feature_flags: true,
      });
      phReady.current = true;
    } catch { /* quiet — missing key or blocked */ }
  }, []);

  // Update suppress flag and manage identity whenever auth state or path changes.
  // Effect 1 always runs before Effect 2 (React guarantees declaration order).
  useEffect(() => {
    const isAdmin     = user?.role === 'admin';
    const isAdminPath = pathname.startsWith('/admin');
    setSuppressCapture(initializing || isAdmin || isAdminPath);

    if (initializing) return;

    if (user && !isAdmin) {
      const uid = String(user.id);
      if (lastUid.current !== uid) {
        try { posthog.identify(uid); } catch { /* quiet */ }
        lastUid.current = uid;
      }
    } else if (!user && lastUid.current !== null) {
      try { posthog.reset(); } catch { /* quiet */ }
      lastUid.current = null;
    }
  }, [user, initializing, pathname]);

  // Track page views on navigation. user?.role is read from closure intentionally —
  // role is stable within a session, and including it as a dep would cause a spurious
  // duplicate page_viewed on login (same path, new user state).
  useEffect(() => {
    if (initializing) return;
    if (pathname.startsWith('/admin') || user?.role === 'admin') return;
    analytics.capture('page_viewed', { pathname });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, initializing]);

  return <>{children}</>;
}
