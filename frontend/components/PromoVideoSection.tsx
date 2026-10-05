'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * "Meet Cricket Market USA" promo video section.
 * – Loads video only when scrolled into view (Intersection Observer).
 * – No autoplay; user must press play.
 * – Browser native controls; captions on by default.
 */
export default function PromoVideoSection() {
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

  // Show captions by default once video metadata is available
  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = 'showing';
    }
  }

  return (
    <section ref={sectionRef}>
      <div className="text-center mb-6">
        <p className="text-brand-700 text-sm font-semibold uppercase tracking-wider mb-1">
          Our story
        </p>
        <h2 className="text-2xl font-bold text-gray-900">Meet Cricket Market USA</h2>
      </div>

      <div className="relative rounded-2xl overflow-hidden bg-gray-950 shadow-xl mx-auto max-w-4xl">
        <video
          ref={videoRef}
          className="w-full aspect-video"
          poster="/promo/cricket_market_poster.jpg"
          controls
          playsInline
          preload="none"
          onLoadedMetadata={handleLoadedMetadata}
          src={srcLoaded ? '/promo/cricket_market_wide.mp4' : undefined}
        >
          {srcLoaded && (
            <track
              kind="captions"
              src="/promo/cricket_market.vtt"
              srcLang="en"
              label="English"
              default
            />
          )}
          Your browser does not support HTML5 video.
        </video>
      </div>
    </section>
  );
}
