# Cricket Market USA — Promo Video Generator

Generates two 20-second MP4 promotional previews from assets already in the repo.
No paid services, no network calls, no production data touched.

## Output files

| File | Format | Use |
|---|---|---|
| `cricket_market_wide_1920x1080.mp4` | 1920×1080 | Website hero / YouTube |
| `cricket_market_vertical_1080x1920.mp4` | 1080×1920 | Instagram / Facebook Reels |

Both: 20 s · 30 fps · H.264 · yuv420p · exact pixel dimensions (no macro-block padding).

## Section timing

| Time | Content |
|---|---|
| 0–4 s | Cricket hero image (Ken Burns zoom) — "Cricket gear deserves another innings." |
| 4–10 s | Equipment grid (bat, helmet, pads, gloves, kit bag, accessories) — "Find new and used cricket equipment." |
| 10–15 s | Bat image card + "Have gear to sell? Create your listing." |
| 15–20 s | CricketMarket wordmark — "Buy. Sell. Keep playing." · cricketmarketusa.com |

## Prerequisites

Create an **isolated** virtual environment (keep dependencies out of the app):

```bash
python -m venv video_venv
video_venv/Scripts/python -m pip install "imageio[ffmpeg]" Pillow
```

`imageio[ffmpeg]` downloads a portable ffmpeg binary automatically (~40 MB, stored in
`~/.imageio/`). No system-level ffmpeg required.

## Reproduce

```bash
# from repo root
video_venv/Scripts/python video_output/generate_promo.py
```

Output MP4s are written to `video_output/`. The script reads only:
- `frontend/public/hero-cricket-bg.png`
- `frontend/public/categories/*.webp`

No production data, no credentials, no network requests.

## Assets used

All source assets are already committed to the repo under `frontend/public/`.
No external images, stock footage, or paid services were used.
No audio track — add one separately before publishing if desired.

## Do not commit

- `video_venv/` — isolated venv, machine-specific binaries
- `*.mp4` — generated artefacts, large binaries
- `preview_*.png` — temporary spot-check frames
