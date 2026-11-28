# aiti-proc-tree — child-process tree manager

A pi-web extension that shows every process the pi-web ecosystem spawns as a
tree — terminals, tunnels, subagents, external agents and host descendants —
with CPU / memory / age, and lets you stop a single process or a whole subtree.

The panel samples **only while it is open** (dock expanded or floating panel
visible); collapsing the dock or hiding the tab stops the client loop. The
server holds no timers.

## What it shows

| Source | Discovery |
|---|---|
| Host tree | `process.pid` + `bin/pi-web.js` / `next dev` ancestor chain, `/proc` ppid graph |
| aiti-cmd terminals | `aiti-cmd.procs` service (in-process + detached) and `~/.pi/agent/aiti-cmd-host/registry/*.json` |
| service-tunnels | `service-tunnels.procs` service plus `registered-pids-<ppid>.json` files and `SERVICE_TUNNELS_*` markers |
| Subagents | `aiti-subagents.procs` service for attached runs; `/tmp/pi-subagents-*/async-subagent-runs/*/status.json` for detached runners |
| External agents | `~/.pi/agent/agent-starter/registry/*.json`, `~/.pi/agent/bridge-registry.json`, `aiti-acp-agent.procs` service |

Unrelated processes are not collected: the sampler reads `stat` for the pid
graph only, then reads `status`/`cmdline`/`cwd` (and env markers for seed pids)
only for the visible set. Toggle `showUnknown` for a read-only stat-level list.

## Controls

- Five sortable columns (name / PID / CPU / memory / age; click a header to
  sort, click again to flip). Click any row for the detail drawer: full
  command line, cwd, whitelisted env vars, TCP listen ports, parent/children,
  plus End process / End subtree actions for killable nodes and Open terminal
  (terminals) / Open session (external agents). Listen ports are fetched on
  demand (one `/listen/<pid>` request per drawer row, never in the sampling
  loop): Linux reads `/proc/net/tcp{,6}` + fd socket-inode matching (spawn-free),
  macOS `lsof`, Windows `netstat -ano` (async spawn, TTL-cached; missing tools
  or timeouts degrade to a visible note, never a hang). When service-tunnels is
  installed, each port also carries an identity tag: tunnel alignment (name /
  type / protocol / url) plus a loopback probe (http/https/tcp + page title).
- `✕` ends the process; `⋯` opens details. Terminal rows can open the matching
  aiti-cmd terminal (double-click), tunnel rows open the services panel.
- Kill is guarded: same uid, protected pids (init, the extension host, the
  pi-web CLI, other instances), owned pids only, danger confirmation, and a
  `kill-audit.jsonl` trail under the extension state dir.

## Features

| id | default | meaning |
|---|---|---|
| `interval` | `2` | sampling interval while the panel is open (seconds) |
| `limit` | `200` | max rows returned (CPU-sorted); `0` = unlimited |
| `showUnknown` | `false` | read-only stat-level list of unowned pids |
| `showOtherInstances` | `false` | include other pi-web instances (read-only) |

## Develop

```bash
cd extensions/aiti-proc-tree
npm install          # vite only (devDependency)
node tools/build-client.mjs
node --test test/core.test.mjs
node tools/deploy.mjs   # copies to ~/.pi/web[-dev]/extensions + reloads
```

Zero runtime dependencies. Server code lives in `index.ts` + `server/`; shared
pure logic is `core.ts` (jiti-transpiled on the server so extension reloads pick it
up — a shared .cjs would be pinned by Node's process-level require/import caches; the
client bundles the same module for formatters).
