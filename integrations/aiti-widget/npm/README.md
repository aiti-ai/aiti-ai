# @aiti-ai/aiti-widget

**A business-agnostic native desktop widget shell** — frameless, transparent, always-on-top,
optionally click-through or draggable. It loads a URL or a local HTML page; multi-monitor
placement and a stdin JSONL control channel are built in.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by
[pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench), debug injection into
mainstream dev tools (aiti-devtools), and a rich extension system.

- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw> · docs: <https://aiti.pw/en/extensions/aiti-widget.html> · registry: <https://aiti.pw/extensions.html> (<https://aiti.pw/extensions.json>)
- Primary consumer: **[aiti-video-studio](https://aiti.pw/en/extensions/aiti-widget.html#used-by-aiti-video-studio)**
  uses aiti-widget for its live desktop caption window

Category: Desktop shell · Tags: `desktop` · `widget` · `tauri` · `caption` · `overlay`

## Install

```bash
npm install -g @aiti-ai/aiti-widget
# or run without a global install
npx @aiti-ai/aiti-widget --help
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
cd integrations/aiti-widget/npm
npm pack
npm install -g ./aiti-ai-aiti-widget-0.2.0.tgz --ignore-scripts --registry https://registry.npmjs.org
# Windows: npm sometimes skips shim creation for local tarballs; recreate them with:
npm rebuild -g @aiti-ai/aiti-widget
```

Copy the built binary into the cache and write a `sha256sum`-format checksum line using the
**release asset name** (the launcher verifies this name when it has to download):

| OS | Cache path | Check line |
|---|---|---|
| Linux | `~/.cache/aiti-widget/<version>/<platform>/` | `aiti-widget-linux-x64` / `-arm64` |
| macOS | `~/Library/Caches/aiti-widget/<version>/<platform>/` | `aiti-widget-darwin-x64` / `-arm64` |
| Windows | `%LOCALAPPDATA%\aiti-widget\cache\<version>\<platform>\` | `aiti-widget-win32-x64.exe` / `-arm64.exe` |

```bash
CACHE=~/.cache/aiti-widget/0.2.0/linux-x64
mkdir -p "$CACHE"
cp target/release/aiti-widget "$CACHE/aiti-widget"
sha256sum "$CACHE/aiti-widget" | awk '{print $1"  aiti-widget-linux-x64"}' > "$CACHE/checksums.txt"
aiti-widget --version
```

## Usage

```bash
# load a page, frameless + transparent
aiti-widget http://127.0.0.1:8765/caption-bar.html --width 900 --height 140 \
  --x 190 --y 650 --click-through true

# local HTML (served from a loopback origin)
aiti-widget --html ./pet/index.html --root ./pet --width 220 --height 220 --draggable true

# choose a monitor; x/y are relative to it, omitted axes center
aiti-widget http://127.0.0.1:8765/ --display 1 --width 900 --height 140

aiti-widget --help
```

The npm launcher forwards argv/stdin/stdout/stderr, signals and the native exit code, so the
stdin JSONL control channel works exactly as with the standalone binary.

## Programmatic use

```js
import { ensureBinary, binaryPath, releaseUrls } from "@aiti-ai/aiti-widget";

const bin = await ensureBinary(); // downloads once, returns the cached path
console.log(binaryPath());        // cache path (no download)
console.log(releaseUrls());       // tag, asset, GitHub/Gitee/mirror URLs
```

Useful for a runner that spawns the shell itself (for example the Video Studio caption window).

## Environment

| Variable | Meaning |
|---|---|
| `AITI_WIDGET_BIN` | Use this executable and skip downloading |
| `AITI_WIDGET_CACHE_DIR` | Cache root (default: OS cache dir) |
| `AITI_WIDGET_RELEASE_BASE` | Single release base URL (air-gapped/self-hosted mirror/testing) |
| `AITI_WIDGET_MIRRORS` | Extra comma-separated base URLs |
| `AITI_WIDGET_REPO` | `owner/repo` override (default `aiti-ai/aiti-ai`) |
| `AITI_WIDGET_TAG` | Release tag override (default `aiti-widget-v<version>`) |
| `AITI_WIDGET_VERBOSE` | `1` logs download progress |

Cache locations: `~/.cache/aiti-widget/<version>/<platform>` on Linux,
`~/Library/Caches/aiti-widget/...` on macOS, `%LOCALAPPDATA%\aiti-widget\cache\...` on Windows.

## Used by aiti-video-studio

[aiti-video-studio](https://aiti.pw/en/extensions/aiti-widget.html#used-by-aiti-video-studio) (Video
Studio) records deterministic demo videos and live presentations. Its desktop `overlay` caption
mode runs this shell with a loopback caption page (`caption-bar.html?bubble=1`) and pushes
subtitles over SSE; the shell owns the window, Video Studio owns the content. The same window
can host floating status cards, desktop pets or any local HTML page.

## Notes

- Linux requires glibc 2.35+ (built on Ubuntu 22.04) plus WebKitGTK 4.1 + GTK3 at runtime.
- Windows requires the WebView2 runtime (preinstalled on Windows 10/11, including ARM64).
- The macOS executable embeds `Info.plist` in `__TEXT,__info_plist` (ATS localhost exception,
  `LSUIElement`), so the bare binary loads `http://127.0.0.1` pages without an `.app` bundle.
- Windows binaries are unsigned; SmartScreen may warn on manual downloads. The npm download path
  does not set the Mark-of-the-Web.
- No `postinstall` download: installation stays offline-safe; the first actual run fetches the
  binary. Set `AITI_WIDGET_RELEASE_BASE` to use a pre-seeded local mirror.
