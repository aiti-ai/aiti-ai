# @aiti-ai/aiti-desktop-widget

**A business-agnostic native desktop widget shell** — frameless, transparent, always-on-top,
optionally click-through or draggable. It loads a URL or a local HTML page; multi-monitor
placement and a stdin JSONL control channel are built in.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by
[pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench), debug injection into
mainstream dev tools (aiti-devtools), and a rich extension system.

- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw> · docs: <https://aiti.pw/en/extensions/aiti-desktop-widget.html> · registry: <https://aiti.pw/extensions.html> (<https://aiti.pw/extensions.json>)
- Primary consumer: **[aiti-video-studio](https://aiti.pw/en/extensions/aiti-desktop-widget.html#used-by-aiti-video-studio)**
  uses aiti-desktop-widget for its live desktop caption window

Category: Desktop shell · Tags: `desktop` · `widget` · `tauri` · `caption` · `overlay`

## Install

```bash
npm install -g @aiti-ai/aiti-desktop-widget
# or run without a global install
npx @aiti-ai/aiti-desktop-widget --help
```

This npm package is a tiny launcher. The platform binary is a GitHub/Gitee Release asset and is
downloaded **on first run** with [justget](https://www.npmjs.com/package/justget) — multi-source
racing, chunked, sha256-verified, cached per version/platform.

- primary: GitHub Releases
- mirrors: Gitee, `gh-proxy.com`, `ghfast.top`, `ghproxy.net` (raced by justget)
- `checksums.txt` from the same release is verified before the binary is used

Supported platforms: `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `darwin-x64`,
`darwin-arm64`.

### Local / offline install

From a checkout you can pack the launcher and pre-seed the native cache (no Release needed):

```bash
cd integrations/aiti-desktop-widget/npm
npm pack
npm install -g ./aiti-ai-aiti-desktop-widget-0.2.0.tgz --ignore-scripts --registry https://registry.npmjs.org
# Windows: npm sometimes skips shim creation for local tarballs; recreate them with:
npm rebuild -g @aiti-ai/aiti-desktop-widget
```

Copy the built binary into the cache and write a `sha256sum`-format checksum line using the
**release asset name** (the launcher verifies this name when it has to download):

| OS | Cache path | Check line |
|---|---|---|
| Linux | `~/.cache/aiti-desktop-widget/<version>/<platform>/` | `aiti-desktop-widget-linux-x64` / `-arm64` |
| macOS | `~/Library/Caches/aiti-desktop-widget/<version>/<platform>/` | `aiti-desktop-widget-darwin-x64` / `-arm64` |
| Windows | `%LOCALAPPDATA%\aiti-desktop-widget\cache\<version>\<platform>\` | `aiti-desktop-widget-win32-x64.exe` / `-arm64.exe` |

```bash
CACHE=~/.cache/aiti-desktop-widget/0.2.0/linux-x64
mkdir -p "$CACHE"
cp target/release/aiti-desktop-widget "$CACHE/aiti-desktop-widget"
sha256sum "$CACHE/aiti-desktop-widget" | awk '{print $1"  aiti-desktop-widget-linux-x64"}' > "$CACHE/checksums.txt"
aiti-desktop-widget --version
```

## Usage

```bash
# load a page, frameless + transparent
aiti-desktop-widget http://127.0.0.1:8765/caption-bar.html --width 900 --height 140 \
  --x 190 --y 650 --click-through true

# local HTML (served from a loopback origin)
aiti-desktop-widget --html ./pet/index.html --root ./pet --width 220 --height 220 --draggable true

# choose a monitor; x/y are relative to it, omitted axes center
aiti-desktop-widget http://127.0.0.1:8765/ --display 1 --width 900 --height 140

aiti-desktop-widget --help
```

The npm launcher forwards argv/stdin/stdout/stderr, signals and the native exit code, so the
stdin JSONL control channel works exactly as with the standalone binary.

## Programmatic use

```js
import { ensureBinary, binaryPath, releaseUrls } from "@aiti-ai/aiti-desktop-widget";

const bin = await ensureBinary(); // downloads once, returns the cached path
console.log(binaryPath());        // cache path (no download)
console.log(releaseUrls());       // tag, asset, GitHub/Gitee/mirror URLs
```

Useful for a runner that spawns the shell itself (for example the Video Studio caption window).

## Environment

| Variable | Meaning |
|---|---|
| `AITI_DESKTOP_WIDGET_BIN` | Use this executable and skip downloading |
| `AITI_DESKTOP_WIDGET_CACHE_DIR` | Cache root (default: OS cache dir) |
| `AITI_DESKTOP_WIDGET_RELEASE_BASE` | Single release base URL (air-gapped/self-hosted mirror/testing) |
| `AITI_DESKTOP_WIDGET_MIRRORS` | Extra comma-separated base URLs |
| `AITI_DESKTOP_WIDGET_REPO` | `owner/repo` override (default `aiti-ai/aiti-ai`) |
| `AITI_DESKTOP_WIDGET_TAG` | Release tag override (default `aiti-desktop-widget-v<version>`) |
| `AITI_DESKTOP_WIDGET_VERBOSE` | `1` logs download progress |

Cache locations: `~/.cache/aiti-desktop-widget/<version>/<platform>` on Linux,
`~/Library/Caches/aiti-desktop-widget/...` on macOS, `%LOCALAPPDATA%\aiti-desktop-widget\cache\...` on Windows.

## Used by aiti-video-studio

[aiti-video-studio](https://aiti.pw/en/extensions/aiti-desktop-widget.html#used-by-aiti-video-studio) (Video
Studio) records deterministic demo videos and live presentations. Its desktop `overlay` caption
mode runs this shell with a loopback caption page (`caption-bar.html?bubble=1`) and pushes
subtitles over SSE; the shell owns the window, Video Studio owns the content. The same window
can host floating status cards, desktop pets or any local HTML page.

## Demo

The repository includes a dependency-free **transparent lyric player** at
[`demo/play/play.html`](https://github.com/aiti-ai/aiti-ai/tree/main/integrations/aiti-desktop-widget/demo/play):
`?file=audio.mp3&lyrics=song.lrc` (also SRT/VTT), current-line highlight, seekable progress,
keyboard controls, `bare=1` for text-only. The bundled sample is an original TTS intro
with a synthesized bed — no third-party music.

## Page control

Loopback pages can control their own window by default (`window.__TAURI__.window`): resize,
move, center, always-on-top, click-through, size constraints, monitor queries and webview zoom.
`demo/play/play.html` uses this in one-line mode to auto-fit the lyric around a fixed center
(`autosize=0` disables it). External pages loaded with `--allow-remote true` are outside the
loopback capability and cannot invoke these commands.

## Notes

- Linux requires glibc 2.35+ (built on Ubuntu 22.04) plus WebKitGTK 4.1 + GTK3 at runtime.
- Windows requires the WebView2 runtime (preinstalled on Windows 10/11, including ARM64).
- The macOS executable embeds `Info.plist` in `__TEXT,__info_plist` (ATS localhost exception,
  `LSUIElement`), so the bare binary loads `http://127.0.0.1` pages without an `.app` bundle.
  Deployment floor: **macOS 10.15+ (Intel)** / **11.0+ (Apple Silicon)**; `--zoom` needs macOS 11+.
  Tested on macOS 11.7; 10.15 is the declared/targeted floor, not a tested machine.
- Windows binaries are unsigned; SmartScreen may warn on manual downloads. The npm download path
  does not set the Mark-of-the-Web.
- No `postinstall` download: installation stays offline-safe; the first actual run fetches the
  binary. Set `AITI_DESKTOP_WIDGET_RELEASE_BASE` to use a pre-seeded local mirror.
