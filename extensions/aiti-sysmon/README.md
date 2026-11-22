# aiti-sysmon

Server status viewer for the pi-web host machine — a left-sidebar dock panel showing
live CPU / memory / disk / network / temperature / sensors, powered by
[`systeminformation`](https://www.npmjs.com/package/systeminformation) (pure JS, no
native builds, cross-platform). npm package: [`@aiti-ai/aiti-sysmon`](https://www.npmjs.com/package/@aiti-ai/aiti-sysmon).

## Features

- **OS header**: hostname · distro · kernel · uptime
- **CPU**: big load % + 60-point mini history + per-core strip + loadavg + temperature
- **Sensors**: full chip list (lm-sensors style) read from kernel `/sys/class/hwmon`
  (k10temp / nvme / amdgpu / acpitz / …), threshold-colored (≥70 amber, ≥90 red);
  hidden on platforms that report none
- **Memory**: RAM used/total bar + swap bar
- **Disks**: per-mount used/total bars (amber ≥80%, red ≥90%; squashfs/loop/efivarfs
  noise filtered)
- **Network**: per-NIC live ↓/↑ rates + totals (loopback / docker bridges / veth
  filtered; VPN tunnels kept), non-up ifaces dimmed
- **Toolbar**: pause/resume, manual refresh, quick interval switch (2s / 5s / 15s)
- **i18n**: every string bilingual (zh-CN / en), follows the host UI language

## How it works

- **Server**: one-shot read-only API, `GET /api/extensions/aiti-sysmon/snapshot`.
  No background timers anywhere — rate values (CPU load %, network rx/tx per sec)
  are deltas computed by `systeminformation` between consecutive calls, so the
  client polling cadence *is* the sampling window. Slow-changing sections are
  TTL-cached server-side (disks 30s, OS info 10min, temperature 5s, hwmon scan 5s).
- **Client**: sidebar dock face (eager bundle; auto-docked like the Tasks block,
  collapsed by default). Polls only while the panel is expanded, the tab is
  visible, and not paused; collapse/hide stops sampling immediately. First paint
  shows a layout-mirrored pulsing skeleton. Keeps a 60-point in-memory CPU
  history — nothing persisted to disk.
- **Temperature**: reported as `null` when the platform cannot provide it. The
  panel then shows a N/A hint linking to the setup guide:
  <https://aiti.pw/extensions/aiti-sysmon.html>

## Features (extension manager)

| id | type | default | meaning |
|---|---|---|---|
| `interval` | string | `3` | polling interval in seconds while the panel is expanded |
| `showSensors` | boolean | on | show the temperature row + the sensors chip list |

## Temperature N/A? (Linux)

Sensor readings come from the kernel hwmon subsystem (`/sys/class/hwmon`, sysfs) —
AMD `k10temp` / Intel `coretemp` drivers are in-tree and normally auto-loaded; no
userspace tools required. If the CPU temperature stays N/A (driver not loaded /
old kernel), install and probe lm-sensors:

```bash
sudo apt install lm-sensors && sudo sensors-detect    # Debian/Ubuntu
sudo dnf install lm_sensors && sudo sensors-detect    # RHEL/Fedora
sudo pacman -S lm_sensors && sudo sensors-detect      # Arch
sensors                                               # verify output
```

No pi-web restart needed — the next poll (≤5s, temperature cache TTL) picks it up.
Windows hosts: core temperature is usually unavailable (shown as N/A); CPU/memory/
disk/network are unaffected.

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
node tools/deploy.mjs            # build → copy to ~/.pi/web{,-dev}/extensions/aiti-sysmon → reconcile → reload
```

Server runtime dep (`systeminformation`) is declared in `package.json` `dependencies`
and installed into the shared web-root `node_modules` by aiti-extman reconcile.

## Tests

```bash
node --test test/core.test.mjs   # or via workspace-tools scripts/test-web-ext.mjs --only aiti-sysmon
```

## License

MIT — see [LICENSE](LICENSE).
