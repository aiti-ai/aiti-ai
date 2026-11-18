# aiti-devtools (vscode)

[中文说明 · Chinese docs](https://aiti.pw/devtools/integrations/)

> The VS Code carrier for [aiti-devtools](https://aiti.pw/devtools/integrations/): one click sets up page injection, the aiti bridge, and MCP config for your IDE's built-in AI agent — so Copilot Chat can see and operate the page you are working on (`page_exec` / `page_snapshot` / `user_*`).

## What it does

- **Page injection without code changes** — a local reverse proxy prepends the aiti launcher script to your dev server's HTML responses. Works with any site served over HTTP.
- **Bridge lifecycle** — starts (or reuses) the aiti bridge that connects injected pages with AI agents.
- **MCP wiring** — writes the `aiti` entry into `.vscode/mcp.json` so MCP-aware agents inside the IDE can talk to the bridge.
- **Dev server discovery** — lists HTTP services started from the IDE's own child processes (integrated terminal / tasks / debugger) and turns them into injection channels. Processes outside the IDE are never enumerated.
- **AI window** — the 💬 badge injected into pages opens your AI window: the local bridge cockpit by default, or any aiti-compatible page (e.g. a self-hosted [pi-web](https://aiti.pw/) instance) via the `aiti.aiUrl` setting.

## Quick start

1. Start your dev server (Vite / Next / webpack / …) — ideally from the IDE's integrated terminal so it can be auto-discovered.
2. Command palette → **`aiti: Enable Page Debugging`**. It starts the bridge + proxy, discovers your dev server, and opens the proxy URL.
   - Multiple candidates → a QuickPick lets you choose; none found → it asks for an address (`localhost:5173`, `:5173` or a bare port all work).
3. Browse the proxy URL (default `http://127.0.0.1:8788/`) — the 💬 / 🎯 badge in the corner means injection succeeded.
4. In Copilot Chat, ask the AI to inspect or operate the page: `bridge_status` shows connected pages, `page_exec` runs JS in them.

## Commands

| Command | What it does |
|---|---|
| `aiti: Enable Page Debugging` | Ensure the bridge is running → start the injection proxy → write `.vscode/mcp.json` → open the proxy URL |
| `aiti: Stop Debugging` | Stop proxies + the bridge started by this extension (external bridges are left alone) |
| `aiti: Open Bridge Panel` | Status, injection channels, injectable services, framework integrations, AI window URL, bridge logs |
| `aiti: Re-inject` | Restart proxies (use after pages already carry an injection, e.g. from a vite plugin) |

## Settings (`aiti.*`)

| Setting | Default | Description |
|---|---|---|
| `bridgePort` | `8777` | Bridge port (same as the standalone bridge default) |
| `bridgePath` | empty | `aiti-bridge.mjs` path (empty = auto-detect) |
| `shimPath` | empty | `aiti-mcp-shim.cjs` path (empty = auto-detect) |
| `proxyPort` | `8788` | First injection proxy port; each target gets its own port (8788, 8789, …) |
| `targetUrl` | empty | Pin the injection target (empty = auto-discover) |
| `aiUrl` | empty | AI window URL opened by the 💬 badge. Empty = local bridge cockpit; point it at a pi-web instance (e.g. `https://pi.example.com/`). Editable from the bridge panel; changing it rebuilds proxies |
| `autoOpenBrowser` | `true` | Open the proxy URL after enabling |
| `autoEnable` | `false` | Run "Enable Page Debugging" on activation (workspace-level; handy for tests) |

## Bridge panel

- **Status header** — bridge state + counts + primary actions, plus the effective AI window URL with an inline edit button.
- **Injection channels** — one card per target ↔ proxy pair.
- **Injectable services** — HTTP services discovered among the IDE's child processes; non-page services are folded away.
- **Collapsible sections** — framework integrations (Vite / webpack / Rspack / Nuxt / Astro / Next / Express one-click carrier plugins), manual port enrollment, connected pages, bridge logs.

## Two ways to inject

1. **Proxy injection** (this extension) — zero code changes; works on any local dev server. The page origin differs from the dev server origin (proxy port).
2. **Framework carrier plugin** — add the aiti vite/webpack/Nuxt plugin to your dev server; everything runs same-origin (`/aiti/`), which is more robust. The bridge panel detects your framework and can patch configs with one click (backups are written to `.aiti-bak`). See the [carrier integration docs](https://aiti.pw/devtools/integrations/).

## AI window & agent backends

The 💬 badge can open any aiti-compatible page as your AI window (`aiti.aiUrl`). Point it at a self-hosted **[pi-web](https://aiti.pw/)** instance (npm `@aiti-ai/pi-web`) to get the full AI window: session management, model picker, and multi-agent sessions. pi-web already integrates a wide range of external agent CLIs, including:

- **ACP backends** — Claude Code, Codex, DeepSeek (`dsh`), Gemini, Kimi, Qoder, Grok, antigravity, omp (Oh My Pi), OpenClaw, and more, via `aiti-acp-agent` (Agent Client Protocol adapters).
- **Deep integrations** — OpenCode (L2 carrier extension, sessions & bridging) and OpenClaw.
- **pi / zcode** — first-class family backends.

All of them appear in the same All-Sessions panel and can take over any injected page from the AI window.

## Links

- Documentation (carrier integrations): <https://aiti.pw/devtools/integrations/>
- Quick start: <https://aiti.pw/devtools/quick-start.html>
- Self-host your AI window with npm [`@aiti-ai/pi-web`](https://aiti.pw/)
- 中文文档（Chinese docs）：<https://aiti.pw/devtools/integrations/>
