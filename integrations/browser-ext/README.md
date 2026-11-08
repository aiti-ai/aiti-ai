# aiti-devtools browser extension (Chrome / Edge / Firefox)

> ✅ **v2 shipped (P0)**: **off by default** — popup "⚡ Enable on this page (once)" for one-click on-demand injection / "★ Always enable this site" allowlist; the AI window defaults to **pi-web** (auto-probed and prefilled on the options page) or any compatible agent host, with cockpit as the explicit fallback. P1/P2 (shortcuts, per-site targets) are specified in `docs/aiti-devtools-browser-ext-v2-plan.md`.
>
> 🇨🇳 中文：见 [README.zh-CN.md](README.zh-CN.md)

Inject the aiti-devtools in-page AI debugging assistant into any webpage **on demand — with zero changes to the target app** (FAB 💬 AI + crosshair Inspector, element picking, AI window). The AI window defaults to the **pi-web workbench**; together with the aiti-devtools bridge (local standalone bridge or pi-web), pi / claude / opencode agents can operate any page.

Design: `docs/aiti-devtools-browser-ext-plan.md`; v2 enhancement plan: `docs/aiti-devtools-browser-ext-v2-plan.md` (same repo).

## Origin · aiti ecosystem

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench / workbench: <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo / monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site / site: <https://aiti.pw>

## Quick start

```bash
cd browser-ext
npm run build       # → dist/chrome dist/edge dist/firefox
npm run package     # → dist/*.zip + dist/aiti-devtools-firefox.xpi (needs system zip)

# Prerequisite: an aiti-devtools bridge must be running (default local standalone bridge 127.0.0.1:8777)
#   systemctl start aiti-bridge      # or: node packages/aiti-bridge/bin/aiti-bridge.mjs
```

### Install

- **Chrome/Edge**: `chrome://extensions` (or `edge://extensions`) → enable Developer mode →
  "Load unpacked" → pick `dist/chrome` (Edge: `dist/edge`)
- **Firefox (temporary load)**: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" →
  pick `dist/firefox/manifest.json` (gone on restart; the build swaps in the Firefox event-page background.scripts)
- **Firefox (permanent xpi)**: `npm run package` → `dist/aiti-devtools-firefox.xpi` —
  on ESR / DevEdition / Nightly, set `xpinstall.signatures.required=false` in about:config and
  "Install Add-on From File" works permanently (signature-free); release / Android permanent installs need AMO signing
  (`web-ext sign --channel=unlisted` or upload the xpi on AMO as unlisted; the stable gecko id `aiti-devtools@aiti.ai` is pinned)

## Usage (v2: off by default)

1. After installing, **nothing is injected** on any page — the toolbar popup shows this page's state.
2. **On-demand**: popup "⚡ Enable on this page (once)" injects into the current page immediately (gone on navigation); or "★ Always enable this site" adds it to the allowlist, after which navigation to that site auto-injects.
3. Once enabled, the FAB (💬 AI + crosshair Inspector) appears bottom-right on the page.
4. Click 💬 to open the AI window (default = the configured AI target: pi-web workbench / compatible agent / cockpit fallback).
5. Connect the agent side (pick one):
   - **pi**: install aiti-devtools-pi to call `aiti_*` tools in-session (same bridge)
   - **stdio shim**: env `AITI_BRIDGE_URL=http://127.0.0.1:8777/aiti` (one-click copy on the options page)
   - **MCP**: add `{ type: "http", url: "<bridgeUrl>/mcp/mcp" }` to mcp.json

## Options (v2)

- **AI target, three kinds**: pi-web workbench (recommended) / compatible agent host / cockpit fallback; target address + **🔍 one-click local pi-web probe** (ports 30141/30142 auto-prefill; selecting pi-web also prefills the same-origin bridge address)
- **Site rules**: off by default + **allowlist** (one regex per line; matching sites auto-inject) + **denylist** (highest priority — wins even over the allowlist)
- **Advanced**: bridge address / agent-side shim (AITI_BRIDGE_URL one-click copy)

> Settings take effect after a **page refresh** (stable semantics; see plan D1).

## Implementation notes

- Injection = `world:"MAIN"` content script (Chrome/Edge 111+, Firefox 128+); the launcher source is
  inlined into `content/main.js` at build time (file top-level execution, **unconstrained by page CSP**)
- Config = isolated world (`content/bridge.js`) reads storage.sync → **evaluates site rules** (denySites first) →
  writes localStorage (shared across worlds) → the MAIN world reads it synchronously at document_idle → injects
- Double-injection guard: `window.__dbgLauncherInstalled` (no double injection when the page already runs a launcher, e.g. pi-web)
- Small screens: full Firefox for Android support (MV3); the launcher's small-screen physical adaptation is built in

## Layout

```
browser-ext/
├── src/
│   ├── content/   bridge.js (isolated-world config + rule evaluation) + main.js (MAIN-world injection)
│   ├── background/ sw.js (install init + v1 migration)
│   ├── popup/     popup.html/css/js (this-page state + on-demand enable / allowlist)
│   └── options/   options.html/css/js (AI target + site rules + advanced)
├── scripts/       build.mjs + package.mjs
├── icons/         brand icons (aiti-docs logo.svg + PNG family)
└── dist/          chrome/ edge/ firefox/ (build output)
```
