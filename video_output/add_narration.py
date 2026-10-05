#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add_narration.py
Adds Microsoft David (Windows SAPI) narration to both promo MP4s.

Voice: Microsoft David Desktop (Windows built-in, commercially usable
       under the Windows OS licence — no separate service involved).
Audio tool: ffmpeg bundled with imageio-ffmpeg (already in video_venv).
No network calls. Local preview only.

Usage:
    video_venv/Scripts/python video_output/add_narration.py
"""

import sys, os, subprocess, re, textwrap

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()

OUTDIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Narration — one line per video section.
# Text is written for SAPI pronunciation: "dot com" reads clearly,
# short sentences leave natural gaps within each section window.
#
# (tag, spoken text, start_sec, section_end_sec)
# Start 0.5 s after section opens (clears the visual fade-in).
# ---------------------------------------------------------------------------
LINES = [
    # Start 0.3 s into each section (clears visual fade-in).
    # S4 uses only the tagline — the logo text is already on screen.
    ("s1", "Cricket gear deserves another innings.",  0.3,  4.0),
    ("s2", "Find new and used cricket equipment.",    4.3, 10.0),
    ("s3", "Have gear to sell? Create your listing.", 10.3, 15.0),
    ("s4", "Buy. Sell. Keep playing.",                15.3, 20.0),
]

VIDEOS = [
    "cricket_market_wide_1920x1080.mp4",
    "cricket_market_vertical_1080x1920.mp4",
]

DAVID_VOICE = "Microsoft David Desktop"
SAPI_RATE   = 2    # -10..10; 2 = brisk but clear; keeps every line inside its window


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run(cmd):
    return subprocess.run(
        cmd, capture_output=True,
        text=True, encoding="utf-8", errors="replace"
    )


def ff_duration(path):
    """Return duration in seconds by parsing ffmpeg -i stderr."""
    r = run([FF, "-i", path, "-f", "null", "-"])
    m = re.search(r"Duration:\s+(\d+):(\d+):([\d.]+)", r.stderr)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return None


def verify_stream(path):
    """Return (width, height) of the first video stream."""
    r = run([FF, "-i", path, "-f", "null", "-"])
    m = re.search(r"Stream.*Video.*?(\d{3,4})x(\d{3,4})", r.stderr)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


# ---------------------------------------------------------------------------
# Step 1 — generate per-section WAV files via Windows SAPI
# ---------------------------------------------------------------------------

def generate_wavs():
    audio_dir = os.path.join(OUTDIR, "_audio")
    os.makedirs(audio_dir, exist_ok=True)

    # Build a single PowerShell script that writes all four WAVs
    script_parts = [
        "Add-Type -AssemblyName System.Speech",
        f'$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        f'$synth.SelectVoice("{DAVID_VOICE}")',
        f"$synth.Rate = {SAPI_RATE}",
        "$synth.Volume = 100",
    ]
    paths = []
    for tag, text, _, _ in LINES:
        wav = os.path.join(audio_dir, f"{tag}.wav").replace("/", "\\")
        safe = text.replace("'", "''")
        script_parts += [
            f'$synth.SetOutputToWaveFile("{wav}")',
            f"$synth.Speak('{safe}')",
            f'Write-Host "wrote {tag}.wav"',
        ]
        paths.append((tag, wav))
    script_parts.append("$synth.SetOutputToDefaultAudioDevice()")

    ps_path = os.path.join(audio_dir, "gen_tts.ps1")
    with open(ps_path, "w", encoding="utf-8") as fh:
        fh.write("\r\n".join(script_parts))

    print("  Running Windows SAPI (Microsoft David Desktop) ...")
    r = run([
        "powershell", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", ps_path,
    ])
    if r.returncode != 0:
        print("  PowerShell error:")
        print(r.stderr[-2000:])
        sys.exit(1)
    print(r.stdout.strip())

    # Validate durations against section windows
    results = []
    all_ok = True
    for (tag, wav), (_, text, start_s, end_s) in zip(paths, LINES):
        dur     = ff_duration(wav)
        window  = end_s - start_s - 0.2   # 0.2 s margin before section end
        if dur is None:
            print(f"  ERROR: could not read duration for {tag}.wav")
            sys.exit(1)
        ok = dur <= window
        flag = "OK" if ok else "EXCEEDS-WINDOW"
        print(f"  {tag}  {dur:.2f}s / {window:.1f}s window  [{flag}]  \"{text[:48]}\"")
        if not ok:
            all_ok = False
        results.append((tag, wav, start_s, dur))

    if not all_ok:
        print("\n  One or more lines exceed their window. Increase SAPI_RATE or shorten text.")
        sys.exit(1)

    return results


# ---------------------------------------------------------------------------
# Step 2 — assemble 20-second stereo mix with ffmpeg adelay + amix
# ---------------------------------------------------------------------------

def build_mix(wavs):
    mix_path = os.path.join(OUTDIR, "_audio", "narration_mix.wav")

    # Each WAV is delayed by its start time (ms), then all are summed.
    inputs, delay_filters = [], []
    for i, (tag, wav, start_s, _) in enumerate(wavs):
        inputs += ["-i", wav]
        delay_ms = int(start_s * 1000)
        delay_filters.append(f"[{i}]adelay={delay_ms}|{delay_ms}[d{i}]")

    n = len(wavs)
    mix_in  = "".join(f"[d{i}]" for i in range(n))
    fc      = "; ".join(delay_filters) + \
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
        print("  ffmpeg mix error:")
        print(r.stderr[-3000:])
        sys.exit(1)

    dur = ff_duration(mix_path)
    print(f"  Mix track: {dur:.2f}s  -> {mix_path}")
    return mix_path


# ---------------------------------------------------------------------------
# Step 3 — mux mix into each video (video stream copied byte-for-byte)
# ---------------------------------------------------------------------------

def mux(video_in, mix_wav):
    base_in = os.path.basename(video_in)
    out_name = base_in.replace(".mp4", "_voiced.mp4")
    video_out = os.path.join(OUTDIR, out_name)

    cmd = [
        FF, "-y",
        "-i", video_in,
        "-i", mix_wav,
        "-map", "0:v",        # take video from input 0
        "-map", "1:a",        # take audio from the mix
        "-c:v", "copy",       # no re-encode — preserves dimensions exactly
        "-c:a", "aac",
        "-b:a", "192k",
        "-ac", "2",
        "-t", "20",
        video_out,
    ]
    r = run(cmd)
    if r.returncode != 0:
        print(f"  ffmpeg mux error for {out_name}:")
        print(r.stderr[-3000:])
        sys.exit(1)

    kb  = os.path.getsize(video_out) // 1024
    dur = ff_duration(video_out)
    w, h = verify_stream(video_out)
    print(f"  {out_name}")
    print(f"    {w}x{h}  {dur:.2f}s  {kb:,} KB")
    return video_out, w, h


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 56)
    print("  Cricket Market USA -- Add Narration")
    print(f"  Voice: {DAVID_VOICE}  (Windows SAPI, Rate={SAPI_RATE})")
    print("=" * 56)

    print("\n[1/3] Generating per-section WAV files ...")
    wavs = generate_wavs()

    print("\n[2/3] Building 20-second audio mix ...")
    mix = build_mix(wavs)

    print("\n[3/3] Muxing audio into videos ...")
    outputs = []
    for vname in VIDEOS:
        vin = os.path.join(OUTDIR, vname)
        if not os.path.exists(vin):
            print(f"  SKIP (not found): {vin}")
            continue
        result = mux(vin, mix)
        outputs.append(result)

    print("\n" + "=" * 56)
    print("  OUTPUT (local preview only — not published)")
    print("=" * 56)
    for path, w, h in outputs:
        kb = os.path.getsize(path) // 1024
        print(f"  {path}")
        print(f"  {w}x{h}  {kb:,} KB")
        print()

    print("Audio rights note:")
    print("  Voice: Microsoft David Desktop -- Windows OS built-in.")
    print("  Usable commercially under your Windows licence.")
    print("  No background music. No third-party audio assets.")


if __name__ == "__main__":
    main()
