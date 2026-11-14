# @aiti-ai/aiti-bridge

> Standalone bridge service for aiti-devtools + the aiti stdio MCP shim: page connections / SSE / tool execution / MCP JSON-RPC on one port (default `127.0.0.1:8777`), plus a zero-dependency stdio⇄HTTP MCP forwarder wired up with a single environment variable (`AITI_BRIDGE_URL`).

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## Components

| File | Purpose |
|---|---|
| `bin/aiti-bridge.mjs` | Standalone bridge service (page connections / SSE / tool execution / MCP JSON-RPC + static assets), default `127.0.0.1:8777` |
| `bin/aiti-mcp-shim.cjs` | **stdio ⇄ HTTP MCP forwarder** (zero-dependency): reads env `AITI_BRIDGE_URL`, negotiates the endpoint, and forwards JSON-RPC; without the env it degrades to a single `aiti_shim_status` self-check tool |
| `bin/aiti-mcp-register.mjs` | Registers the `aiti` shim entry into the MCP configs of various agents (idempotent, env `AITI_SHIM_VERSION` version guard, zero top-level private keys) |
| `tests/` | 7 test files (negotiation / forwarding / sessions / e2e / CLI / payloads / robustness, 57 cases) |

## Usage

### 1) One-time registration (idempotent; fixed entry name `aiti`, no URL stored in config)

```bash
node bin/aiti-mcp-register.mjs                  # auto: writes only existing config files
node bin/aiti-mcp-register.mjs --targets zcode,pi
node bin/aiti-mcp-register.mjs --unregister --targets pi
# other flags: --config-paths p1,p2  --name n  --dry-run  --force  --shim-path p  --version N
```

Written entry (opencode has a different shape, see the table in the docs):

```json
"aiti": { "type": "stdio", "command": "node", "args": ["<absolute path>/aiti-mcp-shim.cjs"], "env": { "AITI_SHIM_VERSION": "1" } }
```

### 2) Start your agent with the environment variable

```bash
AITI_BRIDGE_URL=http://127.0.0.1:8777      zcode    # standalone bridge (bare origin)
AITI_BRIDGE_URL=http://127.0.0.1:8777/aiti claude   # with /aiti also fine
AITI_BRIDGE_URL=http://127.0.0.1:3001/dev pi      # pi-web dev (basePath)
AITI_BRIDGE_URL=http://127.0.0.1:3002      …      # pi-web prod
```

The URL format is free-form: bare origin / with basePath / full endpoint / missing one `/mcp` all work (candidates are probed with POST `initialize`, first hit wins).

### 3) Without the environment variable

Nothing hangs — the shim degrades to just the `aiti_shim_status` self-check tool (shows the raw env, negotiated endpoint, probe log, example commands); other calls return a clear error.

## Environment variables

| Variable | Consumer | Purpose |
|---|---|---|
| `AITI_BRIDGE_URL` | shim / pi plugin / opencode plugin / openclaw plugin | bridge address; set once, everything picks it up |
| `AITI_SHIM_PATH` | autoRegisterAitiShim | override for the shim file location |
| `AITI_BRIDGE_PORT` / `AITI_BRIDGE_HOST` / `AITI_BRIDGE_DATA_DIR` | aiti-bridge service | service configuration |

## Registration targets

| Target | Config file | Container | Entry shape |
|---|---|---|---|
| pi | `~/.pi/agent/mcp.json` (follows `PI_CODING_AGENT_DIR`) | `mcpServers` | `{type:"stdio",command,args,env:{AITI_SHIM_VERSION}}` |
| zcode | `~/.zcode/cli/config.json` | nested `mcp.servers` | same as default |
| opencode | `~/.config/opencode/opencode.json` | nested `mcp` | shim: `{type:"local",command:["node",shim],enabled,environment:{AITI_SHIM_VERSION}}`; http: `{type:"remote",url,enabled}` (strict schema, no unknown keys) |
| claude | `~/.claude.json` + project `.mcp.json` | `mcpServers` | default shape |
| cursor / windsurf | their own configs | `mcpServers` | default shape |
| vscode | project `.vscode/mcp.json` | `servers` | default shape |
| zed | `~/.config/zed/settings.json` + project `.zed/` | `mcp` | default shape (JSONC tolerant; ⚠ rewriting strips comments) |

The version guard lives in the entry's env map (zero top-level private keys — zcode/opencode strict schemas reject unknown top-level keys): if entry `env.AITI_SHIM_VERSION` >= the shim file's `SHIM_VERSION` and the shim path is unchanged, the config is left untouched. Entries with legacy top-level version keys are migrated (key stripped) on registration.

## Tests

```bash
node --test tests/shim.test.mjs           # endpoint negotiation
node --test tests/shim-forward.test.mjs   # forwarding (mock bridge)
node --test tests/shim-session.test.mjs   # session lifecycle
node --test tests/shim-payload.test.mjs   # payload concurrency
node --test tests/robustness.test.mjs     # robustness
node --test tests/register-cli.test.mjs   # register CLI
node --test tests/shim-e2e.test.mjs       # e2e (needs a real bridge on 8777 / pi-web 3001·3002)
```

## Install

```bash
npm install -D @aiti-ai/aiti-bridge
node bin/aiti-bridge.mjs        # serve on 127.0.0.1:8777
```

## Documentation

- Documentation (English): <https://aiti.pw/en/products/aiti-bridge.html>
- 文档（中文）: <https://aiti.pw/products/aiti-bridge.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
