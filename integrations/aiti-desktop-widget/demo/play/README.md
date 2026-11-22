# aiti play — transparent song / lyric widget demo

A self-contained, generic **transparent music player** page for `aiti-desktop-widget`
(and any normal browser). It plays an audio URL, parses a lyric file, highlights the
current line, shows a seekable progress bar, and looks good at 900×320 or down to
600×200.

```
play.html?file=...&lyrics=...&title=...&artist=...&cover=...
```

## Quick start

```bash
cd integrations/aiti-desktop-widget/demo/play
node serve.mjs                 # http://127.0.0.1:18080/play.html (Range-capable)
```

Open <http://127.0.0.1:18080/play.html>; the bundled generated intro plays without any
query parameters. For the widget shell:

```bash
aiti-desktop-widget \
  --html "/abs/path/demo/play/play.html?file=assets/aiti-intro.mp3&lyrics=assets/aiti-intro.lrc&title=aiti%20intro&artist=aiti&cover=assets/cover.png" \
  --width 900 --height 320 --transparent true
```

`--html '<file>[?query]'` forwards the query string to the page (the file itself is
served by the shell's loopback static server, including `Range` support). If you use an
older shell without query forwarding, start `serve.mjs` and pass `--url
'http://127.0.0.1:18080/play.html?...'` instead.

## Query parameters

| Param | Aliases | Meaning |
|---|---|---|
| `file` | `audio`, `src` | audio URL (mp3 / m4a / wav / ogg; relative or absolute) |
| `lyrics` | `lrc`, `srt`, `vtt`, `subtitle` | lyric file; format is detected by extension |
| `title` | — | override title (LRC `[ti:]` is fallback) |
| `artist` | — | override artist (LRC `[ar:]` is fallback) |
| `cover` | — | cover image URL |
| `theme` | — | `dark` (default) or `light` |
| `bg` | — | `transparent` (default), `none`, or any CSS background value |
| `bare` | — | `1` = remove the card background/border (text/cover only) |
| `autoplay` | — | **default `1`** (start on open); `0` disables. Browsers may still require a click; the page then shows the play state |
| `layout` | — | `auto` (default; one-line mode when height ≤220px), `card`, or `line` |
| `loop` | — | `1` loops the audio |
| `volume` | — | `0..1` initial volume |

Examples:

```text
play.html?file=assets/aiti-intro.mp3&lyrics=assets/aiti-intro.lrc
play.html?file=assets/aiti-intro.mp3&lyrics=assets/aiti-intro.srt&theme=light
play.html?file=assets/aiti-intro.mp3&lyrics=assets/aiti-intro.vtt&bare=1&theme=light
play.html?file=https://example.com/song.mp3&lyrics=song.lrc&title=My%20Song&artist=Me
```

## Lyrics formats

### LRC (primary)

Standard LRC with metadata, multiple timestamps per line and optional enhanced word tags:

```lrc
[ti:Demo Song]
[ar:aiti]
[al:Demo album]
[offset:0]
[00:00.00]♪
[00:00.50]Hello, I'm aiti desktop widget.
[00:04.27]I turn any web page into a floating, transparent desktop layer.
[00:09.86]Play a song, follow the lyrics, and keep the progress bar right here.
```

- One line may carry several `[mm:ss.xx]` stamps.
- `<mm:ss.xx>` word-level tags are stripped (line-level timing is used).
- `[offset:+/-ms]` shifts all timestamps (`+` makes lyrics appear earlier).
- `[ti:]`, `[ar:]`, `[al:]` fill title/artist/album when query params are absent.

### SRT / VTT

Standard SubRip and WebVTT cue blocks are accepted (`.srt`, `.vtt`). Markup tags are
stripped; the cue start time becomes the lyric line time.

### Plain text

Any other extension (or a timestamp-less LRC) is treated as plain text: non-empty lines
are distributed evenly across the audio duration.

## Behavior

- Active line is computed by binary search; adjacent lines are dimmed.
- Click a lyric line to seek to it.
- Click/drag the progress bar; keyboard `←`/`→` seeks ±5s, `Home`/`End` jumps, `Space`
  toggles play.
- `⌘/Ctrl` not required; buttons are keyboard-focusable.
- The page is transparent by default (`html,body{background:transparent}`); use `bare=1`
  to remove the translucent card entirely, or `bg=<color>` for a solid card.
- **One-line / marquee mode**: when the window is short (height ≤220px, or `layout=line`),
  the card switches to a single lyric line. Long lines scroll horizontally with the line
  progress; a **text-width progress fill covers the current lyric** from left to right
  (karaoke-style, same width as the text — not a full-width bar). Only the play/pause, lyric,
  time and mute controls remain.
- Missing lyrics/audio show an inline status, not a crash.
- **No sound?** Check the speaker button (mute), pass `volume=1` explicitly, and check the
  OS output device. Linux shells launched from SSH/agents fill the PipeWire/Pulse env from
  `/run/user/<uid>` automatically; if the default sink is a disconnected Bluetooth device,
  switch the system sink.

## Bundled sample

`assets/aiti-intro.*` is generated for this repository:

- text: `script.txt` (a short English self-introduction)
- voice: `edge-tts` (en-US-AriaNeural), one clip per line
- bed: a synthesized Am–F–C–G pad (ffmpeg sine oscillators; no third-party audio)
- cover: generated SVG → PNG
- LRC + SRT + VTT derived from the exact line start times

Regenerate with:

```bash
python3 make-demo.py       # needs edge-tts, ffmpeg/ffprobe, ImageMagick (cover optional)
```

No third-party song/recording is bundled. For a real song, point `file`/`lyrics` at your
own (or a properly licensed) files.

## Why self-contained?

Existing open-source HTML5 players (e.g. `Pekly/modern-html5-music-player`,
`AmplitudeJS`, `Able Player`, `lrc-kit`) are good references, but most focus on a full
music app, do not parse LRC + SRT/VTT in one place, and are not designed as a tiny
transparent desktop widget. This page is dependency-free (one HTML file + one static
server) and intentionally generic.

## Serving notes

Audio seeking requires HTTP `Range` support. `node serve.mjs` and the widget's `--html`
server both implement it; Python's `http.server` does not. Remote lyrics need CORS on the
lyrics origin (audio elements do not require CORS for ordinary playback).
