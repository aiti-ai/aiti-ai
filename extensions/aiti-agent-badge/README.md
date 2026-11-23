# @aiti-ai/aiti-agent-badge

Agent badge for the composer toolbar.

It registers one `composerTools` item next to the timeline / command-runtime entries:

- desktop: the icon row under the chat input
- mobile: the `＋` sheet's bottom action area (same host slot, same component)

The badge shows the current session's agent short label and a status dot:

| Dot | Meaning |
|---|---|
| filled accent | a turn is running |
| filled muted | the agent process is alive but idle |
| hollow | cold session (no live process) |

A dashed ring means the session is hosted survive-restart (detached) or is
marked to start that way next time.

Clicking opens a panel with the agent description, runtime status, hosting
mode, backend, runner, session id and working directory. Pi sessions can switch
hosting:

- **in-process** — run inside the pi-web host process
- **subprocess** — a dedicated child process; ends with pi-web (this run only)
- **subprocess · survives restarts** — hosted by the agent-starter wrapper

External agent sessions whose backend opted into detachable hosting can switch
between **subprocess** and **subprocess · survives restarts** (there is no
in-process mode for external backends). A direct-subprocess choice is persisted
in the shared preference marker so a cold reopen stays direct.

Switching while a turn is running is refused with a "stop the current turn
first" message. TUI bridge-owned sessions and external backends without
detachable support are read-only.

## Data

The panel consumes the host API:

- `GET /api/sessions/[id]/hosting`
- `POST /api/sessions/[id]/hosting` `{ mode }`

Live running-state refresh uses the `aiti-event-bus` `running` topic; there is
no polling. The refresh button covers mode changes made from other surfaces.

## Enable / disable

Extension manager → Agent Badge → "显示 Agent 标识" (`badge.show`). Disabling
unregisters the composerTools item immediately.

## Build / deploy

```bash
npm install
node tools/build-client.mjs
node tools/deploy.mjs
```

The host route ships with pi-web; no server hook is registered by this
extension.
