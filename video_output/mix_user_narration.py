#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mix_user_narration.py
Replaces TTS narration with the user's own recording in both final MP4s.

Recording: _audio/WhatsApp Audio 2026-10-05 at 1.19.46 PM.mp4  (14.49 s, mono AAC)
Sentences detected via silencedetect at -35 dB / 0.3 s:
  s1  0.731 - 2.863  "Cricket gear deserves another innings."
  s2  3.897 - 6.310  "Find new and used cricket equipment."
  s3  7.479 - 10.321 "Have gear to sell? Create your listing."
  s4 11.297 - 13.554 "Buy. Sell. Keep playing."

Each sentence is trimmed and delayed to its scene start in the 20-second timeline:
  s1 ->  0.3 s    (scene 0-4 s)
  s2 ->  4.3 s    (scene 4-10 s)
  s3 -> 10.3 s    (scene 10-15 s)
  s4 -> 15.3 s    (scene 15-20 s)

Voice is normalised +2.5 dB (peak -3.5 -> -1 dB) and converted to stereo 44100 Hz.
Background music: atlasaudio-music-background-594872.mp3
  volume=0.14 (~-17 dB), 1.5 s fade-in/out, trimmed to 20 s.

Outputs (overwrite existing final videos):
  cricket_market_wide_1920x1080_final.mp4
  cricket_market_vertical_1080x1920_final.mp4

Run:
    video_venv/Scripts/python video_output/mix_user_narration.py
