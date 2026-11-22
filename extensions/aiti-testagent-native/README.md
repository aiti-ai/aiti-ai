# @aiti-ai/aiti-testagent-native

> Visual panel for testagent-native (live Windows-native process control) — broker processes/sessions/hooks/event stream; formerly aiti-wintrace (renamed 2026-11-07)

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Debugging · Tags: `windows` · `native` · `win32` · `com` · `detours` · `injection` · `hook` · `trace` · `hotpatch` · `tan` · `testagent-native`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-testagent-native/` and reload pi-web.

Keep a tan broker running and point the panel/AI at it:

```bash
# 1) Keep a tan broker running (Windows: drop start-tan.vbs into the Startup folder for autostart —
#    broker 8765/8766 + MCP HTTP 8767). Manual start:
#    <repo>/native/build/win64-release/bin/<current-broker.txt> --port 8765 --http-port 8766

# 2) This panel goes live with the pi-web extension deployment (toolbar "Win" entry);
#    data source is broker HTTP 8766 (env TAN_BROKER_HTTP to change).

# 3) AI side: testagent-native-mcp — node mcp/testagent-native-mcp/register.js (38 tan_* + 7 app_* tools)
```

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-testagent-native.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-testagent-native.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
