# aiti-desktop-widget

A business-agnostic desktop widget shell: frameless, transparent, always-on-top, optionally
click-through or draggable. It loads an `http(s)` page — or a local HTML file served from a
loopback origin — and knows nothing about captions, floating icons or desktop pets: the caller
provides the page (and its own data channel, usually SSE). Windows can be placed on a chosen
monitor and re-placed at runtime.

Used by `aiti-video-studio` as the live desktop caption window; also usable for floating
icons, status cards, desktop pets, etc.

## Build

```bash
cd integrations/aiti-desktop-widget
cargo build --release          # -> target/release/aiti-desktop-widget
cargo test                     # placement/static-server unit tests (no display needed)
DISPLAY=:0 node --test tests/shell.test.mjs   # optional GUI integration tests
# npm launcher tests (offline fake release server, justget download path)
npm install --prefix npm --ignore-scripts --registry https://registry.npmjs.org
node --test npm/test/download.test.mjs
# installers are not configured in this project (bundle.active=false);
# the release artifacts are the bare per-platform binaries above
```

Requirements: Rust toolchain + Tauri 2 system deps (Linux: `webkit2gtk-4.1`, GTK3;
Windows: WebView2 + MSVC build tools; macOS: Xcode CLT + WKWebView). Build-time only — the
produced binary needs only the system webview at runtime.

Icons: `icons/icon.png` must be **RGBA** (Tauri rejects RGB PNGs on macOS) and Windows needs
`icons/icon.ico` for the resource file. The repo ships both; regenerate with:
`convert -size 1024x1024 xc:none ... PNG32:icons/icon.png` +
`convert icons/icon.png -define icon:auto-resize=256,128,64,48,32,16 icons/icon.ico`.

Install (shared location used by the video-studio extension):

```bash
mkdir -p ~/.pi/bin && cp target/release/aiti-desktop-widget ~/.pi/bin/
```

Or install the npm launcher (downloads the release binary with justget racing, sha256-verified):

```bash
npm install -g @aiti-ai/aiti-desktop-widget
aiti-desktop-widget --help
```

