# @aiti-ai/aiti-attach-agent

> Socket-attaches to already running agent processes — connects the pi TUI bridge; supports full automation via environment variables (PI_WEB_BRIDGE_AUTO=1 auto-bridges any CLI session); followUp queue echo + image attachment passthrough + idle timeout exit

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Multi-agent backends · Tags: `attach` · `socket` · `tui` · `session` · `multi-agent`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-attach-agent/` and reload pi-web.

The pi TUI side is a separate standalone pi package (the `/web` command + auto-bridge). Install it inside pi:

```bash
pi install npm:@aiti-ai/pi-web-bridge
```

Pairing: the TUI side runs the socket bridge and writes `~/.pi/agent/bridge-registry.json`; when this extension (the pi-web side) opens a session it looks up the registry and attaches to that socket (single-writer rule — the session file remains exclusively owned by the pi process). With `PI_WEB_BRIDGE_AUTO=1`, every TUI session bridges automatically — no `/web` needed.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-attach-agent.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-attach-agent.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
