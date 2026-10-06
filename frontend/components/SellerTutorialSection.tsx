'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

/**
 * "How to Sell Your Cricket Gear" tutorial video section.
 * – Lazy-loads video only when scrolled into view (Intersection Observer).
 * – No autoplay; user must press play.
 * – Browser native controls; captions on by default.
 * – "Start Selling" CTA links to /register.
 */
export default function SellerTutorialSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const videoRef   = useRef<HTMLVideoElement>(null);
  const [srcLoaded, setSrcLoaded] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setSrcLoaded(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = 'showing';
    }
  }

  return (
    <section ref={sectionRef} className="bg-white rounded-2xl border border-gray-200 px-6 py-10">
      <div className="text-center mb-6">
        <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">
          Step by step
        </p>
        <h2 className="text-2xl font-bold text-gray-900">How to Sell Your Cricket Gear</h2>
        <p className="text-gray-500 text-sm mt-2 max-w-xl mx-auto">
          From account setup to publishing your first listing — see the full seller flow in 45 seconds.
        </p>
      </div>

      <div className="relative rounded-xl overflow-hidden bg-gray-950 shadow-lg mx-auto max-w-4xl">
        <video
          ref={videoRef}
          className="w-full aspect-video"
          poster="/seller-tutorial/seller_tutorial_poster.jpg"
          controls
          playsInline
          preload="none"
          onLoadedMetadata={handleLoadedMetadata}
          src={srcLoaded ? '/seller-tutorial/seller_tutorial_wide.mp4' : undefined}
        >
          {srcLoaded && (
            <track
              kind="captions"
              src="/seller-tutorial/seller_tutorial.vtt"
              srcLang="en"
              label="English"
              default
            />
          )}
          Your browser does not support HTML5 video.
        </video>
      </div>

      <div className="mt-6 text-center">
        <Link
          href="/register"
          className="inline-flex items-center gap-2 bg-brand-700 text-white font-semibold px-7 py-3 rounded-lg hover:bg-brand-800 transition-colors text-sm"
        >
          Start Selling
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
