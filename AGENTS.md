# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

### Dev server troubleshooting

- Before starting a server, run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse the existing Pi Web process when it is healthy. A second `next dev` for the same checkout cannot use a different port as a workaround because both processes contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph; it does not prove the server or source is broken. First call the browser's explicit reload action, then compare the current server log and a direct HTTP/API request.
- Restart only after the failure reproduces from a fresh page and the server-side checks also fail. Stop the exact dev process gracefully, move `.next` into a `mktemp -d` backup, and restart with the standard `npm run dev` command.
- Do not use `next dev --webpack` as a fallback. This repository's development graph can fail on `undici` imports such as `node:console`; development is expected to use Turbopack.
- Next.js may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md` when `next dev` starts. Treat that as generated tooling output, verify it with `git status`, and do not include it in an unrelated feature commit.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd/YYYYMMDD (local date)
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  mcp/route.ts                    GET ?cwd= (optional) — Settings › MCP: both mcp.json files, trust, MCP / Code mode availability, each server's last status (a test's or an open session's), a session whose /mcp is another extension's; files only | POST add (a pasted server, re-parsed; trusts a fresh folder in the same step)/enable/disable/remove/undo/set-enabled/sign-out, answers the overview after it
  mcp/test/route.ts               POST { scope, name, cwd? } — test one mcp.json server's connection once (lib/mcp-test.ts); the entry is read from its file
  mcp/sign-in/route.ts            POST { scope, name, cwd? } — start (or join) an OAuth sign-in to one mcp.json server (lib/mcp-sign-in.ts); answers the flow at once
  mcp/sign-in/[flowId]/route.ts   GET where a sign-in stands (polled) | POST { redirectUrl } pasted redirected address | DELETE cancel
  models/route.ts                 GET { models, modelList, defaultModel }
  models/enabled/route.ts         GET/PUT enabledModels switches for the Models panel
  models/default/route.ts         PUT save the default model / reasoning level for new sessions
  models/refresh/route.ts         POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees
  web-auth/route.ts               GET status | POST login | DELETE logout (browser password)
  plugins/check/route.ts          POST check plugin package updates
  project-trust/route.ts          GET trust status + the project's .pi/mcp.json servers (files only) | POST trust, rebuild the cwd's wrappers
  sessions/search/route.ts        GET session search
  sessions/[id]/state/route.ts    GET live wrapper state when the session is running
  sessions/[id]/auto-name/route.ts POST generate a session title
  terminal/route.ts               POST create a terminal session
  terminal/[id]/route.ts          GET stream | POST input/resize | DELETE kill
  cwd/browse/route.ts             GET browse allowed cwd directories | POST create child directory
  open-in-explorer/route.ts       GET availability | POST open a cwd in the OS file manager (loopback only)
  app-update/route.ts             GET current vs latest published pi-web version
  file-index/route.ts             GET file list for @-mentions
  git/status/route.ts             GET changed files for a cwd
  git/diff/route.ts               GET diff for one changed file
  provider-usage/query/route.ts   POST provider usage quotas
  push/config/route.ts            GET VAPID public key for push subscriptions
  push/subscribe/route.ts         POST register a push subscription
  tools/settings/route.ts         GET/PUT defaultTools switches: PowerShell (Windows) and Code mode (automatic / always, chosen in Settings › MCP); refusals carry `reason`

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  default-preferences.ts  write defaultModel/defaultThinkingLevel; detect project-level shadowing
  draft-store.ts       local draft persistence helpers
  extension-ui-queue.ts  FIFO queues for extension dialogs and custom panels, keyed by request id
  file-access.ts       allowed file roots for /api/files and worktrees
  linked-directory.ts  directory links that lead outside the allowed roots + the allow-link check
  default-cwd.ts       dated ~/pi-cwd/YYYYMMDD path for "Use default directory"
  file-paths.ts        client/server path encoding helpers
  display-path.ts      display-only `~` / `./` path shortening for the settings panels
  file-tree-visibility.ts  which entries the file tree lists: git check-ignore, name-list fallback
  enabled-models.ts    pure minimal-edit engine for the `enabledModels` pattern list
  enabled-models-runtime.ts  SDK adapter: per-pattern resolution, provider kinds, settings IO
  markdown.ts          shared markdown helpers
  gfm-autolink-email-loader.cjs  bundler loader: remark-gfm's email regex without a lookbehind literal (#753)
  node-cli.ts          locate bundled npm-cli.js / npx-cli.js so npm/npx spawn without a shell (Windows npm.cmd)
  npx.ts               npx runner used by skill install
  plugin-updates.ts    npm view update checks for /api/plugins/check
  pi-types.ts          local structural types for pi SDK objects
  pi-sdk-internals.ts  file-URL loader for SDK modules the package does not export (MCP connection, config, OAuth)
  project-trust.ts     trust status with the nearest decision, mayReadProjectConfigNow (the MCP host's fresh read), trustProject, and trustFreshFolderAndWrite (a fresh folder trusted and written in one step: breadth guard, per-folder chain, lstat re-check, rollback)
  mcp-transport.ts     MCP transport factory: stdio servers get the sanitized project-command env, never PI_WEB_PASSWORD; the resolved-value walk
  builtin-extensions.ts  codemode / tool-search / mcp built-ins for normal sessions, PI_WEB_DISABLE_MCP, sandbox self-test (+ peek), `-builtin:` switches read from settings
  mcp-read-only-policy.ts  tool_call policy: read-only sessions block MCP tools without readOnlyHint, nested calls too
  mcp-command.ts       client-safe: `builtin:mcp` and who owns `/mcp` (`isBuiltinMcpCommand()`, `isMcpExtensionCommand()`, `bareMcpOpensSettings()`), shared by the MCP host, the read-only policy and the composer
  mcp-host.ts          per-wrapper MCP host: registers mcp.json servers before a prompt, waits for them, idles them out, reports what each server does (and a /mcp it does not own) to the status store
  mcp-config-key.ts    canonicalJson() and mcpConfigKey() (the per-process HMAC every status is keyed by), shared by the host and the reader; total, nesting past 64 levels prints as a marker
  mcp-json-error.ts    JSON.parse messages without the source text they quote: jsonErrorMessage() for the reader and writer, scrubMcpLoadError() for what the host logs
  mcp-config-values.ts client-safe: the values pi resolves (resolvedConfigValues()) and the PI_WEB_PASSWORD rule (findWebPasswordField()), shared by the add pane, the reader, the transport and the routes
  key-serializer.ts    serializeByKey(): one globalThis promise chain per key, for the mcp.json writer and fresh-folder trust
  mcp-config-read.ts   Settings › MCP reads: each mcp.json read and described from the file, nothing resolved or run; GET /api/mcp's overview; the project file's link rule (`locateProjectMcpConfig()`), which the writer shares
  mcp-config-file.ts   the mcp.json writer: the SDK editor's bytes, plus a lock, an atomic write through links, 0600 global / kept project mode, typed refusals
  mcp-undo.ts          removed mcp.json entries held 60 s in process memory (globalThis), keyed by a token; only the token reaches the browser
  mcp-status.ts        last known connection state per mcp.json entry (globalThis), from tests and session hosts, keyed scope\0sourcePath\0name with a record per configKey, the one matching the file shown; sessions whose /mcp is another extension's
  mcp-test.ts          Settings › MCP's Test: one SDK connection through Pi Web's transport factory, request timeout / deadline / bounded close, a serial queue for !command entries, joined presses, masked messages; the open / observe / close steps sign-in reuses
  mcp-entry-request.ts the checks before a route connects one mcp.json entry (Test and sign-in): origin, JSON, cwd, MCP off, project trust, the entry read from its file, valid, no PI_WEB_PASSWORD; `validateMcpProject()`, `mcpInternalsOrRefusal()` and `mcpProjectTrustRefusal()` serve `/api/mcp` and `/api/project-trust` too
  mcp-sign-in.ts       Settings › MCP's OAuth sign-in as `pi mcp login` runs it: a globalThis flow registry polled by id, one flow per URL, 5-minute limit, checked pastes, cancel, sign-out
  mcp-sign-out.ts      what a sign-out bars, for sign-ins and Tests alike: the OAuth URL rule and key, per-URL sign-out counts (globalThis), `mcpSignOutGuard()`, `guardedCredentialStore()`
  mcp-secrets.ts       pure secret classification + masking for MCP URLs, args, env/header names (panel, trust dialog, importer), and the raw parts each mask hides (Test's redactor)
  jsonc.ts             JSON with comments: stripJsonComments (pi's line comments + trailing commas, plus block comments) and parseJsonc; models-config-store reads models.json through it
  shell-words.ts       split one pasted command line into words without a shell: quotes, $'…', \ ^ ` continuations, NAME=value prefixes; refuses | && ; redirects $(…); keeps Windows backslashes; variables returned as parts
  mcp-add.ts           POST /api/mcp add's checks before it writes: the paste parsed again, values filled, SDK-validated, PI_WEB_PASSWORD / literal-secret-in-project / host-variable refusals
  mcp-import.ts        Settings › MCP paste importer (pure): parseMcpImport, fillMcpImportFields (secretPaths), referenceableLiteralSecrets; mcp-import-core/json/cli/links.ts hold the value encoder, JSON shapes, CLI grammars and install links
  mcp-server-display.ts  client-safe display helpers for McpServerInfo: hidden-character escapes, quoted command line, target, field and variable labels, file-problem details
  mcp-tool-display.ts  `server/tool` label for an mcp__ call from its result's details (never parsed from the name), JSON result indenting
  codemode-view.ts     display helpers for codemode cards: script, nested calls, header-free output, progress
  codemode-settings.ts Code mode automatic / always as `+codemode` in the global defaultTools; a trusted project's own defaultTools that decides it there
  global-settings-file.ts  locked read-modify-write of the global settings.json (shared with SettingsManager's lock)
  regular-file.ts      `readRegularFileText()`: open without blocking, read only a regular file (optional byte cap), for settings a GET reads
  stacked-dialog.ts    Escape + focus for a dialog opened above another (the trust dialog over Settings): capture-phase Escape that stops there, focus in and back; Settings' bubble-phase Escape and `focusModalPanel()` (focus into Settings and back); `focusIfLost()` for a control removed under the keyboard, `focusAfterChange()` for one disabled while its change ran
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CodemodeToolView.tsx  codemode card body: highlighted script + the tool calls it made
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  EnabledModelsSection.tsx  model switches inside ModelsConfig, backed by enabledModels
  OAuthPastePanel.tsx paste box for a server-side sign-in's redirected address or code (Models subscriptions, MCP sign-in)
  ProjectTrustDialog.tsx  trust confirmation; fetches and lists the project's MCP servers when it opens; opens from the restricted-mode banner or above Settings › MCP, where Escape closes it alone
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  McpConfig.tsx       Settings › MCP: both mcp.json files' servers from GET /api/mcp, each switched or removed (60 s undo) and each group switched through POST /api/mcp, each tested through POST /api/mcp/test (Connection row, listed tools, row dot), each OAuth server signed in through /api/mcp/sign-in (polled) and out through POST /api/mcp, plus the Code mode row and its Automatic / Always on switch, and Trust for an untrusted project (AppShell's dialog); no project needed
  mcp-config-helpers.ts  pure helpers for McpConfig: row states, groups, notices, selection, the overview load with its cwd fallback, the Code mode save, write blocks and the POST /api/mcp change, test blocks and the POST /api/mcp/test request
  McpSignIn.tsx       a server's Sign-in row in Settings › MCP: signed-in state, Sign in / Cancel / Sign out, the sign-in page link with OAuthPastePanel, how the sign-in ended
  mcp-sign-in-helpers.ts  pure helpers and requests for McpSignIn: blocks, phase / outcome keys, where a run goes after each answer, the /api/mcp/sign-in requests
  McpAddServer.tsx    Settings › MCP's add pane: one paste box, the preview (as written, typed passwords hidden), the importer's notes, values to fill in (or a host variable), name, scope with its visible reasons, Add / Add and trust this folder
  mcp-add-helpers.ts  pure helpers for McpAddServer: the draft analysed with the importer, where a project server may go (fresh-folder step, breadth, secrets), why Add waits, the preview, note / problem / field keys, the add request
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic; the composer's built-in slash commands (`/session`, a bare `/mcp` opening Settings › MCP)
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useKeyboardShortcuts.ts  global Esc stops the running agent unless a field or something nearer took the key (`handleGlobalEscape()`); Ctrl+Alt+N
  useTheme.ts         theme state
