# @aiti-ai/aiti-ui-env

> Environment allocator for UI debugging on headless background servers — a 4-state mode arbiter decides whether newly launched MCP/apps land on a real desktop or an Xvfb headless virtual display (Xvfb+openbox+AT-SPI virtual display + VNC-on-web + RDP-on-web), service-ized on Linux/Windows/macOS; the VNC password is authenticated by the VNC server itself (the bridge is pure passthrough)

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Debugging · Tags: `headless` · `xvfb` · `vnc` · `rdp` · `atspi` · `display` · `virtual-desktop` · `noVNC` · `vnc-password`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-ui-env/` and reload pi-web.

Service-ize for persistent headless displays (Linux):

```bash
cd scripts/linux && ./setup-linux.sh && ./install-service.sh
```

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-ui-env.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-ui-env.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