"""

import sys, os, subprocess, re

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()

OUTDIR    = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(OUTDIR, "_audio")
RECORDING = os.path.join(AUDIO_DIR, "WhatsApp Audio 2026-10-05 at 1.19.46 PM.mp4")
MUSIC     = os.path.join(OUTDIR, "atlasaudio-music-background-594872.mp3")

# (tag, src_start, src_end, target_delay_in_video)
SENTENCES = [
    ("s1",  0.731,  2.863,  0.3),   # scene 0-4 s
    ("s2",  3.897,  6.310,  4.3),   # scene 4-10 s
    ("s3",  7.479, 10.321, 10.3),   # scene 10-15 s
    ("s4", 11.297, 13.554, 15.3),   # scene 15-20 s
]

SCENE_ENDS   = {0.3: 4.0, 4.3: 10.0, 10.3: 15.0, 15.3: 20.0}
VOICE_GAIN   = "2.5dB"
MUSIC_VOLUME = 0.14
FADE_DUR     = 1.5

VIDEOS = [
    ("cricket_market_wide_1920x1080.mp4",     "cricket_market_wide_1920x1080_final.mp4"),
    ("cricket_market_vertical_1080x1920.mp4", "cricket_market_vertical_1080x1920_final.mp4"),
]


def run(cmd):
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )


def ff_duration(path):
    r = run([FF, "-i", path, "-f", "null", "-"])
    m = re.search(r"Duration:\s+(\d+):(\d+):([\d.]+)", r.stderr)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return None


def verify_stream(path):
    r = run([FF, "-i", path, "-f", "null", "-"])
    m = re.search(r"Stream.*Video.*?(\d{3,4})x(\d{3,4})", r.stderr)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def extract_segments():
    """Trim each sentence from the recording, normalise, convert to stereo WAV."""
    os.makedirs(AUDIO_DIR, exist_ok=True)
    segments = []
    all_ok = True

    for tag, src_start, src_end, target_start in SENTENCES:
        duration = src_end - src_start
        wav_path = os.path.join(AUDIO_DIR, f"user_{tag}.wav")

        cmd = [
            FF, "-y",
            "-i", RECORDING,
            "-ss", str(src_start),
            "-t",  str(duration),
            "-af", f"volume={VOICE_GAIN},aresample=44100",
            "-ac", "2",
            wav_path,
        ]
        r = run(cmd)
        if r.returncode != 0:
            print(f"  ERROR extracting {tag}:\n{r.stderr[-1000:]}")
            sys.exit(1)

        actual_dur = ff_duration(wav_path)
        window     = SCENE_ENDS[target_start] - target_start - 0.2
        ok         = actual_dur <= window
        flag       = "OK" if ok else "EXCEEDS-WINDOW"
        print(f"  {tag}  {actual_dur:.2f}s / {window:.1f}s window  [{flag}]  delay={target_start}s")
        if not ok:
            all_ok = False
        segments.append((tag, wav_path, target_start))

    if not all_ok:
        print("\n  One or more segments exceed their window.")
        sys.exit(1)

    return segments


def build_voice_mix(segments):
    """Assemble all sentence WAVs into a single 20-second stereo mix."""
    mix_path = os.path.join(AUDIO_DIR, "user_narration_mix.wav")

    inputs, delays = [], []
    for i, (tag, wav, start_s) in enumerate(segments):
        inputs += ["-i", wav]
        ms = int(start_s * 1000)
        delays.append(f"[{i}]adelay={ms}|{ms}[d{i}]")

    n      = len(segments)
    mix_in = "".join(f"[d{i}]" for i in range(n))
    fc     = "; ".join(delays) + \
             f"; {mix_in}amix=inputs={n}:duration=longest:normalize=0[out]"

    cmd = (
        [FF] + inputs
        + ["-filter_complex", fc,
           "-map", "[out]",
           "-t", "20",
           "-ar", "44100",
           "-ac", "2",
           "-y", mix_path]
    )
    r = run(cmd)
    if r.returncode != 0:
        print(f"  ffmpeg mix error:\n{r.stderr[-2000:]}")
        sys.exit(1)

    dur = ff_duration(mix_path)
    print(f"  Voice mix: {dur:.2f}s  -> {mix_path}")
    return mix_path


def mix_and_mux(voice_mix, video_in, video_out):
    """Combine voice + music, mux into the output video (video stream copied)."""
    fade_out_start = 20.0 - FADE_DUR

    fc = (
        f"[2:a]atrim=0:20,"
        f"volume={MUSIC_VOLUME},"
        f"afade=t=in:st=0:d={FADE_DUR},"
        f"afade=t=out:st={fade_out_start}:d={FADE_DUR}"
        f"[music];"
        f"[1:a][music]amix=inputs=2:duration=longest:normalize=0[out]"
    )

    cmd = [
        FF, "-y",
        "-i", video_in,   # 0: silent video
        "-i", voice_mix,  # 1: voice track
        "-i", MUSIC,      # 2: background music
        "-filter_complex", fc,
        "-map", "0:v",
        "-map", "[out]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ac", "2",
        "-t", "20",
        video_out,
    ]
    r = run(cmd)
    if r.returncode != 0:
        print(f"  ffmpeg error for {os.path.basename(video_out)}:\n{r.stderr[-3000:]}")
        sys.exit(1)

    dur    = ff_duration(video_out)
    w, h   = verify_stream(video_out)
    kb     = os.path.getsize(video_out) // 1024
    dim_ok = "OK" if (w, h) in [(1920, 1080), (1080, 1920)] else "MISMATCH"

    rv    = run([FF, "-i", video_out, "-af", "volumedetect", "-vn", "-f", "null", "-"])
    mean_m = re.search(r"mean_volume:\s+([\-\d.]+)", rv.stderr)
    max_m  = re.search(r"max_volume:\s+([\-\d.]+)", rv.stderr)
    mean_db = mean_m.group(1) if mean_m else "?"
    max_db  = max_m.group(1) if max_m else "?"

    print(f"  {w}x{h} [{dim_ok}]  {dur:.2f}s  {kb:,} KB")
    print(f"  Audio: mean {mean_db} dB  peak {max_db} dB")


def main():
    print("=" * 58)
    print("  Cricket Market USA -- User Narration Mix")
    print("=" * 58)

    for path, label in [(RECORDING, "recording"), (MUSIC, "music MP3")]:
        if not os.path.exists(path):
            print(f"\n  MISSING {label}: {path}")
            sys.exit(1)
        dur = ff_duration(path)
        print(f"  {label}: {dur:.2f}s")

    print()
    print("[1/3] Extracting and normalising sentence segments ...")
    segments = extract_segments()

    print("\n[2/3] Building 20-second voice mix ...")
    voice_mix = build_voice_mix(segments)

    print("\n[3/3] Mixing with music and muxing into videos ...")
    for vname_in, vname_out in VIDEOS:
        vin  = os.path.join(OUTDIR, vname_in)
        vout = os.path.join(OUTDIR, vname_out)
        if not os.path.exists(vin):
            print(f"  SKIP (not found): {vin}")
            continue
        print(f"\n  -> {vname_out}")
        mix_and_mux(voice_mix, vin, vout)

    print("\n" + "=" * 58)
    print("  Done. Local preview only -- not published.")
    print("=" * 58)


if __name__ == "__main__":
    main()
