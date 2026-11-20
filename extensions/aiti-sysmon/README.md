# aiti-sysmon

Server status viewer for the pi-web host machine — a left-sidebar dock panel showing
live CPU / memory / disk / network / temperature, powered by
[`systeminformation`](https://www.npmjs.com/package/systeminformation) (pure JS, no
native builds, cross-platform).

## How it works

- **Server**: one-shot read-only API, `GET /api/extensions/aiti-sysmon/snapshot`.
  No background timers anywhere — rate values (CPU load %, network rx/tx per sec)
  are deltas computed by `systeminformation` between consecutive calls, so the
  client polling cadence *is* the sampling window. Slow-changing sections are
  TTL-cached server-side (disks 30s, OS info 10min, temperature 5s).
- **Client**: sidebar dock face (lazy — the bundle materializes on first expand).
  Polls only while the panel is expanded, the tab is visible, and not paused;
  collapses/hides stop sampling immediately. Keeps a 60-point in-memory history
  for the CPU sparkline (nothing persisted to disk).
- **Temperature**: reported as `null` when the platform cannot provide it (Linux
  without lm-sensors, most Windows hosts). The panel then shows `TEMP N/A` with a
  link to the setup guide: <https://aiti.pw/extensions/aiti-sysmon.html>

## Features (extension manager)

| id | type | default | meaning |
|---|---|---|---|
| `interval` | string | `3` | polling interval in seconds while the panel is expanded |
| `showSensors` | boolean | on | show the CPU temperature row (N/A + guide link when unreadable) |

## Layout

```
index.ts            manifest + server.api (snapshot)
core.cjs            pure formatters / TTL cache (unit-tested, shared with the client bundle)
client/src/         JSX sources (vite lib build → dist/aiti-sysmon-client.mjs)
icons/              extension-local line icons (dock header uses icons/gauge.svg)
tools/              build-client.mjs / deploy.mjs
test/core.test.mjs  node:test unit tests
```

## Build & deploy

```bash
npm install                      # vite for the client build
node tools/deploy.mjs            # build → copy to ~/.pi/web{,-dev}/extensions/aiti-sysmon → reload
```

Server runtime dep (`systeminformation`) is declared in `package.json` `dependencies`
and installed into the shared web-root `node_modules` by aiti-extman reconcile.

## Tests

```bash
node --test test/core.test.mjs   # or via pi-work scripts/test-web-ext.mjs --only aiti-sysmon
```
