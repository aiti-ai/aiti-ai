#!/usr/bin/env python3
"""Regenerate the bundled aiti play demo (TTS voice + synthesized bed + LRC/SRT/VTT).

Requirements: edge-tts, ffmpeg/ffprobe, ImageMagick (`convert`) optional.
All output is original/generated for this repository; no third-party audio is bundled.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
VOICE = "en-US-AriaNeural"
LEAD = 0.50
GAP = 0.65
LINES = [
    "Hello, I'm aiti desktop widget.",
    "I turn any web page into a floating, transparent desktop layer.",
    "Play a song, follow the lyrics, and keep the progress bar right here.",
    "Bring your own audio and LRC file. Let's make the desktop sing.",
]
CHORDS = [
    (220.00, 261.63, 329.63),   # Am
    (174.61, 220.00, 261.63),   # F
    (130.81, 164.81, 196.00),   # C
    (196.00, 246.94, 293.66),   # G
]


def run(args: list[str]) -> None:
    subprocess.run(args, check=True)


def duration(path: Path) -> float:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1", str(path),
    ], text=True)
    return float(out.strip())


def stamp(seconds: float, sep: str = ".") -> str:
    m = int(seconds // 60)
    s = seconds - m * 60
    whole = int(s)
    frac = int(round((s - whole) * 1000))
    if frac >= 1000:
        whole += 1
        frac -= 1000
    return f"{m:02d}:{whole:02d}{sep}{frac:03d}"


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    (ROOT / "script.txt").write_text("\n".join(LINES) + "\n", encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="aiti-play-demo-") as tmp:
        tmp = Path(tmp)
        line_files = []
        durations = []
        for i, text in enumerate(LINES):
            mp3 = tmp / f"line{i}.mp3"
            wav = tmp / f"line{i}.wav"
            run(["edge-tts", "--voice", VOICE, "--text", text, "--write-media", str(mp3), "--no-progress"])
            run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3),
                 "-af", "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-40dB:stop_periods=-1:stop_duration=0.08:stop_threshold=-40dB",
                 "-ar", "44100", "-ac", "2", str(wav)])
            line_files.append(wav)
            durations.append(duration(wav))

        silence = tmp / "silence.wav"
        run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", f"anullsrc=r=44100:cl=stereo", "-t", f"{GAP:.3f}", "-c:a", "pcm_s16le", str(silence)])
        lead = tmp / "lead.wav"
        run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", f"anullsrc=r=44100:cl=stereo", "-t", f"{LEAD:.3f}", "-c:a", "pcm_s16le", str(lead)])
        # The LRC first line starts at LEAD; the voice track must have the same lead
        # silence, otherwise every lyric lags behind the voice by exactly LEAD.
        entries = [lead]
        for i, wav in enumerate(line_files):
            entries.append(wav)
            if i < len(line_files) - 1:
                entries.append(silence)
        list_file = tmp / "list.txt"
        list_file.write_text("".join(f"file '{p}'\n" for p in entries), encoding="utf-8")
        voice = tmp / "voice.wav"
        run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(list_file), "-c:a", "pcm_s16le", str(voice)])

        starts = []
        cursor = LEAD
        for i, d in enumerate(durations):
            starts.append(cursor)
            cursor += d + (GAP if i < len(durations) - 1 else 0)
        total = cursor + 1.0

        # LRC
        lrc = [
            "[ti:aiti desktop widget]",
            "[ar:aiti]",
            "[al:desktop demo]",
            "[by:aiti-ai]",
            "[offset:0]",
            "[00:00.00]♪",
        ]
        for start, text in zip(starts, LINES):
            lrc.append(f"[{stamp(start)}]{text}")
        (ASSETS / "aiti-intro.lrc").write_text("\n".join(lrc) + "\n", encoding="utf-8")

        # SRT / VTT (end = next line start, last = total)
        ends = [starts[i + 1] - 0.05 for i in range(len(starts) - 1)] + [starts[-1] + durations[-1] - 0.02]
        cue_rows = [(0.0, starts[0] - 0.04, "♪")] + list(zip(starts, ends, LINES))
        srt = []
        vtt = ["WEBVTT", ""]
        for n, (st, en, text) in enumerate(cue_rows, 1):
            srt += [str(n), f"{stamp(st, ',')} --> {stamp(en, ',')}", text, ""]
            vtt += [f"{stamp(st)} --> {stamp(en)}", text, ""]
        (ASSETS / "aiti-intro.srt").write_text("\n".join(srt), encoding="utf-8")
        (ASSETS / "aiti-intro.vtt").write_text("\n".join(vtt), encoding="utf-8")

        # Synthesized ambient bed (Am - F - C - G), no external samples.
        chord_files = []
        for i, freqs in enumerate(CHORDS):
            expr = "0.045*(0.62+0.38*sin(2*PI*0.11*t))*(" + "+".join(f"sin(2*PI*{f:.3f}*t)" for f in freqs) + ")"
            out = tmp / f"chord{i}.wav"
            run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                 "-i", f"aevalsrc={expr}:s=44100:d=4", "-ac", "2",
                 "-af", "afade=t=in:d=0.8,afade=t=out:st=3.2:d=0.8", "-c:a", "pcm_s16le", str(out)])
            chord_files.append(out)
        chord_list = tmp / "chords.txt"
        chord_list.write_text("".join(f"file '{p}'\n" for p in chord_files), encoding="utf-8")
        bed = tmp / "bed.wav"
        run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(chord_list), "-c:a", "pcm_s16le", str(bed)])

        mix = tmp / "mix.wav"
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(voice),
             "-stream_loop", "-1", "-i", str(bed),
             "-filter_complex",
             "[1:a]volume=0.16,lowpass=f=1500,aecho=0.8:0.6:80|160:0.16|0.08[bg];"
             "[0:a][bg]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]",
             "-map", "[out]", "-t", f"{total:.3f}", "-ar", "44100", "-ac", "2", str(mix)])
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mix), "-c:a", "libmp3lame", "-b:a", "160k",
             str(ASSETS / "aiti-intro.mp3")])

        # Cover (optional ImageMagick).
        if shutil.which("convert"):
            cover_svg = tmp / "cover.svg"
            cover_svg.write_text("""<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#241b4f"/><stop offset=".55" stop-color="#15132b"/><stop offset="1" stop-color="#0a1626"/>
</linearGradient><radialGradient id="h" cx=".35" cy=".3" r=".7">
<stop offset="0" stop-color="#a78bfa" stop-opacity=".55"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/>
</radialGradient></defs>
<rect width="640" height="640" fill="url(#g)"/><rect width="640" height="640" fill="url(#h)"/>
<circle cx="320" cy="260" r="86" fill="none" stroke="#c4b5fd" stroke-width="10" opacity=".9"/>
<circle cx="320" cy="260" r="52" fill="none" stroke="#22d3ee" stroke-width="10" opacity=".8"/>
<text x="320" y="450" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="54" font-weight="700" fill="#f8f8ff">aiti</text>
<text x="320" y="500" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#c4b5fd" letter-spacing="4">DESKTOP WIDGET</text>
</svg>""", encoding="utf-8")
            run(["convert", "-background", "none", str(cover_svg), str(ASSETS / "cover.png")])

    print(json.dumps({
        "audio": str(ASSETS / "aiti-intro.mp3"),
        "duration": round(duration(ASSETS / "aiti-intro.mp3"), 3),
        "lines": len(LINES),
    }, indent=2))


if __name__ == "__main__":
    main()
