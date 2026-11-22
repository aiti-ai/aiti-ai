# @aiti-ai/aiti-cpu-meter

> Main-thread smoothness detector — a seconds counter + 0–100 smoothness score + color tiers + minimize + AI jank debugging. Ships as two artifacts: a pi-web extension (internal) and a standalone single-file injector you can register into any website you develop.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## What it does

| Capability | Notes |
|---|---|
| **Smoothness score** | 0–100 (100 = fluid, 0 = stuck), gap-magnitude curve anchored on Apdex/INP/TBT + blocking/freeze penalties, 4 color tiers |
| **Seconds counter** | rAF-driven; freezes exactly when the main thread is stuck (a hard signal for diagnosing freeze moments) |
| **Session stats** | Time-weighted **average smoothness** + **run duration** + **lowest dip** for the whole session — keep it running all day, check the overall picture when you wrap up |
| **Minimize** | Shrinks to a tiny icon (color dot + live score); drag it out of the way and keep it running; position/state persisted |
| **On-site report** | `window.__aitiCpuMeter.report()` returns the full snapshot: score / window averages / gaps / long tasks / **LoAF script attribution** / jank snapshots / environment |
| **✨ Ask AI** | Panel button → hands the on-site report to aiti-helper and opens a "debug page jank" session (internal), or POSTs it to pi-web and jumps to the new session (standalone on any website) |
| **Dual artifacts** | Internal (pi-web extension, feature-gated) + external (standalone single file, injectable into any website) |

## Three injection channels (evaluate your own sites)

### ① service-tunnels injection (main path: proxied / published sites)

When publishing/proxying a site port through service-tunnels, tick **CPU smoothness meter** in the publish form → the external artifact is auto-injected into that channel's HTML responses (no changes to your site). Registered under source id `aiti-cpu-meter`.

### ② Bookmarklet (any non-proxied website)

```
javascript:(()=>{if(window.__aitiCpuMeter){window.__aitiCpuMeter.dispose();return;}const s=document.createElement('script');s.src='https://<pi-web host>/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js';s.defer=true;document.head.appendChild(s)})()
```

Run once to inject, run again to remove. Parameters: `aiti-cpu-meter.js?meter-pos=right-top&meter-score=off&meter-min=off`.

### ③ Cross-instance injection (feature: service.url + inject.enabled)

Pulls the external artifact from a target pi-web instance and injects it into the current page.

## Interaction

- **Minimize**: title-bar **−** → tiny icon (color dot + live score), draggable, click to expand.
- **Drag**: internal panel follows the aiti-float contract (`data-ext-float`, drag/position persistence taken over); external panel + FAB have built-in dragging (external sites don't have aiti-float), position persisted.
- **Close**: **✕** hides the current page only (not persisted, reappears on refresh); minimized/expanded state persists.
- Expanded panel: row 1 = current score (large) + 10-cell color bar; row 2 = session stats (average/duration/dip); below that the raw diagnostics (CPU seconds / gap / max / longtask / last jank snapshot).

## Scoring algorithm

```
gapScore(g): ≤33ms=100 · 200ms=40 · 1000ms=10 · 10000ms=0 (piecewise linear, eye-calibrated)
frameHealth = min(gapScore(ewmaGap), gapScore(recentMax))     # sustained (EWMA) vs spike (decayed max), worse wins
smoothness = clamp( 100 − 0.60×(100−frameHealth) − 0.20×blockingPenalty − 0.20×freezePenalty , 0, 100 )
  blockingPenalty = long-task TBT blocking-ratio EWMA (Σmax(0,dur−50))
  freezePenalty  = min(50, freezeCount×10) (>600ms frames, decayed counting)
colors: ≥90 green · 75–89 yellow · 50–74 orange · <50 red
```

Anchored on public algorithms: **Apdex** (satisfaction threshold), **INP** (200/500ms), **TBT** (Google), **RAIL** (frame ≤16.7ms). Calibration: fully idle = 100 · intermittent 120ms = 82 · single 2s freeze = 44 · repeated 1s freeze ×5 = 38 · sustained 150ms ≈ 75.

## Features (extman feature panel)

| feature | type | default | notes |
|---|---|---|---|
| `enabled` | boolean | false | show the meter on this instance (off by default; enable in ExtMan "Feature management") |
| `pos` | string | left-bottom | default position (drag position wins once dragged) |
| `score` | boolean | true | smoothness score row (off = pure counter) |
| `minimize` | boolean | true | allow minimizing (off = expanded + ✕ only) |
| `askAi` | boolean | true | panel "Ask AI" button (✨; on-site report → aiti-helper jank-debug session) |
| `inject.enabled` | boolean | false | cross-instance injection (from the `service.url` target instance) |
| `service.url` | string | — | target pi-web base URL (incl. sub-path) |

## Design notes

- Background tabs: rAF stops naturally → no sampling; on visibility restore the frame baseline resets so hidden time is never counted as jank. Session stats accumulate only while visible.
- First-load 2s gate: samples but doesn't score, avoiding the first-layout gap.
- localStorage keys are prefixed `aiti-cpu-meter:` — isolated per site domain, no conflicts on third-party sites.
- Injection registry (`__stInjectRegistry`) is owned by service-tunnels; this extension registers through it (soft dependency).

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-cpu-meter/` and reload pi-web. The standalone artifact is served at `/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js`.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-cpu-meter.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-cpu-meter.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
