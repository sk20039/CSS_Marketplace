# Meta Placement Spec Audit — Cricket Market USA Promo Video
Generated: 2026-10-05  |  Revised with Reels/Stories separation and corrected safe-zone boundaries

---

## Safe-zone reference (current Meta official guidance)

| Placement | Top | Bottom | Left | Right | Notes |
|---|---|---|---|---|---|
| Instagram Reels ad (9:16) | 14% (268 px) | **35% (672 px)** | 5% (54 px) | **15% (162 px)** | Action icon column on right; large caption+actions area at bottom |
| Instagram Stories ad (9:16) | 14% (268 px) | 20% (384 px) | 5% (54 px) | 5% (54 px) | Send Message bar at bottom; no dedicated icon column |

Safe content rectangles for 1080x1920 canvas:
- Reels:   x=54–918,  y=268–**1248**  (864x980 px)
- Stories: x=54–1026, y=268–**1536**  (972x1268 px)

> **Correction vs. prior audit:** The earlier combined "Reels/Stories" row applied the Stories
> bottom boundary (20% = y≤1536) to Reels. Reels' bottom unsafe zone is 35% (bottom safe
> boundary y=1248). Content between y=1248 and y=1536 appears safe by the Story boundary
> but is overlaid by Reels interface elements (caption, audio label, action icons).
> Additionally, the prior audit stated "key messaging (headlines, URL, CTA) is in the safe
> zone" while simultaneously marking the S2 scene title — which is key messaging — as WARN.
> Both errors are corrected below.

---

## 1. Original Reel (preserved unchanged)
File: `cricket_market_vertical_1080x1920_final.mp4`

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
| Dimensions | 1080x1920 | 1080x1920 | PASS |
| Duration | 00:00:20.00 | 1–60 s (Reels) | PASS |
| Frame rate | 30 fps | 23–60 fps | PASS |
| Video codec | h264 | H.264 | PASS |
| H.264 profile | High | Main recommended | **WARN**  — High accepted but Main preferred |
| Pixel format | yuv420p(progressive) | yuv420p | PASS |
| Video bitrate | 1659 kb/s | ≥500 kb/s; 2500+ recommended | **WARN**  — above minimum, below recommendation |
| Audio codec | AAC | AAC | PASS |
| Audio rate | 44100 Hz | 44100 Hz | PASS |
| Audio bitrate | 196 kb/s | ≥128 kb/s | PASS |
| File size | 4,553 KB | ≤4 GB | PASS |

### Safe-zone analysis — original Reel (Reels placement)
Safe rectangle: x=54–918, y=268–**1248**

| Element | Drawn at | Boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=28 | top safe y≥268 | **WARN** — inside top 14% (268 px) profile/handle overlay |
| S2 scene title "Find new and used" | y=110 | top safe y≥268 | **WARN** — inside top 14% overlay; this IS key messaging |
| S3 sell card top | y=60 | top safe y≥268 | **WARN** — inside top 14% overlay |
| S2 grid bottom rows | y≈1870 | bottom safe y≤1248 | **FAIL** — 622 px inside Reels bottom unsafe zone |
| S1 subtitle "USA Cricket Equipment Marketplace" | y≈1210 | bottom safe y≤1248 | PASS (38 px margin) |
| S1 "Cricket gear deserves / another innings." | y=1030–1108 | within safe zone | PASS |
| S4 "CricketMarket / Buy. Sell. Keep playing." | y≈833–1005 | within safe zone | PASS |
| S4 URL "cricketmarketusa.com" | y≈1023 | within safe zone | PASS |

### Safe-zone analysis — original Reel (Stories placement)
Safe rectangle: x=54–1026, y=268–**1536**

| Element | Drawn at | Boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=28 | top safe y≥268 | **WARN** — inside top 14% profile/time overlay |
| S2 scene title "Find new and used" | y=110 | top safe y≥268 | **WARN** — inside top 14% overlay |
| S3 sell card top | y=60 | top safe y≥268 | **WARN** — inside top 14% overlay |
| S2 grid bottom rows | y≈1870 | bottom safe y≤1536 | **WARN** — 334 px inside Stories bottom unsafe zone |
| All headline / URL / CTA content | y=1023–1210 | within safe zone | PASS |

**Original Reel verdict:** Four WARN/FAIL items across Reels placement. No re-render of the
original file is performed; a corrected ad version is provided separately.

