# @aiti-ai/aiti-backup

> Snapshot backup for large pi-web state data — hard-link incremental snapshots, out-of-process execution, crash-safe temp files, keepCount rotation. Complements aiti-configs, which versions small configs in git.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## What it does

Snapshot backup for big state-tier data (session archives `.pwarc`, git-trace ops, `~/.pi/agent/sessions`) — complementary to aiti-configs: configs handles "small-config git versioning"; this extension handles "big-data snapshots".

## How it works

- **Snapshot semantics**: each backup = `<dest>/<sourceId>/snapshots/<UTC timestamp>/` full point-in-time copy + `manifest.json` (completion marker)
- **Hard-link incremental**: files with the same path as the previous snapshot and matching size+mtime are `fs.link` zero-copy; when the target disk doesn't support hard links (exFAT etc.) the whole round degrades to copying automatically (`mode:"full"`)
- **Source strictly read-only**: backup never writes/deletes the source; symlinks are not followed (recorded as skipped); runtime noise names excluded by default
- **Execution isolation**: scan/copy runs entirely in a standalone child process (`bin/backup-runner.cjs`, zero blocking of the host); progress flows via stdout JSONL → event-bus topics `aiti-backup:progress|done|error` (no polling)
- **Interrupt safety**: a kill at any moment can only leave `.tmp-*` half-finished artifacts (auto-cleaned on the next run); a per-source run lock prevents concurrent runs
- **Retention rotation**: `keepCount` (default 7) deletes the oldest, only among timestamp-named directories inside `snapshots/`
- **Restore**: for now simply copy back from a snapshot directory (snapshots mirror the source's relative layout)

## Usage (API)

```bash
base=/api/extensions/aiti-backup
curl -s localhost:3001$base/status                                   # source list (state auto-discovery + pi-sessions)
curl -s -X POST localhost:3001$base/config -H content-type:application/json \
  -d '{"dest":"/mnt/your-backup-disk"}'                              # set destination (mutual-exclusion check against sources)
curl -s -X POST localhost:3001$base/backup -H content-type:application/json -d '{"all":true}'
curl -s localhost:3001$base/runs                                     # run history
```

- Source toggles: `POST config {"sourceOverrides":{"pi-sessions":{"enabled":false}}}`; custom sources: `custom:[{id,path}]`.
- The destination is your choice (external drive/NAS); **backup contents are not encrypted** — session content contains private data, keep it on a disk you control.

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-backup/` and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-backup.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-backup.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