Release process / CI: see [`RELEASING.md`](RELEASING.md) and
[`npm/README.md`](npm/README.md). For an offline/local npm install (pack + pre-seeded binary
cache), see [npm/README.md#local--offline-install](npm/README.md#local--offline-install).
The workflow is
`.github/workflows/aiti-desktop-widget-release.yml` in the aiti-ai repo; the release matrix builds
Linux x64/arm64, Windows x64/arm64 and macOS x64/arm64.

## Usage

```bash
# URL as a positional argument — no config file needed for the common case
aiti-desktop-widget http://127.0.0.1:8765/caption-bar.html?bubble=1 \
  --width 900 --height 140 --x 190 --y 650 \
  --title aiti-overlay --click-through true

# place on the second monitor (0-based index or monitor name), centered there
aiti-desktop-widget http://127.0.0.1:8765/caption-bar.html?bubble=1 \
  --display 1 --width 900 --height 140

# local page: served from a loopback origin, root defaults to its directory
aiti-desktop-widget --html ./pet/index.html --root ./pet --width 220 --height 220 \
  --display HDMI-A-0 --x 24 --y 840 --draggable true

# equivalent, and the full option list
aiti-desktop-widget --url http://127.0.0.1:8765/caption-bar.html?bubble=1
aiti-desktop-widget --help
```

All core options are CLI flags (`--url/--html/--root/--width/--height/--x/--y/--display/
--center/--title/--decorations/--transparent/--always-on-top/--skip-taskbar/--focusable/
--shadow/--resizable/--click-through/--draggable/--drag-region/--all-workspaces/--zoom/
--allow-remote`). A config file is optional; if both a positional URL and `--url` are given,
or `--url` and `--html` are given, the process exits with code 2.

Run-time config file (`CLI > --config > defaults`):

```bash
aiti-desktop-widget --config widget.json --x 200
```

```json
{
  "schema": 1,
  "url": "http://127.0.0.1:8765/caption-bar.html?bubble=1",
  "window": {
    "width": 900, "height": 140, "x": 190, "y": 650,
    "display": "0", "center": false,
    "title": "aiti-overlay",
    "decorations": false,
    "transparent": true,
    "alwaysOnTop": true,
    "skipTaskbar": true,
    "focusable": false,
    "shadow": false,
    "resizable": false,
    "clickThrough": true,
    "draggable": false,
    "dragRegion": "",
    "zoom": 1.0
  }
}
```

`html` / `root` are top-level keys, mutually exclusive with `url`:

```json
{
  "schema": 1,
  "html": "/home/me/pet/index.html",
  "root": "/home/me/pet",
  "window": { "width": 220, "height": 220, "display": "HDMI-A-0", "draggable": true }
}
```

Defaults: `decorations=false`, `transparent=true`, `alwaysOnTop=true`, `skipTaskbar=true`,
`focusable=false`, `clickThrough=false`, `draggable=false`, `resizable=false`,
`allWorkspaces=true`, `zoom=1.0`, `center=false`.

URLs are limited to `http(s)`; by default only `127.0.0.1` / `localhost` / `::1` are
allowed (pass `--allow-remote true` for other hosts).

## Monitors

`--display <index|name|primary>` selects a monitor for placement. `--x` / `--y` are then
offsets **inside** that monitor; any omitted axis is centered, so `--display 1` alone puts the
window in the middle of monitor 1. `--center true` centers on the selected (or primary)
monitor and wins over `x`/`y`. Without `--display`/`--center`, `x`/`y` keep their historical
absolute-screen meaning and omitting both leaves placement to the window manager.

The `ready` event reports `display` (selected index or `null`) and `monitors`:

```json
{"t":"ready","url":"http://127.0.0.1:4567/index.html","display":1,
 "monitors":[{"index":0,"name":"HDMI-A-0","primary":true,"x":0,"y":0,"width":1920,"height":1080,
              "scale":1.0,"physical":{"x":0,"y":0,"width":1920,"height":1080}},
             {"index":1,"name":"DP-1","primary":false,"x":1920,"y":0,"width":2560,"height":1440,
              "scale":1.0,"physical":{"x":1920,"y":0,"width":2560,"height":1440}}]}
```

Placement uses physical screen coordinates (offset × monitor scale) so a secondary monitor is
hit even when the window currently lives on a different-DPI monitor. Mixed-DPI multi-monitor
setups are reported, not yet exhaustively verified.

## Local HTML

`--html '<file>[?query]'` starts a tiny loopback static server on `127.0.0.1:<random>` and
loads the page from `http://127.0.0.1:<port>/...` with the optional query string forwarded
(e.g. `play.html?file=...&lyrics=...`). `--root <dir>` sets the served root (default: the HTML
file's directory). This keeps the shell's single content model (`http(s)` URLs, remote-origin
capability for dragging) instead of introducing `file://` / custom-scheme special cases.

Server behaviour: GET/HEAD only, `index.html` for directories, single `Range` requests for
media seeking, no directory listing, `no-store` caching. Paths that leave the root — `..`,
`%2e%2e`, backslashes, or symlinks pointing outside — are rejected with 403/404. The listener
binds loopback only and dies with the process.

## Demo: transparent lyric player

[`demo/play/play.html`](demo/play/play.html) is a dependency-free lyric player: audio URL,
LRC/SRT/VTT lyrics, current-line highlight, seekable progress, keyboard controls, and a
transparent card (or `bare=1` for text only). Short windows automatically switch to a
one-line marquee with the current-line progress drawn on the lyric; autoplay starts on open. It reads query parameters, so the shell can
load it directly:

```bash
aiti-desktop-widget \
  --html '/abs/path/demo/play/play.html?file=assets/aiti-intro.mp3&lyrics=assets/aiti-intro.lrc' \
  --width 900 --height 320
```

The bundled sample (`demo/play/assets/`) is an original TTS + synthesized-bed intro, so it
is safe to redistribute. See [`demo/play/README.md`](demo/play/README.md) for parameters
and formats.

## Transparency

`--transparent true` creates an ARGB window, but **the page owns its background**: the shell
does not rewrite content CSS. A page that wants the desktop to show through must set
`html, body { background: transparent }` (and avoid opaque full-window containers); a normal
web page with a background color stays opaque. On Linux/X11 the driver/compositor can affect
ARGB rendering — verify with a real screen grab (`ffmpeg -f x11grab`) rather than `PrintWindow`
on Windows, which renders transparent pixels as black.

## Control channel

stdin, JSONL:

```json
{"cmd":"navigate","url":"http://127.0.0.1:8765/other.html"}
{"cmd":"move","x":300,"y":700}
{"cmd":"move","display":1,"x":24,"y":800}
{"cmd":"center"}
{"cmd":"center","display":"DP-1"}
{"cmd":"displays"}
{"cmd":"resize","width":800,"height":120}
{"cmd":"set","alwaysOnTop":false,"clickThrough":true,"zoom":1.1}
{"cmd":"close"}
```

`move` with `display` places relative to that monitor (omitted axes center). Without
`display`, `x`/`y` are absolute screen coordinates. `center` uses the monitor currently
containing the window unless `display` is given. `displays` re-enumerates monitors (hotplug)
and replies with a `displays` event. `resize` also re-locks the min=max constraints when the
window is not user-resizable.

stdout, JSONL events:

```json
{"t":"ready","label":"main","url":"...","display":0,"monitors":[...]}
{"t":"displays","display":1,"monitors":[...]}
{"t":"moved","x":190,"y":650}
{"t":"resized","width":900,"height":140}
{"t":"closed"}
```

The shell is stateless: persist the last `moved` position (and `display`) yourself and pass
`x`/`y`/`display` next time.

## Drag

`--draggable true` enables dragging through Tauri's `data-tauri-drag-region`. Priority:

1. the page sets `data-tauri-drag-region` itself;
2. `--drag-region '<css selector>'` — the shell marks matching elements;
3. otherwise the shell injects a 16px transparent strip at the top as a grip.

`--draggable` and `--click-through` are mutually exclusive (a click-through window receives
no mouse events, so it cannot be dragged).

Because pages are served from localhost (a "remote" origin for Tauri), the drag capability
grants only `core:window:allow-start-dragging` to `http://` **and `https://`** `127.0.0.1` /
`localhost` (see `capabilities/widget-drag.json`). Tauri's remote URL patterns cannot express
an IPv6 literal, so a page loaded from `http://[::1]` can render but is **not** granted drag;
use `localhost` when dragging matters.

## Platform notes

- **Linux/X11**: `decorations(false)` + `transparent(true)` need a compositor for true
  transparency; without one the transparent area renders black (the widget itself still
  renders). Frameless and always-on-top work without a compositor.
- **Windows 11**: built with Rust 1.93.1 + VS Build Tools 2022 + WebView2 157. Verified:
  client rect == window rect (no titlebar), `WS_EX_TOPMOST | WS_EX_LAYERED |
  WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`, PrintWindow capture has no titlebar.
  ⚠ SSH sessions run in **session 0** where WebView2 fails with `0x80070578 invalid window
  handle`; run the widget inside the logged-in desktop session:
  `$sid=(Get-Process explorer|Select -First 1).SessionId; PsExec64 -accepteula -i $sid -d powershell -File test.ps1`
  (or a scheduled task with `/it`). In that context `CopyFromScreen` throws (invalid handle) —
  capture window contents with `PrintWindow` instead.
- **macOS 10.15+ (Intel) / 11.0+ (arm64)**: built with Rust 1.100.0 + Xcode 12 and
  `MACOSX_DEPLOYMENT_TARGET=10.15`; **verified visually on 11.7** — the bubble renders on
  the desktop frameless/transparent/always-on-top, and two instances coexist (one
  click-through + one draggable). `--zoom` is best-effort below macOS 11.
  The bare binary embeds `Info.plist` in `__TEXT,__info_plist` (see `build.rs`), so
  `http://127.0.0.1` pages load without an `.app` bundle (verified on macOS 11.7: the page's
  JS ran and hit the local server). `Info.plist` is also merged when building a `.app` with
  Tauri; launch that with `open -n app --args ...` if you ship a bundle.
  ⚠ SSH is a *Background* session; run GUI tests by handing the whole script to the Aqua
  session: `osascript -e 'tell application "Terminal" to do script "bash xxx.sh"'`.
  ⚠ If a **screen saver** is running, `screencapture` shows only the wallpaper — windows
  (including Finder) are invisible. Disable with
  `defaults -currentHost write com.apple.screensaver idleTime -int 0; killall ScreenSaverEngine`.
  `screencapture -l <wid>` fails for ordinary windows in launchd contexts (TCC).
- **Multi-display**: placement math, monitor enumeration, runtime `move`/`center` and the
  `displays` event are unit-tested and X11 integration-tested on a single head; Windows 11
  (150% scaling) and macOS 11 were checked in GUI sessions. Real multi-head X11, Wayland and
  mixed-DPI monitor layouts are not verified yet.
  ⚠ On macOS 11.7 the tao backend can report `available_monitors() == []` while
  `primary_monitor()` works; the shell then synthesizes index 0 from the primary monitor so
  `--display 0`/`--center` keep working.
- Wayland: not verified.

## Tests

```bash
cargo test                                   # display math + static server (no GUI)
node --test tests/shell.test.mjs             # GUI integration; starts a private Xvfb when needed
DISPLAY=:0 node --test tests/shell.test.mjs  # or use an existing desktop
AITI_DESKTOP_WIDGET_BIN=~/.pi/bin/aiti-desktop-widget node --test tests/shell.test.mjs
```

GUI tests skip themselves when no display/Xvfb/xdotool is available; the drag test also needs a
window manager (openbox).

## Design / status

See `docs/aiti-desktop-widget-overlay-shell-plan.md` in the workspace repo.
