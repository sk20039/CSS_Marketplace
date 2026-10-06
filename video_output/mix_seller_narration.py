#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mix_seller_narration.py
Mix user-recorded seller tutorial narration into the silent tutorial videos.

Recording: video_output/_audio/seller 9.41.55 AM.mp4
  Duration: 37.01 s, mono AAC 48 kHz (Samsung Android, -0500)

Section boundaries detected via silencedetect (noise=-35 dB, min 0.40 s):

  S1   0.864 –  6.385  "Ready to sell your cricket gear?
                         Here's how to get started on Cricket Market USA."
  S2   6.891 – 11.131  "Go to cricketmarketusa.com and create a seller account.
                         Choose 'I'm selling', then enter your name, email, and a password."
  S3  12.097 – 15.341  "Check your inbox for a verification link, then sign back in."
  S4  16.224 – 21.002  "In your Seller Dashboard, connect Stripe to receive payouts —
                         and add a ship-from address so buyers know where their order ships from."
  S5  21.652 – 29.734  "Click 'New Listing', choose a category, set the condition and price,
                         and upload a few photos."
  S6  30.392 – 36.220  "Save as a draft to review, then hit Publish —
                         your listing goes live instantly."

Each section is trimmed with 0.20 s head / 0.20 s tail padding for
naturalness, then delayed to align with its scene start (+0.30 s lead-in).

S1 speech (5.52 s) slightly overruns the 5-second S1 scene; the sentence
finishes naturally as the register screen appears — no cut, no speed-up.

Audio processing applied to the final mix:
  - highpass f=80 Hz   (remove low-frequency handling noise)
  - loudnorm I=-16 LUFS / TP=-1.5 dBTP / LRA=11  (broadcast standard)

Outputs (separate from silent previews):
  video_output/seller_tutorial_wide_1920x1080_voiced.mp4
  video_output/seller_tutorial_vertical_1080x1920_voiced.mp4

Run:
    video_venv/Scripts/python video_output/mix_seller_narration.py
"""

import sys, os, subprocess, re

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()

OUTDIR   = os.path.dirname(os.path.abspath(__file__))
AUDIO_IN = os.path.join(OUTDIR, "_audio", "seller 9.41.55 AM.mp4")

# (tag, src_start, src_end, target_delay_s)
#   src boundaries include 0.20 s padding on each side
#   target_delay = scene_start + 0.30 s lead-in
SECTIONS = [
    # S1 extended to 6.5 s; speech (5.92 s) finishes before S2 begins — no overlap.
    # S2-S6 target delays shifted +1.5 s to match the extended video timeline.
    # S6 placed at 37.8 s; ends ~44.0 s; video holds final frame to 44.5 s.
    ("s1",  0.664,  6.585,  0.30),   # scene  0.0– 6.5 s
    ("s2",  6.691, 11.331,  6.80),   # scene  6.5–14.5 s
    ("s3", 11.897, 15.541, 14.80),   # scene 14.5–19.5 s
    ("s4", 16.024, 21.202, 19.80),   # scene 19.5–28.5 s
    ("s5", 21.452, 29.934, 28.80),   # scene 28.5–37.5 s
    ("s6", 30.192, 36.520, 37.80),   # scene 37.5–44.5 s
]

VIDEOS = [
    (
        "seller_tutorial_wide_1920x1080.mp4",
        "seller_tutorial_wide_1920x1080_voiced.mp4",
    ),
    (
        "seller_tutorial_vertical_1080x1920.mp4",
        "seller_tutorial_vertical_1080x1920_voiced.mp4",
    ),
]


def probe_duration(path):
    result = subprocess.run([FF, "-i", path], capture_output=True, text=True)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)",
                  result.stderr + result.stdout)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return 0.0


def build_filter(sections):
    """Return filter_complex string and the [final] output pad label."""
    parts   = []
    labels  = []

    for tag, src_s, src_e, delay_s in sections:
        delay_ms = int(round(delay_s * 1000))
        parts.append(
            f"[1:a]"
            f"atrim=start={src_s:.3f}:end={src_e:.3f},"
            f"asetpts=PTS-STARTPTS,"
            f"adelay={delay_ms}|{delay_ms}"
            f"[{tag}]"
        )
        labels.append(f"[{tag}]")

    n = len(sections)
    mix_in = "".join(labels)
    parts.append(
        f"{mix_in}amix=inputs={n}:duration=longest:normalize=0[mixed]"
    )
    # Gentle post-processing: remove low-end rumble, broadcast loudness
    parts.append(
        "[mixed]highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11[final]"
    )
    return "; ".join(parts)


def mix(video_in, video_out):
    bar = "=" * 58
    print(f"\n{bar}")
    print(f"  {os.path.basename(video_in)}")
    print(f"  → {os.path.basename(video_out)}")
    print(bar)

    fc = build_filter(SECTIONS)

    cmd = [
        FF, "-y",
        "-i", video_in,
        "-i", AUDIO_IN,
        "-filter_complex", fc,
        "-map", "0:v",
        "-map", "[final]",
        "-c:v", "copy",                 # preserve approved visuals exactly
        "-c:a", "aac", "-b:a", "128k",
        video_out,
    ]

    print("  Running ffmpeg …")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print("\nSTDERR (last 3 000 chars):")
        print(result.stderr[-3000:])
        raise RuntimeError(f"ffmpeg failed → {os.path.basename(video_out)}")

    dur  = probe_duration(video_out)
    size = os.path.getsize(video_out) // 1024
    print(f"  Duration : {dur:.2f} s")
    print(f"  Size     : {size:,} KB")
    print(f"  Path     : {video_out}")


def main():
    print(f"ffmpeg   : {FF}")
    print(f"recording: {AUDIO_IN}")

    if not os.path.exists(AUDIO_IN):
        print(f"\nERROR: recording not found:\n  {AUDIO_IN}")
        sys.exit(1)

    rec_dur = probe_duration(AUDIO_IN)
    print(f"rec dur  : {rec_dur:.2f} s")

    for src_name, dst_name in VIDEOS:
        vin  = os.path.join(OUTDIR, src_name)
        vout = os.path.join(OUTDIR, dst_name)
        if not os.path.exists(vin):
            print(f"\nERROR: silent video not found:\n  {vin}")
            print("Re-run  video_venv/Scripts/python video_output/make_seller_tutorial.py  first.")
            sys.exit(1)
        mix(vin, vout)

    bar = "=" * 58
    print(f"\n{bar}")
    print("  ALL DONE")
    print(bar)
    for _, dst_name in VIDEOS:
        print(f"  {os.path.join(OUTDIR, dst_name)}")
    print()


if __name__ == "__main__":
    main()
