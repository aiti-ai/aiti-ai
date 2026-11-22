# @aiti-ai/aiti-qoder-agent

> Exclusive Qoder CLI session backend (qodercli/qoderclicn): credits/quota (getUsage), WASM-signed model catalog (listModels), task-list mirror, run-queue management, and plan/permission-mode support.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## What it does

A dedicated session backend for the Qoder CLI (multi-agent frontend / All Sessions integration). `qodercli`/`qoderclicn` belong to the claude-code protocol family — the driver layer mirrors aiti-claude-code-agent; this extension takes **exclusive ownership** of the two qoder members (removed from the CC family list) and adds:

| Capability | Notes |
|---|---|
| `getUsage` | Account credits/quota — `{openapi}/api/v2/quota/usage` (Bearer dt-token) |
| `listModels` | Model catalog — infer gateway `/api/v2/model/list?Encode=1` (WASM-signed request) |
| `taskList` | Read-only mirror of the TodoWrite work plan (derived from tool events via the shared layer `@aiti-ai/ext-shared/task-list`; disk snapshot fallback for cold sessions) |
| `queueManage` | Run queueing (`@aiti-ai/ext-shared/backend-queue` file sidecar + automatic next round after settle) |
| `respondInteraction` | `control_request/can_use_tool` interaction chain (shared-layer ledger): authorization cards / AskUser cards / plan-approval cards by tool kind; replies go back as `control_response`; pending items persist to the sidecar and are re-delivered on `subscribe` |
| Plan mode | `setPermissionMode("plan")` via `control_request/set_permission_mode`; enter/exit reported by CLI `system/plan_mode_changed` frames, `getPermissionMode()` reflects it. Bypass mode only affects tool authorization — plan/AskUser/ExitPlanMode still ask |
| `getAllTools` / `getCommands` / `getPermissionMode` | Capability snapshots — carried for free in the CC-family `system/init` frame |
| Extension API | `GET /api/extensions/aiti-qoder-agent/{usage,models}` (no session needed) |

## Two regions

| variant | CLI | infer gateway | openapi |
|---|---|---|---|
| `qoder` (intl) | `qodercli` | api2-v2.qoder.sh | openapi.qoder.sh |
| `qoder-cn` | `qoderclicn` | gateway.qoder.com.cn | openapi.qoder.com.cn |

Both register automatically based on binaries found on PATH; region credentials are auto-detected (cn preferred). CLI binary resolution: env override (`QODER_CLI_PATH` / `QODER_CLI_CN_PATH`) > PATH > install-location fallback `~/.qoder{,-cn}/bin/<cli>/<cli>.exe`.

## Authentication

- Credentials live in `~/.qoder{,-cn}/.auth/user` (WASM-encrypted); `assets/qoder_auth.wasm` + `qoder_glue.js` (extracted from the qoderclicn binary) decrypt the dt-token and signing material at runtime.
- Session inference runs in the CLI subprocess (stream-json); the CLI handles its own auth. Credits/model catalog go through direct REST.

## Known quirks

- qodercli does **not** support `--verbose` (claude CLI only; passing it exits 1)
- The headless session's active tool list (33 items in the init frame) does **not** include `AskUserQuestion` — the model cannot call it; `EnterPlanMode`/`ExitPlanMode` are present and do raise `can_use_tool`
- The result frame carries the round's `total_credits`, merged into the agent_settled event's usage

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-qoder-agent/` and reload pi-web. Requires the `qodercli` / `qoderclicn` CLI on the machine (logged in).

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-qoder-agent.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-qoder-agent.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
