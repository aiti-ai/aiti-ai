# AITI Web

[中文文档](./docs/README.zh-CN.md) | [日本語](./docs/README.ja.md) | [Русский](./docs/README.ru.md)

**AITI Web** (`@aiti-ai/pi-web`) is a browser workbench for the [pi coding agent](https://github.com/earendil-works/pi) — and the base of the [aiti](https://aiti.pw/) tooling ecosystem: page-injected debugging tools, an MCP bridge for AI agents, and a growing library of bundled extensions.

### Why this fork?

Upstream [pi-web](https://github.com/agegr/pi-web) is an excellent local UI for pi — but building a full
AI development workbench needs more than a UI: an extension runtime, session tooling around git and
queues, service tunnels for sharing local ports, page-level debugging injection, and deep
AI ↔ page ↔ IDE collaboration. Upstream's architecture didn't leave room for those layers, so this
fork ships them as **63+ bundled extensions** that come with the package — `npm i -g @aiti-ai/pi-web`
and the whole workbench is there, no per-extension installs.

The engine stays pi (shared JSONL sessions, same local configuration), so everything upstream
documents still applies.

The origin story is worth a read: two 15-year-old projects — [TestAgent](https://aiti.pw/extensions/aiti-testagent.html), a Java runtime debugger, and [JustDB](https://justdb.ai), a database IDE — met the AI era, daily development moved onto pi-web, feature by feature it drifted from upstream, and aiti began as its own distribution. Built for real daily use first (commute-time coding, spare-device development, making every spare token count): full story at [aiti.pw/guide/origin.html](https://aiti.pw/guide/origin.html). Docs, the product map, and the story behind the fork live at
[aiti.pw](https://aiti.pw/) ([source](https://github.com/aiti-ai/aiti-docs)).

[中文文档](./docs/README.zh-CN.md) covers the same in Chinese.

![AITI Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

### What's bundled (highlights)

The upstream UI remains; everything below ships as bundled extensions you get out of the box.

- **Sessions & queues** — `session-manager` (cross-project All Sessions manager: kanban, tags, archives, full-text search, fork tooling), `queue-keeper` (edit/export/import/cut-in-line for queued messages), `aiti-recovery` (restart-recovery wizard for interrupted sessions), `aiti-draft-keeper`, `aiti-session-cards` (approval/permission cards)
- **Git toolchain** — `aiti-git-ops` (commit graph, AI-grouped commit plans with rollback, worktrees, branch panel), `aiti-git-review` (Monaco diff workspace with line annotations and AI pre-review), `aiti-git-trace` (AI change tracking timeline)
- **Page-injected debugging (aiti-devtools)** — AI debugging inside any local web app: FAB/HUD, an 8-domain 42-command CDP-like command set, Inspector, and the MCP bridge that lets AI agents talk to the page
- **Multi-agent backends** — Claude Code, Codex, Cursor, CodeBuddy, Qoder, ZCode, OpenCode, Kimi, Gemini, Copilot, iFlow and more (CLI + ACP drivers), with unified login management, sub-agent fleets, and a custom-agent registry
- **Models & usage** — model wizard (catalog search, multi-key rotation, aggregation), availability probing with 429 detection, provider balance/usage reports
- **Ops infrastructure** — `service-tunnels` (expose local ports over DNS/tunnels with auth), extension manager with an online registry, config versioning + crash self-check, backups, event bus, VNC UI environments, mail, IM channels, docs center
- **Reading & interaction** — message intelligence (click-to-quote, scroll nav, anchors), speech in/out, floating dialogs, context meter, prompt library, plan-first workflow, document viewers (docx/xlsx/pdf/pptx), and ~40 more

Beyond the workbench, the [aiti ecosystem](https://aiti.pw/) adds page-injection SDKs for Vite/Vue/Next/React/Svelte, Chrome & IDE extensions, and MCP bridge/server so any AI agent can reach the IDE window — plus one-command Docker images (core/full).


## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Quick Start

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @aiti-ai/pi-web@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-web` command globally:

```bash
npm install -g @aiti-ai/pi-web@latest
pi-web
```

Commands:

```bash
pi-web version          # print the installed version
pi-web status           # list running servers
pi-web stop [--port N]  # stop a running server
pi-web open [--port N]  # open a running server in the browser
pi-web update [--check] # update a global npm install
```

To update, run `pi-web stop`, then `pi-web update` (or run the same install command again). To uninstall, run `npm uninstall -g @aiti-ai/pi-web`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening. Run `pi-web --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_APP_NAME` | PWA manifest `name` and `short_name`; surrounding whitespace is trimmed, empty values use the default | `Pi Web` |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Enable browser password login; API clients may use Basic Auth with username `pi` | Authentication disabled |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |
| `PI_WEB_SHUTDOWN_DEADLINE_MS` | How long extensions get to handle `session_shutdown` before a closing session is disposed anyway, in milliseconds up to `2147483647`; `0`, invalid or out-of-range values use the default | `5000` (5 s) |
| `PI_CODEMODE_MAX_WORKERS` | pi's limit on codemode scripts running at once, shared by every session and subagent in the server; pi's own default is `2`, and pi-web sets `8` when the variable is unset or empty. Each script may use up to 256 MB | `8` |

Set `PI_WEB_APP_NAME` before starting the server (for example, `PI_WEB_APP_NAME='Work Pi' pi-web`). After changing it, restart the server to serve the new manifest; no rebuild is required. Updates to the name of an already installed PWA are managed by the browser and are not guaranteed to appear immediately. This does not change the page title or icons.

For example:

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. On a trusted LAN, require a long random password:

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

Password authentication does not encrypt the connection. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_WEB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @aiti-ai/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @aiti-ai/pi-web@latest
```

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces. An open session applies a saved edit of its model when you select the model again.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web opens its built-in
session menu (pin, rename, fork, mark read or unread, archive, open in new
tab, delete) at the pointer instead of the browser's native context menu.
The row's `⋯` button always opens the built-in menu and does not dispatch the
event. Sessions not yet saved to disk get no built-in menu, so the native one
still appears for them. This hook is browser-side and independent of Pi agent
extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

```js
const liveness = globalThis[Symbol.for("@aiti-ai/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Before starting on a feature, read [Contributing](./CONTRIBUTING.md) for what is in scope and the pull request checklist.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
demo/            Static browser demo published to GitHub Pages (see demo/README.md)
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full architecture map — including the bundled extension structure (anatomy, kinds, registration slots, loading & priority, runtime-dependency reconcile) — and [AGENTS.md](./AGENTS.md) for development notes.

## License

[MIT](./LICENSE)
