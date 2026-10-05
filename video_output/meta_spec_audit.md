# Meta Placement Spec Audit — Cricket Market USA Promo Video
Generated: 2026-10-05

---

## 1. Existing Reel (1080x1920, 9:16)

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
| Dimensions | 1080x1920 | 1080x1920 | PASS |
| Duration | 00:00:20.00 | 1–60 s (Reels ad) | PASS |
| Frame rate | 30 fps | 23–60 fps | PASS |
| Video codec | h264 | H.264 | PASS |
| H.264 profile | High | Main recommended | WARN — High accepted but Main preferred |
| Pixel format | yuv420p(progressive) | yuv420p | PASS |
| Video bitrate | 1659 kb/s | ≥500 kb/s; 2500+ recommended | PASS (below 2500 kbps recommendation) |
| Audio codec | AAC | AAC | PASS |
| Audio sample rate | 44100 Hz | 44100 Hz | PASS |
| Audio bitrate | 196 kb/s | ≥128 kb/s | PASS |
| File size | 4,553 KB | ≤4 GB | PASS |

### Safe-zone analysis — Reels/Stories (1080x1920)
Safe content area: x=54–918 · y=268–1536  (864x1268)

| Element | Drawn at | Safe boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=28 | top safe y≥268 | WARN — overlapped by Reels header/Stories top bar |
| S2 title "Find new and used" | y=110 | top safe y≥268 | WARN — inside top 14% overlay zone |
| S3 sell card top | y=60 | top safe y≥268 | WARN — inside top 14% overlay zone |
| S2 grid bottom rows | y≈1870 | bottom safe y≤1536 | WARN — bottom grid rows inside overlay zone |
| S1/S4 headlines (centred) | y≈960–1220 | within safe zone | PASS |
| S4 URL / tagline | y≈1050–1095 | within safe zone | PASS |

**Overall Reels verdict:** Encoded spec passes all hard requirements.
Three safe-zone warnings (wordmark and scene-entry text near top; grid bottom rows).
These are decorative / transitional elements — key messaging (headlines, URL, CTA) is in the safe zone.
No re-render of the existing file is required; the warnings are noted for future iterations.

---

## 2. New Feed Ad (1080x1350, 4:5)

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
| Dimensions | 1080x1350 | 1080x1350 | PASS |
| Duration | 00:00:20.00 | 1–60 s | PASS |
| Frame rate | 30 fps | 23–60 fps | PASS |
| Video codec | h264 | H.264 | PASS |
| H.264 profile | Main | Main recommended | PASS |
| Pixel format | yuv420p(progressive) | yuv420p | PASS |
| Video bitrate | 2119 kb/s | ≥500 kb/s; 2500+ recommended | PASS (meets minimum) |
| Audio codec | AAC | AAC | PASS |
| Audio sample rate | 44100 Hz | 44100 Hz | PASS |
| Audio bitrate | 195 kb/s | ≥128 kb/s | PASS |
| File size | 5,670 KB | ≤4 GB | PASS |

### Safe-zone analysis — Feed (1080x1350)
Safe content area: x=54–1026 · y=67–1283  (972x1216)

| Element | Drawn at | Safe boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=80 | top safe y≥67 | PASS |
| S2 title "Find new and used" | y=80 | top safe y≥67 | PASS |
| S3 sell card top | y=80 | top safe y≥67 | PASS |
| S2 grid bottom rows | y≤1233 | bottom safe y≤1283 | PASS |
| S1/S4 headlines (centred) | y≈620–960 | within safe zone | PASS |
| S4 URL / tagline | y≈840–900 | within safe zone | PASS |

**Overall Feed ad verdict:** All elements within 5% safe zone. All hard specs met.

---

## 3. Audio (both files)
Narration and music are identical — extracted from the approved Reel final.
No content was altered.

---

## 4. Summary of actions taken
- Existing `cricket_market_vertical_1080x1920_final.mp4` preserved unchanged.
- New `cricket_market_feed_1080x1350_final.mp4` created with:
  - 4:5 aspect ratio canvas (1080x1350)
  - H.264 Main profile, no B-frames, CRF 16 (higher quality than original Reel)
  - Wordmark repositioned from y=28 to y=80 (clears Feed 5% safe zone)
  - Sell card top repositioned from y=60 to y=80
  - Audio muxed directly from approved Reel final (narration + music unchanged)
- Safe-zone preview PNGs generated for both formats, all 4 scenes.
- Nothing published.
