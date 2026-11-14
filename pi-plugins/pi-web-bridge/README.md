# @aiti-ai/pi-web-bridge

> Bridge a [pi](https://pi.dev) TUI session to the browser with `/web` — the pi-web side opens the same session live, with bidirectional IO (prompt / steer / follow-up / abort / model switching), queued-message echo, and image attachment passthrough.

A small [pi package](https://pi.dev/packages) that pairs with the [pi-web](https://github.com/aiti-ai/pi-web) attach backend (`aiti-attach-agent`).

English · [简体中文](./README.zh-CN.md)

## About aiti

This package comes from [aiti](https://aiti.pw/) (GitHub org [aiti-ai](https://github.com/aiti-ai)) — a personal AI development workbench ecosystem powered by [pi](https://pi.dev): the **aiti-agent** web workbench (built on open-source [pi-web](https://github.com/aiti-ai/pi-web)), debug injection into dev tools (aiti-devtools), and a library of extensions.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>

## What it does

Run `pi` in a terminal as usual, then:

- **`/web`** — interactive wizard: pick *attach* (rpc bridge; browser and TUI work the session together) or *takeover* (pi-web runs the pi SDK in-process and the TUI hands the session over), optionally spawn a new pi-web and open the browser.
- **`/web --attach --no-spawn --no-open`** — direct mode: start the bridge and attach to an already-running pi-web.
- **`/web off`** — stop the bridge.

While bridged:

- Every agent event streams to the browser (messages, tool calls, turns, model changes).
- Input from the browser is forwarded into the TUI session: prompt, steer (interrupt), follow-up (queue), abort, model / thinking-level switching, compact, session rename — plus the registered slash commands list.
- Messages queued while the model is streaming are echoed to the browser (`queue_update` mirror synthesized inside the bridge — pi does not forward queue events to extensions).
- Image attachments sent from the browser are validated and passed through to the session.
- The session shows a `tui-bridge` tag in the pi-web "All Sessions" panel, and session ownership stays with the pi process (single-writer rule — the web side attaches to the socket, never opens the file).

### Full-auto mode

Export `PI_WEB_BRIDGE_AUTO=1` in your shell profile and every plain terminal `pi` session starts the bridge automatically on boot (no `/web`, no wizard): open the session from any running pi-web instance and watch / interact live. Idle sessions exit on their own after 10 minutes (`PI_WEB_IDLE_TIMEOUT_MS`, `0` disables).

## Install

```bash
pi install @aiti-ai/pi-web-bridge
```

Requires a running [pi-web](https://github.com/aiti-ai/pi-web) (the `aiti-attach-agent` extension ships with it) — that is the browser side this bridge pairs with. See the pi-web README for how to run it.

## Configuration (environment)

| Variable | Meaning |
|---|---|
| `PI_WEB_BRIDGE_AUTO=1` | Auto-start the bridge on every TUI session start |
| `PI_WEB_BRIDGE_BASE` | URL of a running pi-web (used for URL derivation and aiti_* tool routing) |
| `PI_WEB_BRIDGE_PORT` | Default port for spawned pi-web (default `3000`) |
| `PI_WEB_BRIDGE_ENTRY` | Command used to spawn pi-web (default `pi-web`) |
| `PI_WEB_BRIDGE_LANG` | UI language: `zh` or `en` (defaults from the locale) |
| `PI_WEB_IDLE_TIMEOUT_MS` | Auto-bridge idle exit timeout (default `600000`, `0` disables) |

`/web` also accepts flags: `--port`, `--base`, `--domain`, `--scheme`, `--webport`, `--takeover` / `--attach`, `--open` / `--no-open`, `--spawn` / `--no-spawn`.

## How it works

```
pi TUI ── /web ──▶ Unix-socket JSONL bridge ◀── attach ── pi-web (aiti-attach-agent)
                    (events out, commands in)                │
                                                             └─ bridge-registry.json
                                ~/.pi/agent/bridge-registry.json maps live session
                                files → sockets so pi-web attaches instead of opening
                                the file (single-writer rule)
```

The extension registers a socket server inside the pi process, forwards agent events, translates browser commands into pi APIs, and keeps a registry (`~/.pi/agent/bridge-registry.json`) that pi-web consults when opening a session. The second entry point (`dist/aiti-devtools-pi.js`) is the aiti-devtools connector bundle: when the [aiti-devtools](https://github.com/aiti-ai/aiti-ai) MCP bridge is in play, its tools route through this same socket to the page pi-web is showing.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-attach-agent.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-attach-agent.html>

## License

MIT
