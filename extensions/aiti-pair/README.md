# @aiti-ai/aiti-pair

> Device interconnect over the bridge — paired devices (phone browsers / other computers / agent sessions / injected pages) exchange messages and files.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## What it does

Messages and file transfer between devices connected to the same bridge (mobile browsers, other computers, agent sessions, injected pages).

## How it works

- This extension is a thin pi-web shell: a toolbar button ("Device interconnect" in the "More" overflow menu) opens a floating panel (`data-ext-float` contract; aiti-float handles dragging / small-screen fullscreen) that lazy-loads the pair widget.
- The widget and protocol are **not part of this extension** — they come from the aiti-devtools shared asset `pair-client.js` (built by the bridge core, the single source of protocol truth); the extension loads that asset at runtime (soft dependency: with aiti-devtools absent the panel shows guidance instead of crashing).
- Reachability scope = the device set of this instance's embedded bridge (not interconnected with a standalone bridge on 8777).

## Same capability, other entry points

| Entry point | Location |
|---|---|
| Standalone page for phones / external browsers | `/pair.html` served by the bridge (standalone bridge: `https://<host>/aiti/pair.html`; pi-web: `/api/extensions/aiti-devtools/pair.html`) |
| Cockpit console | toolbar ✉ button → popup widget |
| Agents (MCP) | `bridge_status` (unified device view) + `aiti_pair_send` / `aiti_pair_file` / `aiti_pair_fetch` |

## Cross-bridge federation (feature-gated, off by default)

Reachability defaults to a single bridge instance. With the aiti-devtools feature `pairFed.enabled` turned on, this instance's panel/agent tools can also see and message/file the devices of the **authoritative bridge** (default `http://127.0.0.1:8777/aiti`, configurable via `pairFed.url`; devices appear under the `fed:` namespace). Sending from the authoritative bridge to "pi-web bridge" devices broadcasts to all pair devices on this bridge (v1 asymmetric semantics). Federated file download reads through the authoritative bridge's host (unavailable across machines).

## Security model

- Pair messages / file downloads require a peer token (issued at registration, remembered in browser localStorage)
- The discovery surface (register/events/devices) is double-gated: bridge-private-network gate (`X-Real-IP` check; `AITI_PAIR_PUBLIC=1` opens fully / `AITI_PAIR_TOKEN` tier-B registration token) plus your reverse proxy's auth in front of public exposure
- Ephemeral by design: messages live in memory only, files self-clean after a 1h TTL, devices are recycled 1h after going offline

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-pair/` and reload pi-web.

## Documentation

- aiti-devtools (the bridge this pairs with): <https://aiti.pw/en/devtools/>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