```

---

## Topic Notes

Most design decisions and traps live in `docs/agents/`, one file per area. Before changing code in an area, read its note; a change that spans areas needs every note it touches. Add new notes to the area's file, not here: this file keeps only what applies to any change.

- [sessions.md](docs/agents/sessions.md) — AgentSession lifecycle and shutdown, fork vs in-session branching, session file rewrites, toolCall normalization, SSE reconnect and tool execution events, transcript system / usage / context-edit entries, running-state polling, exported HTML. Read before changing `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/normalize.ts`, `hooks/useAgentSession.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/BranchNavigator.tsx`, `components/MessageView.tsx` or `components/CodemodeToolView.tsx`.
- [tools.md](docs/agents/tools.md) — tool presets and Chat only, exact system prompts, tool exposure, the built-in codemode / tool-search / mcp extensions, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Read before changing `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, or tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md) — the per-session MCP host: when servers register and connect, the connection states it reports, trust read on every sync, idle release; `/mcp` typed in the composer. Read before changing `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, the MCP wiring in `lib/rpc-manager.ts` or `lib/builtin-extensions.ts`, or `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md) — Settings › MCP: reading both `mcp.json` files without running anything, masking, the trust dialog's server list, the panel's row states, notices, Code mode choice, trust from Settings and Escape stacking, and every `mcp.json` write with undo. Read before changing `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx` or `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md) — Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Read before changing `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts` or `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md) — Settings › MCP add: the paste parsed again on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust in one step, the add pane; the paste importer's escaping and grammars. Read before changing `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, the fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, or the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md) — default model and reasoning level, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, provider auth listing and credentials. Read before changing `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-catalog-refresh.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelSelector.tsx` or `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md) — worktrees and project grouping, the file access allow-list (the security boundary for `/api/files`), file tree visibility, web password throttling. Read before changing `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts` or `components/FileExplorer.tsx`.
- [settings-ui.md](docs/agents/settings-ui.md) — the Plugins and Skills routes, sidebar group switches, and the shared `SettingsUi` blocks every settings panel and add pane uses. Read before changing `app/api/plugins/**`, `app/api/skills/**`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx` or `components/PluginsConfig.tsx`, and before adding a settings section or add pane.
- [subagents.md](docs/agents/subagents.md) — the built-in subagent setting, profiles and their files, run status, completion notifications. Read before changing `lib/subagent*.ts`, `app/api/subagents/**` or `components/AgentsConfig.tsx`.
- [client-platform.md](docs/agents/client-platform.md) — the mobile software keyboard and viewport height, the completion sound. Read before changing `hooks/useViewportHeight.ts`, `hooks/useAudio.ts` or the keyboard-open CSS.

---

## Key Design Decisions & Traps

### Old Safari (iOS 16.2)
- `/` renders entirely on the client, so one script chunk the browser cannot *parse* is a blank page, not a broken feature (#753). Next 16 compiles for Safari 16.4+ by default; the `browserslist` in `package.json` lowers Safari and iOS to 16.2 so SWC turns class `static {}` blocks into private static fields. That reaches Next's own client runtime, but other node_modules keep the syntax they ship unless they are in `transpilePackages`; mermaid and `@mermaid-js/parser` are listed there because their lazy diagram chunks are full of static blocks. Keep the other browserslist entries at Next's defaults.
- SWC cannot downlevel a RegExp **lookbehind** (`(?<=`, `(?<!`), which Safari parses only from 16.4. Do not write one in client code: `lib/markdown.ts` emulates its leading lookbehinds with `replaceNotPrecededBy()`. A lookbehind built at runtime (`new RegExp("(?<=…)")` inside `try`) only fails when it runs, which is how `lib/gfm-autolink-email-loader.cjs` fixes the email regex in `mdast-util-gfm-autolink-literal`; the loader is registered for both webpack and Turbopack in `next.config.ts` and fails the build if that regex changes upstream.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```