---

## 2. Corrected Reel Ad (new file)
File: `cricket_market_reel_1080x1920_corrected.mp4`
All key content repositioned inside Reels safe zone (y=268–1248), which automatically
satisfies the Stories safe zone (y=268–1536).

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
| Dimensions | 1080x1920 | 1080x1920 | PASS |
| Duration | 00:00:20.00 | 1–60 s | PASS |
| Frame rate | 30 fps | 23–60 fps | PASS |
| Video codec | h264 | H.264 | PASS |
| H.264 profile | Main | Main recommended | PASS |
| Pixel format | yuv420p(progressive) | yuv420p | PASS |
| Video bitrate | 2166 kb/s | ≥500 kb/s; 2500+ recommended | **WARN**  — above minimum; low-motion content at CRF 16 |
| Audio codec | AAC | AAC | PASS |
| Audio rate | 44100 Hz | 44100 Hz | PASS |
| Audio bitrate | 195 kb/s | ≥128 kb/s | PASS |
| File size | 5,786 KB | ≤4 GB | PASS |

### Safe-zone analysis — corrected Reel (Reels placement)
Safe rectangle: x=54–918, y=268–1248

| Element | Repositioned to | Boundary | Status |
|---|---|---|---|
| Wordmark "CricketMarket" | y=280 (was 28) | top safe y≥268 | PASS (12 px margin) |
| S2 scene title "Find new and used" | y=280 (was 110) | top safe y≥268 | PASS |
| S3 sell card top | y=280 (was 60) | top safe y≥268 | PASS |
| S2 grid bottom rows | y≤1240 (was ≈1870) | bottom safe y≤1248 | PASS (8 px margin) |
| S1 "Cricket gear deserves / another innings." | y=930–1096 | within safe zone | PASS |
| S1 subtitle "USA Cricket Equipment Marketplace" | y≈1132 | bottom safe y≤1248 | PASS (116 px margin) |
| S3 "Have gear to sell? / Create your listing." | y=832–994 | within safe zone | PASS |
| S3 "Free * Secure * Fast payouts" | y≈1028 | within safe zone | PASS |
| S4 "CricketMarket / Buy. Sell. Keep playing." | y≈833–1005 | within safe zone | PASS |
| S4 URL "cricketmarketusa.com" | y≈1023 | within safe zone | PASS |

### Safe-zone analysis — corrected Reel (Stories placement)
Safe rectangle: x=54–1026, y=268–1536
All elements already comply with Reels safe zone (y≤1248), which is more restrictive than
Stories (y≤1536). No additional Stories-specific violations.

| Element | Drawn at | Boundary | Status |
|---|---|---|---|
| All repositioned elements | y=280–1240 | Stories safe y≤1536 | PASS — cleared by Reels constraint |

---

## 3. Feed Ad (1080x1350, 4:5, unchanged)
File: `cricket_market_feed_1080x1350_final.mp4`

### Encoded properties
| Property | Value | Meta spec | Status |
|---|---|---|---|
| Dimensions | 1080x1350 | 1080x1350 | PASS |
| Duration | 00:00:20.00 | 1–60 s | PASS |
| Frame rate | 30 fps | 23–60 fps | PASS |
| H.264 profile | Main | Main recommended | PASS |
| Video bitrate | 2119 kb/s | ≥500 kb/s; 2500+ recommended | **WARN**  — low-motion content; visual quality high at CRF 16 |
| Audio | AAC 44100 Hz 195 kb/s | AAC ≥128 kb/s | PASS |
| File size | 5,670 KB | ≤4 GB | PASS |

Safe zone (5% inset all sides): x=54–1026, y=67–1283. All elements PASS — see prior audit.

---

## 4. Audio (all files)
Narration and music are identical across all three files — extracted directly from the
approved `cricket_market_vertical_1080x1920_final.mp4`. No content altered.

---

## 5. Summary
| File | Reels safe-zone | Stories safe-zone | Notes |
|---|---|---|---|
| `cricket_market_vertical_1080x1920_final.mp4` | 4 WARN/FAIL | 3 WARN | Original; preserved unchanged |
| `cricket_market_reel_1080x1920_corrected.mp4` | **All PASS** | **All PASS** | Corrected ad version |
| `cricket_market_feed_1080x1350_final.mp4` | N/A (4:5 Feed) | N/A | All PASS for Feed placement |

Nothing published. All files are local only.
