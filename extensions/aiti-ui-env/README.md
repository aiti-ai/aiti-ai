# @aiti-ai/aiti-ui-env

> Environment allocator for UI debugging on headless background servers — a 4-state mode arbiter decides whether newly launched MCP/apps land on a real desktop or an Xvfb headless virtual display (Xvfb+openbox+picom+AT-SPI virtual display + VNC-on-web + RDP-on-web), service-ized on Linux/Windows/macOS; the VNC password is authenticated by the VNC server itself (the bridge is pure passthrough)

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Debugging · Tags: `headless` · `xvfb` · `vnc` · `rdp` · `atspi` · `audio` · `pipewire` · `pulseaudio` · `display` · `virtual-desktop` · `noVNC` · `vnc-password`

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

## Audio session (Linux, default on)

GUI apps started through `resolve` / `run` / the headless virtual display inherit the user's
PipeWire/Pulse session even when pi-web itself was launched by systemd or SSH:

- `PULSE_SERVER=unix:/run/user/<uid>/pulse/native`
- `PIPEWIRE_RUNTIME_DIR=/run/user/<uid>`

The values are discovered from the current uid and only added when the sockets exist;
an explicit parent value wins. Agent bash sessions also get the hydrated process env at
extension startup. Toggle **音频输出（Linux PipeWire/Pulse）** in ExtMan → aiti-ui-env →
Features; it is **on by default**. Turning it off leaves audio environment variables untouched.

## ARGB compositor (2026-11-21)

The Linux virtual display starts **picom** after the WM (falls back to compton/xcompmgr). This is required for transparent Tauri/GTK caption windows.

- Bare startup (`ensureHeadless` / `setup-linux.sh --bare`) starts it idempotently per `DISPLAY=:N`.
- systemd installs `ui-env-compositor.service` and pulls it into the target; ExecStart picks picom → compton → xcompmgr.
- The dependency checker/installer includes `picom`.
- `stopHeadless` also kills the compositor on that display.

## License

MIT
