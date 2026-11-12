# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit` · Lint: `npm run lint`

**Never run `next build` during dev**: it pollutes `.next/` and breaks `npm run dev`.

### Dev server troubleshooting

- First run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse a healthy Pi Web process. A second `next dev` on another port is no workaround: both contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph, not a broken server or source. Use the browser's explicit reload, then compare the server log and a direct HTTP/API request.
- Restart only when the failure reproduces from a fresh page and the server-side checks fail too: stop that exact dev process gracefully, move `.next` into a `mktemp -d` backup, restart with `npm run dev`.
- Turbopack panic (`/tmp/next-panic-*.log`, e.g. "CJS module can't be async") leaves the incremental graph poisoned: pages reload-loop or render with the custom top bar / composer half-dressed (stretches of blank toolbar), while `tsc --noEmit` passes. A plain service restart does NOT clear it — stop the process, move `.next` away, restart, and wait for the full rebuild before judging (early reloads during rebuild are HMR churn, not a loop). Also beware viewport inheritance when auditing from a fresh browser page: a page opened without the emulation override runs at the window's own width, and every x-coordinate measured past that width is a phantom.
- Do not trust `grep rescue` on served HTML: `rescue-hook.js` is injected into every page as a build-error probe; its mention appears on healthy pages too.
- Never fall back to `next dev --webpack`: the dev graph can fail on `undici` imports such as `node:console`. Development uses Turbopack.
- `next dev` may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md`. It is tooling output: check `git status` and keep it out of unrelated commits.

### Upgrading pi

pi's packages up to 1.2.0 depend on each other with `^` ranges (1.3.0 pins them exactly), and the published pi-web's dependencies resolve afresh on install (no lockfile ships). Install every `@earendil-works/*` package the tree holds, the SDK's own dependencies included (`pi-codemode`, `pi-mcp`, `pi-telemetry`, …), with `npm install --save-exact`, so npm reuses those exact versions for the SDK's ranges. `lib/pi-packages.test.mjs` fails on any pi package that is not pinned that way; pi-web 0.12.0 pinned four, and installs after pi 1.2.0 paired pi-coding-agent 1.1.0 with pi-codemode 1.2.0.

### Merging upstream (MUST READ before any origin/main merge)

This fork carries intentional divergences (custom-drawn top bar, WeChat-style mobile send, mobile composer v4, provider names …). Four regression classes have already shipped to users from past merges (duplicated buttons, a collapsed composer, a Send key that inserted newlines). Before merging origin/main, follow the merge SOP: whole-commit conflict resolution (never mix hunks of one upstream commit), the single-owner table (each guarded UI region has exactly one owner), then the post-merge checks — full test run plus `node scripts/check-upstream-merge.mjs --base <old-tip> --upstream origin/main`, triaging every reported line as fork-intentional or merge-loss. The full written SOP lives in the private source workspace, not in this repo. The guard pins (`AppShell.topbar-dedup`, `ChatInput.composer-shrink-chain`, `ChatInput.mobile-send`) go red on reintroduction — a red pin means the merge is wrong, not the test.

### Releases & version scheme (MUST READ before tagging/publishing)

Fork releases use the Debian/Ubuntu-style build suffix, never bare versions:

- Fork version = `X.Y.Z-aiti.N` where `X.Y.Z` is the **upstream core version** the build is based on; rebuilds increment `N` (`-aiti.1` → `-aiti.2`). Bare `X.Y.Z` is legacy and rejected by the release guard.
- Ordering is dpkg semantics, not semver: the upstream core dominates and the suffix only breaks ties (`0.16.0-aiti.2 > 0.16.0-aiti.1 > 0.16.0`; `0.16.1 > 0.16.0-aiti.3`). All consumers (update checks, tags, npm) implement this ordering — do not "fix" it to strict semver.
- tag = `v<version>`; the npm package version and the `latest` dist-tag carry the same string.
- The **sole release entry point** is `node scripts/release-tag.mjs` (guard: version must be `X.Y.Z-aiti.N`, tag must not exist anywhere, working tree must be clean; `--dry-run` / `--suggest` / `--force` to exempt a dirty tree). Never `git tag` by hand.
- npm publishing: the official registry (registry.npmjs.org) goes through GitHub Actions (`publish.yml`, OIDC trusted publishing); the private registry (npm.alot.pw) is published locally — always with `--tag latest`, since npm otherwise refuses to let a prerelease-looking version take over `latest`.
- Full design and rationale: `docs/aiti-ai-fork-build-suffix-versioning-plan.md` lives in the private source workspace.

---

## Architecture

- **Browsing** (read-only, no AgentSession): `GET /api/sessions` lists `~/.pi/agent/sessions/`; `GET /api/sessions/[id]` reads the `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts`, or an open wrapper's in-memory `SessionManager`. `GET /api/agent/running` snapshots the running ids.
- **Sending**: `POST /api/agent/[id]` → `startRpcSession()` (`lib/rpc-manager.ts`) creates the AgentSession in-process (`createAgentSessionFromServices()`); `session.send(cmd)` → `session.prompt()`.
- **Events**: `GET /api/agent/[id]/events` streams SSE `data: {...}` from `session.onEvent()`, fed by `session.subscribe()`.
- **Product scope**: a light web wrapper around pi, not an IDE or a platform of its own. Before adding a feature, check the out-of-scope list in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Extension compatibility (principle)**: extensions written for the pi CLI must behave the same here. Fix display problems in the web client; never add pi-web-only options or fields to the extension API (`ctx.ui.*` options, `extension_ui_request`). pi's TUI (`node_modules/@earendil-works/pi-tui`) is the reference for what an extension asking for something means.

---

## File Map

```
app/api/
  sessions/route.ts                GET list all sessions
  sessions/[id]/route.ts           GET/PATCH/DELETE a session
  sessions/[id]/context/route.ts   GET ?leafId=&tail=&before= a page of a leaf's context (tail defaults to 50; before pages upward)
  sessions/[id]/export/route.ts    GET exported HTML
  sessions/[id]/fork/route.ts      POST copy the session's current branch into a new session, or { side: true } a side chat (never starts an AgentSession)
  sessions/delete/route.ts         POST { ids } delete sessions and their subagents (a project's Delete all sessions); running ones kept
  sessions/stats/route.ts          POST { ids } each session's tokens, cost, tool calls, active time (the agent switcher's rows)
  sessions/[id]/state/route.ts     GET live wrapper state while running
  sessions/search/route.ts         GET session search
  sessions/ui-state/route.ts       GET/POST sidebar pins, archive, project order and names (set, restore, pin-project, add-projects, move-project, rename-project)
  agent/new/route.ts               POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts              GET state | POST any command
  agent/[id]/events/route.ts       GET SSE stream
  agent/running/route.ts           GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts   GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts  POST OAuth logout
  auth/providers/route.ts          GET OAuth and API-key provider lists
  cwd/validate/route.ts            POST validate/select a cwd
  default-cwd/route.ts             POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts         GET file contents for viewer
  home/route.ts                    GET user home directory
  models/route.ts                  GET { models, modelList, defaultModel }
  models-config/route.ts           GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts   GET models.dev pricing presets
  models-config/discover/route.ts  POST fetch a configured provider's upstream model list
  models-config/test/route.ts      POST test a configured model/provider
  plugins/route.ts                 GET/POST package plugin management
  plugins/check/route.ts           POST check plugin package updates
  project-trust/route.ts           GET/POST project trust for package installs
  skills/route.ts                  GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts          POST install skills through npx skills add
  skills/search/route.ts           GET/POST skills.sh search
  subagents/settings/route.ts      GET/PUT built-in subagent feature setting
  worktrees/route.ts               GET/POST/DELETE git worktrees
  web-auth/route.ts                GET status | POST login | DELETE logout (browser password)
  extensions/[...path]/route.ts    GET/POST/PUT/DELETE/PATCH extension api dispatch + assets (dispatched behind the security gates; asset traversal protection)
  extensions/manifest/route.ts     GET client manifest (UI metadata + clientUrl + i18n)
  extensions/status/route.ts       GET full status (disabled/failed entries + insertion points/hooks/deps); management ops live in the aiti-extman extension
  extensions/reload/route.ts       POST hot reload (shutdown→loadAll→startAll)
  (extension management UI/install/online registry moved out of core → the external aiti-extman extension:
    /api/extensions/aiti-extman/{status,registry,ops})
  sessions/[id]/auto-name/route.ts POST generate a session title
  sessions/search/route.ts         GET session search
  agent/new/route.ts               POST { cwd, type: prompt|ensure_session (start only), message?, toolNames?, provider?, modelId?, thinkingLevel? }
  agent/[id]/route.ts              GET state (?systemPrompt=0: without the prompt) | POST any command
  agent/[id]/events/route.ts       GET SSE stream
  agent/[id]/lease/route.ts        POST reset the selected session's idle timer (with or without its stream; never starts one); reply: running, awaitingInput, subagentsActive
  agent/running/route.ts           GET running + awaiting-input session ids, sidebar pins/archive revision
  agent/debug/route.ts             GET ?session= the Debug panel's read-only snapshot: wrappers, streams, subagents, MCP, terminals, file watches
  auth/api-key/[provider]/route.ts POST/DELETE stored provider API key
  auth/login/[provider]/route.ts   GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts  POST OAuth logout
  auth/providers/route.ts          GET OAuth and API-key provider lists
  cwd/validate/route.ts            POST validate/select a cwd
  cwd/browse/route.ts              GET browse any readable directory for the cwd picker | POST create child directory
  default-cwd/route.ts             POST create ~/pi-cwd/YYYYMMDD (local date)
  home/route.ts                    GET user home directory
  open-in-explorer/route.ts        GET availability | POST open a cwd in the OS file manager (loopback only)
  files/[...path]/route.ts         GET ?type=list|read|download|meta|preview|watch | POST ?type=upload|upload-check|allow-link
  file-index/route.ts              GET file list for @-mentions
  git/status/route.ts              GET changed files for a cwd
  git/diff/route.ts                GET diff of one changed file
  worktrees/route.ts               GET/POST/DELETE git worktrees
  terminal/route.ts                POST create a terminal session
  terminal/[id]/route.ts           GET { id, cwd } (404 once closed; stream at [id]/events) | POST input/resize | DELETE kill
  mcp/route.ts                     GET [?cwd=] Settings › MCP overview, files only | POST add/enable/disable/remove/undo/set-enabled/set-exposure/set-in-project/sign-out
  mcp/test/route.ts                POST { scope, name, cwd? } test one server once (entry read from its file)
  mcp/sign-in/route.ts             POST { scope, name, cwd? } start or join an OAuth sign-in
  mcp/sign-in/[flowId]/route.ts    GET flow state (polled) | POST { redirectUrl } | DELETE cancel
  project-trust/route.ts           GET trust status + project .pi/mcp.json servers (files only) | POST trust, rebuild the cwd's wrappers
  tools/settings/route.ts          GET/PUT defaultTools switches: PowerShell (Windows), Code mode automatic/always; codemode.mode, codemode.inlineBudget
  cache-miss-notices/route.ts      GET/PUT pi's global showCacheMissNotices (Settings › General)
  models/route.ts                  GET ?cwd= { models, modelList, defaultModel, … }
  models/enabled/route.ts          GET/PUT enabledModels switches
  models/default/route.ts          PUT default model / reasoning level for new sessions
  models/refresh/route.ts          POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts           GET/PUT ~/.pi/agent/models.json
  models-config/catalog/route.ts   GET models.dev pricing presets
  models-config/discover/route.ts  POST fetch a configured provider's upstream model list
  models-config/test/route.ts      POST test a configured model/provider
  plugins/route.ts                 GET/POST package plugin management
  plugins/check/route.ts           POST check plugin package updates
  skills/route.ts                  GET/PATCH loaded skills, disable-model-invocation
  skills/content/route.ts          GET one loaded skill's bounded Markdown source, or ?document= a Markdown file in its folder
  skills/install/route.ts          POST install skills via npx skills add
  skills/search/route.ts           POST skills.sh search
  subagents/settings/route.ts      GET/PUT built-in subagent switch and maxConcurrent
  web-auth/route.ts                GET status | POST login | DELETE logout (browser password)
  provider-usage/query/route.ts    POST provider usage quotas
  push/config/route.ts             GET VAPID public key
  push/subscribe/route.ts          POST register a push subscription
  app-update/route.ts              GET current vs latest published pi-web version

lib/
  agent-client.ts           typed fetch helper for /api/agent commands
  missing-cwd.ts            client-safe `reason: "cwd-missing"` refusal of a folder that no longer exists: error class, body fields, parsing
  debug-types.ts            client-safe shapes of the Debug panel: GET /api/agent/debug and the page's own snapshot
  debug-snapshot.ts         buildDebugSnapshot(): the debug route's synchronous field reads, each source guarded
  stream-client.ts          an event stream's reported address and "Chrome · macOS" label, for the Debug panel's connected pages and SSE titles only
  page-stream-registry.ts   open terminal and file-watch streams with their page (`?holder=`) and client, for the Debug panel's connected pages
  page-debug.ts             client: the page's id (`?holder=` of its streams), EventSources, visibility history, protocol and running-poll record (Debug panel)
  file-watch-registry.ts    open ?type=watch streams, counted on globalThis for the Debug panel
  rpc-manager.ts            AgentSessionWrapper, registry, startRpcSession
  side-chat-client.ts       client: ask the fork route for a side chat, refusals as translated notices
  session-reader.ts         SessionManager wrappers, path cache, buildSessionContext adapter
  session-fork.ts           forkSessionBranch(): the sidebar's Fork, a leaf-branch copy on a fresh SessionManager named after its source, typed refusals; createSideSession(): the same copy as a side chat
  side-session.ts           a side chat's metadata entry, allowed tools, hidden boundary message, own entries for usage
  session-fork-name.ts      client-safe Fork naming: source title + " · " + 4 hex; splitting the suffix off for the row and toast
  session-delete.ts         deleteSessions(): session files with their subagents, re-parenting what stays, wrapper shutdown, pins/archive cleanup
  session-tree.ts           sidebar row model: pinned section, project groups and their order, archived predicate, virtual rows, drop targets
  session-ui-state.ts       pi-web-session-state.json (pins, archive, project order and names): lock, atomic write, revision, corrupt backup
  session-ui-state-shared.ts client-safe types and rules of that state: request parsing, apply, undo snapshot
  sidebar-prefs.ts          per-browser sidebar tab, group expand choices, archive folds, pinned-section collapse, files-section fold, changed files as list or tree, folders found outside git
  sidebar-actions.ts        session row menu entries, a project group's name entries and rename request, fork refusal messages, delete-all requests
  session-links.ts          same-instance links: a session's (?session=<id>), a fresh composer's (?cwd=<dir>); the plain-click rule the sidebar keeps in the page
  new-session-context.ts    client-safe: what the project/worktree pickers show (project, worktrees, project list), lag-safe contextForCwd, the directory a group's + and Open in new tab use
  normalize.ts              normalizeToolCalls(): file-format vs our toolCall field names
  message-keys.ts           client-safe React keys of chat messages: a run's messages keep theirs when the file is read again
  types.ts                  shared TypeScript types
  pi-types.ts               local structural types for pi SDK objects
  pi-sdk-internals.ts       loader for SDK modules the package does not export (MCP connection, config, OAuth)
  tool-presets.ts           PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts browser-persisted default preset for fresh sessions
  tool-fields.ts            a tool call's arguments as flat rows: all of them or no table
  builtin-extensions.ts     codemode / tool-search / mcp built-ins, sandbox self-test, -builtin: switches
  codemode-settings.ts      Code mode automatic/always (+codemode in global defaultTools), codemode.mode and inlineBudget; project overrides
  codemode-view.ts          display helpers for codemode cards
  global-settings-file.ts   locked read-modify-write of global settings.json (SettingsManager's lock)
  regular-file.ts           readRegularFileText(): non-blocking read of a regular file only, optional size cap
  default-preferences.ts    write defaultModel/defaultThinkingLevel; detect project shadowing
  deferred-provider-models.ts models of providers an extension registers only at session_start, re-added to listings
  enabled-models.ts         pure minimal-edit engine for the enabledModels pattern list
  enabled-models-runtime.ts SDK adapter for enabledModels: pattern resolution, provider kinds, settings IO
  model-context.ts          client-safe: managed models' contextWindow overrides in the models.json draft, the Save check
  model-image-limits.ts     client-safe: a custom model's inputLimits.images.resize.maxBytes in the draft, the Save check
  model-provider-check.ts   client-safe: Save refuses a models.json provider entry pi rejects on its own (Add provider's empty stub, oauth without a Base URL)
  subagent-settings.ts      read/write ~/.pi/agent/agents/settings.json
  file-access.ts            allowed file roots for /api/files and worktrees
  file-upload-client.ts     browser upload to /api/files ?type=upload, shared by the explorer and chat drops
  linked-directory.ts       directory links leading outside the allowed roots + the allow-link check
  file-paths.ts             client/server path encoding helpers
  file-version.ts           a watched file's size+mtime version: viewers skip reloading an unchanged file on reconnect
  html-sandbox-polyfill.ts  in-memory localStorage/sessionStorage shim injected into the sandboxed HTML preview's srcDoc
  delimited-table.ts        client-safe CSV/TSV parsing (RFC 4180, delimiter detection, file line per record) and table layout
  file-tree-visibility.ts   which entries the file tree lists (git check-ignore, name-list fallback)
  file-tree-expansion.ts    the file tree's open directories per cwd: page-memory LRU of 20 folders
  display-path.ts           display-only ~ / ./ path shortening for settings panels
  default-cwd.ts            dated ~/pi-cwd/YYYYMMDD path for "Use default directory"
  worktree.ts               project/worktree resolution and git worktree operations
  draft-store.ts            local draft persistence
  extension-ui-queue.ts     FIFO queues for extension dialogs and custom panels, by request id; isBlockingExtensionUiRequest() (which method a run waits on)
  extension-ui-theme.ts     the pi Theme extension panels, widgets and statuses get: pi's system theme for a terminal reporting no colors (ANSI palette), plain text until it loads
  favicon-badge.ts          the tab's favicon badge: awaiting and unread counts drawn over the stock icon
  session-stats-format.ts   client-safe compact counts, costs and active durations of the stats toolbar and agent switcher
  turn-duration.ts          getTurnDurationMs() / formatTurnDuration(): a finished turn's length from its anchor to its last response's end, on pi's timestamps
  transcript-notices.ts     client-safe: showCacheMissNotices notices on chat messages, TUI number formats, a fold's cache-miss sum
  transcript-notices-server.ts the notices derived from session entries (cache-stats port), live ones for message_end, the setting
  markdown.ts               shared markdown helpers
  markdown-blocks.ts        splitMarkdownBlocks(): where a streaming reply may be cut into blocks parsed apart
  highlight-queue.ts        code fences past a task's highlight budget get their colors in idle slices
  prism-languages.ts        loadPrismLanguages(): every Prism language in a chunk of its own, loaded when a highlighter first needs it
  gfm-autolink-email-loader.cjs  bundler loader: remark-gfm's email regex without a lookbehind literal
  node-cli.ts               locate bundled npm-cli.js / npx-cli.js to spawn npm/npx without a shell (Windows)
  npx.ts                    npx runner for skill install
  plugin-updates.ts         npm view update checks for /api/plugins/check
  jsonc.ts                  JSON with comments and trailing commas (models.json is read through it)
  shell-words.ts            split a pasted command line into words without a shell; refuses | && ; redirects $(…)
  key-serializer.ts         serializeByKey(): one globalThis promise chain per key
  stacked-dialog.ts         Escape and focus handling for Settings and dialogs stacked above it
  project-trust.ts          project trust status and decisions; fresh-folder trust-and-write
  mcp-host.ts               per-session MCP host: registers mcp.json servers before prompts, reports status
  mcp-transport.ts          MCP transport factory; stdio gets a sanitized env, never PI_WEB_PASSWORD
  mcp-command.ts            client-safe: who owns /mcp (built-in or another extension)
  mcp-read-only-policy.ts   read-only sessions block MCP tools without readOnlyHint (nested calls too)
  mcp-config-key.ts         canonicalJson() and mcpConfigKey(), the per-process HMAC statuses are keyed by
  mcp-config-values.ts      client-safe: the values pi resolves and the PI_WEB_PASSWORD rule
  mcp-config-read.ts        Settings › MCP reads of both mcp.json files; nothing resolved or run
  mcp-config-file.ts        the mcp.json writer: SDK editor's bytes, lock, atomic write, typed refusals
  mcp-override.ts           project overrides of global servers: the SDK's isOverride() and loader refusals
  mcp-json-error.ts         JSON.parse error messages that never quote the source
  mcp-undo.ts               removed mcp.json entries kept 60 s for undo; only a token reaches the browser
  mcp-status.ts             last known connection state per mcp.json entry (tests and sessions)
  mcp-test.ts               Settings › MCP Test: one bounded, masked SDK connection (sign-in reuses its steps)
  mcp-entry-request.ts      route checks before connecting one mcp.json entry (Test, sign-in); guards /api/mcp and /api/project-trust share
  mcp-sign-in.ts            Settings › MCP OAuth sign-in flows (as pi mcp login), polled by id
  mcp-sign-out.ts           OAuth store keys (name + URL); guard barring token writes by runs started before a sign-out
  mcp-secrets.ts            pure secret classification and masking for MCP config values
  mcp-add.ts                POST /api/mcp add's checks before it writes
  mcp-import.ts             pure paste importer (+ mcp-import-core/json/cli/links.ts)
  mcp-server-display.ts     client-safe display helpers for McpServerInfo (hidden-character escapes, labels)
  mcp-tool-display.ts       server/tool label of an mcp__ call from its result details, never the name

components/
  AppShell.tsx             layout, URL state, tab management
  SessionSidebar.tsx       toolbar row (Sessions | Files tabs, or the Pi Web brand with the files below them; new, search): tree, archive, menus, toast; files section (resizable, foldable; one header row with the file keys and changed-files count, the picker's row) or tab (picker boxes + file buttons), FileExplorer
  PiWebTitle.tsx           the sidebar's "Pi Web" brand (files below the sessions only): a click scrambles it into the versions
  SessionTree.tsx          virtualized rows of the session tree and the archive view
  SidebarMenu.tsx          sidebar popup menu (bottom sheet on phones), portaled to body: filter field, item secondary actions, the files tab's classic look
  ProjectWorktreePicker.tsx project and worktree boxes + menus: the files' (one row below the sessions, stacked in the tab) and the new-session bar's
  NewSessionContextBar.tsx the picker in its own row under the brand, right above the empty new-session composer; moves go through the sidebar
  WorktreeCreateForm.tsx   "New worktree…" form, a SidebarMenu body
  SidebarToast.tsx         sidebar one-line toast: archive Undo/View, failed saves
  SidebarIcons.tsx         sidebar stroke icons
  ChatWindow.tsx           chat composition + completion sound
  ChatInput.tsx            input bar + model/thinking/tools/compact controls
  MessageView.tsx          one message (user/assistant/toolCall/toolResult)
  CodemodeToolView.tsx     codemode card: the tool calls its script made
  BranchNavigator.tsx      in-session branch switcher
  ChatMinimap.tsx          scroll minimap beside the message list
  MarkdownBody.tsx         markdown renderer
  SvgBlock.tsx             a ```svg fence: preview only as an <img> data URL, source toggle, zoom, download (MermaidBlock's pieces)
  ModelsConfig.tsx         Settings › Models: models.json editor
  EnabledModelsSection.tsx model switches inside ModelsConfig (enabledModels)
  ModelContextWindow.tsx   a managed model row's context-window field (blank: no override)
  OAuthPastePanel.tsx      paste box for a sign-in's redirected address or code (Models, MCP)
  ProjectTrustDialog.tsx   trust confirmation listing the project's MCP servers
  AgentsConfig.tsx         built-in subagent toggle + agent profile editor
  SessionChatPanel.tsx     right-panel tab of a subagent or side chat: a ChatWindow for that session
  DebugPanel.tsx           Debug top panel (toolbar, left of the stats): page and server state, its own tick and poll, error boundary
  debug-panel-state.ts     pure helpers of DebugPanel: formatting, server clock, poller, issues, session grouping, poll samples
  PluginsConfig.tsx        Settings › Plugins: installed package plugins
  SkillsConfig.tsx         Settings › Skills: loaded, search, install
  McpConfig.tsx            Settings › MCP: servers, switches, exposure, remove/undo, Test, sign-in, Code mode, trust
  mcp-config-helpers.ts    pure helpers and requests for McpConfig
  McpSignIn.tsx            a server's Sign-in row in Settings › MCP
  mcp-sign-in-helpers.ts   pure helpers and requests for McpSignIn
  McpAddServer.tsx         Settings › MCP add pane: paste, preview, values, name, scope
  mcp-add-helpers.ts       pure helpers and the add request for McpAddServer
  FileExplorer.tsx         file tree in the sidebar
  FileIcons.tsx            file icon helpers
  FileViewer.tsx           file content in a tab
  DelimitedTable.tsx       a CSV/TSV file's Preview: virtualized table, gutter of file lines
  TabBar.tsx               file panel tab bar (file, terminal and subagent tabs)
  TranscriptNotices.tsx    a message's cache and cost notice lines, the fold header's cache-miss text

hooks/
  useAgentSession.ts       messages, streaming, SSE, fork/navigate, reconciliation; built-in slash commands (/session, bare /mcp)
  useStreamingSelector.ts  one value of the streaming store (lib/streaming-message.ts): a chunk re-renders only its subscribers
  useAudio.ts              completion sound + AudioContext unlock
  useDragDrop.ts           chat drop zone: dropped files, folders marked
  useFilesPlacement.ts     per-browser choice: the desktop sidebar's file browser below the sessions or in its own tab
  useGroupDrag.ts          dragging a sidebar project group: mouse threshold, touch/pen long-press, auto-scroll, drop
  useIsMobile.ts           responsive breakpoint
  usePageHidden.ts         HIDDEN_PAGE_GRACE_MS; true once the page has been hidden that long (file watches pause)
  useSessionUiState.ts     sidebar pins, archive, project order: optimistic writes in order, refetch on revision change
  useSidebarMotion.ts      the sidebar's fold and archive-view motion: phase, end fallback, reduced motion, what shows meanwhile
  useKeyboardShortcuts.ts  Esc stops the running agent unless a field or nearer handler took it; Ctrl+Alt+N
  useResizablePanel.ts     drag/keyboard panel size kept per key; persistClamp: false never saves a short window's clamp
  usePrismLanguages.ts     true once the Prism languages are loaded; starts the load for a highlighter
  useTheme.ts              theme state
  useTerminalTheme.ts      the terminal's own dark/light choice (localStorage), apart from the app theme
  ext/types.ts         PiWebExtension contract (server hooks + UI metadata + ExtCoreApi data contract)
  ext/loader.ts        loads ~/.pi/web/extensions/<id>/ via jiti (moduleCache:false enables reload)
  ext/registry.ts      globalThis.__piWebExt singleton: loadAll/startAll/shutdown/reload/api dispatch/middleware chain/manifest/assetPath traversal protection
  ext/core.ts          makeExtCore(): listSessions/getRunningSessionIds/getHomeDir
  ext/data-dir.ts      code at ~/.pi/web/extensions, data at ~/.pi/web/data/<extId>/ (overridable via PI_WEB_EXTENSIONS_DIR/PI_WEB_DATA_DIR)
  ext-ui-store.ts      client slot registry (window.__piWebExtUI + subscribe revision)
  base-path.ts         client-side basePath helpers (NEXT_PUBLIC_BASE_PATH)
(note: draft persistence moved out of core → the aiti-draft-keeper extension (composer contract v2); startup-preferences.ts was renamed default-preferences.ts upstream)

components/ (aiti extension slots, appended after the upstream components list):
  ExtSlots.tsx         ExtSlotsProvider (fetches manifest + dynamic-imports client bundles + register(ctx)) + <ExtSlot name=.../> (sidebar/sessionRowActions inside SessionSidebar)
```

---

## extensions/ (ported pi-web extension packages)

`extensions/` is a one-way mirror of the pi-web extension packages from the private source repo (`pi-web-ext/`) (the aiti ecosystem: external agent adapters, service-tunnels, session-manager, editors, terminals, …), for extman to install from local paths / git sources. **Not part of this Next.js app**: excluded from tsc/eslint (`tsconfig.json` exclude, `eslint.config.mjs` ignores); `next build` never touches it.

- **One-way snapshot, do not edit**: fix bugs in the private source repo, then re-run its `scripts/sync-extensions-to-aiti-ai.mjs` to re-mirror (the sync applies mechanical redaction automatically: private registry URLs, internal domains/IPs/ports/user paths neutralized).
- **Layout**: each extension is an independent package (`node_modules`/`dist` are gitignored); before use run `npm install && npm run build:client` (if it has a client) in the extension directory.
- `_shared/` is the extension shared layer (`@aiti-ai/ext-shared`, runtime deps of multiple extensions); `sm-demo-source/` is the session-manager third-party agent source template.
- service-tunnels was once excluded from this repo; that constraint was lifted when the extension sources went public.

---

## Topic Notes

Design decisions and traps live in `docs/agents/`, one note per area. Read every note whose files a change touches before making it. Add new notes to the area's file, not here.

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, the sidebar's on-disk Fork, session file rewrites, toolCall normalization, a run's message keys across the file read, SSE reconnect and tool events, a tool card's flat arguments as rows, transcript system / usage / context-edit entries, running-state polling, custom-message collapsing, streamed chunks re-rendering only the reply, streaming markdown block by block, hand-written anchors in rendered Markdown landing after the sanitizer's id prefix, Windows drive-letter Markdown links becoming `file:///` before sanitizing, user messages' raw HTML shown as text, ```svg fences previewed only as an `<img>`, display math's Copy button, long thinking rendered in pieces, a finished turn's duration, history caches (tool-result images, subagent runs, session views) and deferred code highlighting with Prism languages loaded on demand, a patch shown in one column or two, the session sidebar (toolbar row and its brand, project groups, their order and display names, pins, archive, new-session project adoption, the files below the sessions or in a tab), the project/worktree bar above a fresh composer (the header: brand, then the bar) and what it carries across the remount, exported HTML, the extension status bar and its `command:` buttons, extension UI colors (pi's palette theme, the page's light/dark ANSI palette), cache and cost notices (`showCacheMissNotices`), the read-only Debug panel (connections, server state, sessions the server holds). Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/session-fork*.ts`, `lib/session-delete.ts`, `lib/normalize.ts`, `lib/message-keys.ts`, `lib/session-tree.ts`, `lib/session-ui-state*.ts`, `lib/sidebar-prefs.ts`, `lib/sidebar-actions.ts`, `lib/session-links.ts`, `lib/favicon-badge.ts`, `lib/new-session-context.ts`, `hooks/useAgentSession.ts`, `hooks/useSessionUiState.ts`, `hooks/useSidebarMotion.ts`, `hooks/useGroupDrag.ts`, `hooks/useFilesPlacement.ts`, `hooks/useResizablePanel.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/SessionSidebar.tsx`, `components/PiWebTitle.tsx`, `components/SessionTree.tsx`, `components/SidebarMenu.tsx`, `components/SidebarToast.tsx`, `components/SidebarIcons.tsx`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/WorktreeCreateForm.tsx`, `handleNewSession`, `handleSelectSession` and the bar's handlers in `components/AppShell.tsx`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `lib/message-display.ts`, `lib/patch.ts`, `components/FileViewer.tsx`, `components/MarkdownBody.tsx`, `lib/markdown.ts`, `lib/markdown-blocks.ts`, `lib/streaming-message.ts`, `hooks/useStreamingSelector.ts`, `lib/turn-duration.ts`, `components/MermaidBlock.tsx`, `components/SvgBlock.tsx`, `lib/highlight-queue.ts`, `lib/prism-languages.ts`, `hooks/usePrismLanguages.ts`, `lib/session-view-cache.ts`, `components/CodemodeToolView.tsx`, `components/ExtensionStatusBar.tsx`, `components/ExtensionWidgets.tsx`, `lib/extension-ui-theme.ts`, `components/AnsiText.tsx`, `lib/transcript-notices*.ts`, `components/TranscriptNotices.tsx`, `app/api/cache-miss-notices/**`, `lib/tool-fields.ts`, `lib/debug-*.ts`, `lib/stream-client.ts`, `lib/page-stream-registry.ts`, `lib/page-debug.ts`, `lib/file-watch-registry.ts`, `components/DebugPanel.tsx`, `components/debug-panel-state.ts`.
- [tools.md](docs/agents/tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-override.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, providers registered at session_start, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, managed models' context-window overrides, provider auth listing and credentials, the extension-loaded runtime those routes share. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/model-runtime.ts`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-context.ts`, `lib/model-image-limits.ts`, `lib/model-provider-check.ts`, `lib/model-catalog-refresh.ts`, `lib/deferred-provider-models.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelContextWindow.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility and its open directories per folder, uploads and chat file drops, the sandboxed HTML preview's storage shim, the source view's languages by extension, the CSV/TSV table view, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/file-tree-expansion.ts`, `lib/file-upload-client.ts`, `lib/file-version.ts`, `lib/html-sandbox-polyfill.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/FileExplorer.tsx`, `lib/delimited-table.ts`, `components/DelimitedTable.tsx`, the table branch of `components/FileViewer.tsx`, `hooks/useDragDrop.ts`.
- [settings-ui.md](docs/agents/settings-ui.md): General's sidebar file-browser choice, Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `lib/skills-service.ts`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`, `hooks/useFilesPlacement.ts`; also before adding a settings section or add pane.
- [side-sessions.md](docs/agents/side-sessions.md): side chats (ADR 0007): the Fork copy with a `pi-web:side` entry inside the bounded head read, the `side` relation kind and family fold, the parent's session minus tools (an allow-list of exactly its tools), the hidden boundary message and where each provider's request puts the tool change, `/side`, the tab shared with subagents, usage that skips inherited entries. Files: `lib/side-session.ts`, `lib/session-fork.ts`, `lib/session-family.ts`, `lib/session-delete.ts`, `lib/session-reader.ts`, side handling in `lib/rpc-manager.ts`, `app/api/sessions/[id]/fork/route.ts`, `app/api/sessions/stats/route.ts`, `components/SessionChatPanel.tsx`, `components/TabBar.tsx`, `components/AgentSessionPanel.tsx`, `components/ChatInput.tsx`, `hooks/useAgentSession.ts`, `lib/side-chat-client.ts`, side handling in `components/AppShell.tsx`.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications, the subagent tab. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`, `components/SessionChatPanel.tsx`.
- [client-platform.md](docs/agents/client-platform.md): the global shortcuts (Ctrl+Alt+N on macOS's dead-key Option+N and Windows AltGr, Esc stacking), mobile software keyboard and viewport height, the terminal's shell (PowerShell first on Windows), the terminal's extra keys, its own dark/light theme and its font size following the chat's, completion sound, the launcher opening the browser only after the first page is served. Files: `hooks/useKeyboardShortcuts.ts`, `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, `terminalShell()` in `lib/terminal-manager.ts`, `components/TerminalExtraKeys.tsx`, `lib/terminal-extra-keys.ts`, `lib/terminal-theme.ts`, `hooks/useTerminalTheme.ts`, `terminalFontSize()` in `hooks/useChatAppearance.ts`, the keyboard-open CSS, `bin/browser-opener.js`, the browser opening in `bin/pi-web.js`.

---

## Old Safari (iOS 16.2)

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `handleAgentEvent` in `hooks/useAgentSession.ts` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and keeps Pi's default behavior; an empty array means Chat only. Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Crossing the Chat-only boundary rebuilds the wrapper; changing between nonempty presets updates it in place. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; loaded extensions cannot expose the reserved `Agent`, `get_subagent_result`, or `steer_subagent` tools to a subagent. See `docs/adr/0002-chat-only-tool-selection.md`.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Queue persistence & crash recovery (`lib/queue-store.ts`)
pi keeps steer/follow-up queues in memory only — a server restart would lose them. The wrapper mirrors every queue mutation to a per-session sidecar `<session>.jsonl.queue.json` (atomic tmp+rename). **The sidecar only saves — it never auto-delivers.**

- Wrapper state: `queueMirror` (live queue w/ images), `queueRecovery` (orphans awaiting user decision), `pendingQueueHints` (FIFO image hints — pi reports queue items by text only and template expansion can rewrite text, so hints are consumed FIFO per kind).
- Mirror sync: `queue_update` events fire on enqueue / drain (message_start) / clear — `reconcileQueue()` rebuilds the mirror from pi's text arrays.
- Enqueue points: `send("prompt")` with `streamingBehavior` while streaming, `send("steer")`, `send("follow_up")`, `clear_queue`.
- **Prompts during compaction become follow-ups**: pi rejects `prompt()` while compaction runs ("Cannot submit a prompt while compaction is in progress"). `case "prompt"` therefore detects `inner.isCompacting` and routes the message through `inner.followUp()` (slash extension commands still go through `prompt()` so they execute immediately, checked via `isRegisteredExtensionCommand`). The client (`handleSend` in `useAgentSession`) mirrors this check via `isCompactingRef` and skips the optimistic bubble/`agentRunning` — the message lives in the queue panel instead. Delivery: a `compaction_end` listener in the wrapper calls `runAgentContinue()`, which promotes the first queued entry to a real prompt and re-queues the rest (identical to recovery's "re-queue & continue"). When auto-compaction runs inside an active agent loop, `runAgentContinue`'s `isStreaming` guard bails and pi's own `hasQueuedMessages()` continuation delivers the queue. Race-proof both ways: a prompt sent just before compaction starts still converts server-side, and a follow-up routed when compaction already finished runs as a normal prompt.
- After a restart (or wrapper idle-destroy), every sidecar entry becomes a `pendingRecovery` item exposed via `get_state.pendingRecovery` and `GET /api/sessions/[id]/queue-recovery` (lightweight file read — does NOT create an AgentSession; when a wrapper is alive its in-memory recovery list wins).
- `POST /api/agent/[id]` commands: `resolve_recovery {keep, discard, continueRun}` (keep re-queues via `inner.steer()/followUp()`; `continueRun` invokes `this.inner.agent.continue()` directly — AgentSession has no public continue; events/persistence still flow via its subscriptions), `export_queue`, `import_queue`.
- UI: `QueueRecoveryDialog` (checklist + re-queue / re-queue & continue / discard / export .md/.json / import / dismiss), export/import buttons in the ChatInput queued banner. `lib/queue-export.ts` is client-safe (blob download + `parseQueueImport` for the round-trip).
- Deleting a session removes the sidecar (`removeQueue`). Image-only queued messages never leave pi's `_steeringMessages` (contentText("") is falsy) — they may surface as already-delivered in recovery; user discards manually.
- **Soft delete (trash)**: `remove_queue_item` and `clear_queue` are SOFT by default — the entry moves to the sidecar's `trash` section (file version 2; v1 sidecars migrate on load) instead of being dropped. The UI offers an 8s undo toast (restores at the original position via `restore_trash_item { id, index? }`) plus a trash bin popover (restore appends to its kind / purge with two-step confirm via `purge_trash { ids? }`). `permanent: true` on `remove_queue_item` skips the trash — used by dispatch paths (steer-send) where the entry was *sent*, not deleted, so it must not linger in the trash. Trash survives restarts (`loadQueueRecovery` restores it) and is deleted with the session.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.
- A UNC cwd (`\\host\share\dir`) must survive the `/api/files/[...path]` round-trip. `encodeFilePathForApi()` folds the `//` root into the first segment (`%2F%2Fhost`) because a literal `//` URL prefix is 308-normalized away before routing; `filePathFromApiSegments()` decodes it back. Never split UNC paths into segments and rejoin them — that silently turns `\\host\share` into the relative-looking `host/share` and every allow-check fails with 403.

### Plugins and skills
- **Extension capability takeover (`ui.provides`)**: an extension declares the built-in capabilities it takes over in `ui.provides: string[]` (capability names live in `EXT_PROVIDES` in `lib/ext/types.ts`, e.g. `"session-delete"`). The manifest ships as-is and the client queries it with `useExtProvides()` — when a capability is declared, the sidebar hides the built-in delete button (the delete flow belongs to the extension, e.g. session-manager's archive-then-delete); with no declarer the built-in button shows as usual. Adding a capability: register it in `EXT_PROVIDES` + gate the corresponding built-in UI. Registered capabilities: `session-delete` (session deletion takeover), `session-agent-source` (external agent session source; session-manager §4.8 slot contract: normalized pulls across the manifest/list/session endpoints).
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Built-in subagents
- The global `builtInEnabled` switch is persisted in `~/.pi/agent/agents/settings.json` and defaults to `false` when the file or field is absent. Malformed settings fail closed; atomic updates preserve unknown fields.
- The inline built-in extension factory is always present so reloading an existing wrapper can apply setting changes, but it registers no tools while disabled. After changing the switch, the user must explicitly reload the current session.
- When enabled, only a recognized legacy `pi-subagents` extension that registers any reserved tool (`Agent`, `get_subagent_result`, or `steer_subagent`) is removed. Unrelated extensions remain loaded, and resolved conflict diagnostics are discarded.
- Runtime `Agent` dispatch checks the setting again so a stale tool call cannot start a subagent after the feature is switched off.
- See `docs/adr/0003-built-in-subagent-toggle.md` for the precedence and persistence rationale.
- Agent profile files (`~/.pi/agent/agents/*.md`, project `.pi/agents/*.md`) are shared with other runtimes, so a save round-trips the frontmatter keys this app does not own (`name`, `allowed_subagents`, `exclude_extensions`, `disallowed_tools`, …) and carries foreign `ext:` tool selectors through. Managed keys are exactly `description`, `display_name`, `tools`, `load_skills`, `load_extensions`, `enabled`, `inherit_context`, `run_in_background`, `model`, `thinking`, `max_turns`.
- The `skills` / `extensions` spellings pi-subagents reads are seeded on first save and kept in step while they are booleans; a hand-authored whitelist such as `extensions: pi-advisor-flow` is never rewritten, and the two flags fall back to those aliases when `load_skills` / `load_extensions` are absent.

### Web password throttling
- `lib/auth-throttle.ts` is deliberately global, not per-IP: Next 16 route handlers have no socket address and `x-forwarded-for` is spoofable, while the server binds `127.0.0.1` for a single operator. Failures double the delay (1s → 60s cap) for everyone; a success or 5 idle minutes resets it. The reset window must stay longer than the max delay or waiting out one block restarts the burst.
- State lives on `globalThis` under `Symbol.for("pi-web:auth-throttle")` so it survives hot reload and is shared by every module instance. Tests reset it with `recordAuthSuccess()`.
- Only `POST /api/web-auth` is throttled. The Basic auth branch in `proxy.ts` is not, because sharing state between the proxy bundle and route handlers has not been verified.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.
- `/` renders entirely on the client, so one script chunk the browser cannot parse is a blank page. Next 16 targets Safari 16.4+; the `browserslist` in `package.json` lowers Safari and iOS to 16.2 so SWC turns class `static {}` blocks into private static fields. That covers Next's client runtime; other node_modules keep their syntax unless listed in `transpilePackages` (mermaid and `@mermaid-js/parser` are, for their lazy diagram chunks). Keep the other browserslist entries at Next's defaults.
- Never write a RegExp lookbehind (`(?<=`, `(?<!`) in client code: SWC cannot downlevel it and Safari parses it only from 16.4. `lib/markdown.ts` emulates its leading lookbehinds with `replaceNotPrecededBy()`. A lookbehind built at runtime (`new RegExp("(?<=…)")` in `try`) fails only when run; that is how `lib/gfm-autolink-email-loader.cjs` fixes `mdast-util-gfm-autolink-literal`'s email regex. The loader is registered for webpack and Turbopack in `next.config.ts` and fails the build if that regex changes upstream.

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

`SessionContext.entryIds[]` parallels `messages[]`: each displayed message's `.jsonl` entry id, used for fork and navigate_tree.

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

## Service port proxy & expose (extracted into the service-tunnels extension)

Service port discovery / virtual-host proxying / tunnels / auth / self-exposure have all moved out of core into the
`service-tunnels` extension (source lives in the external private workspace, not in this repo; deployed to
`~/.pi/web/extensions/service-tunnels/`; the private registry address and upgrade flow are deployment-environment
configuration — see the internal workspace docs):

- The extension's `server.startup` creates the library singleton (`globalThis.__piServiceTunnels`); `server.middleware`
  handles service vhosts (`st.proxy.parseHost/resolve`) and the allowlocal direct-access gate ahead of the core gates;
  `server.api` serves `/api/extensions/service-tunnels/*` (discovery/expose/tunnels/users/TOTP/self-exposure).
- Extension deps use standard npm (`node_modules` alongside the extension dir); the loader resolves bare specifiers
  against the extension directory (`lib/ext/loader.ts` jiti id = extension entry), so extensions can carry standard
  node_modules. The private registry address is deployment-environment configuration, not committed here.
- **Source public release (landed 2026-10-30)**: the source is now public via the aiti-ai release
  repo `extensions/service-tunnels/` (redacted mirror, one-way sync from the private source repo — see its
  `scripts/sync-extensions-to-aiti-ai.mjs` and `docs/aiti-ai-extensions-port-plan.md`);
  the repo still does not carry the full service-tunnels sources; this note replaces the original "not in this repo" constraint.
- core keeps only the generic security gates (DNS-rebinding + `PI_WEB_PASSWORD`); `request-security.ts`
  still reads the extension-written `globalThis.__piWebExposeConfig`/`__piWebAllowHostsOverride` for allowHost exceptions.
- The test-services virtual host `<port><suffix>` (default `.pi.localhost`) behaves as before the migration; with the
  extension not loaded there is no vhost/self-exposure (`/api/extensions/service-tunnels/*` 404s) and core is unaffected.
- WebSocket upgrades are NOT proxied by the middleware (Next no-ops non-HMR upgrades) — Vite HMR etc. need direct localhost or a tunnel.
- `GET /api/services?refresh=1` lists discovered ports + `serviceHostSuffixes`; `GET /api/service-tunnels` returns exposes/status/provider order/default provider/user managers/tool status/allow-download. The top-toolbar globe opens `ServicesDialog` (10s auto-refresh): **Ports** tab = per-port access methods (direct + virtual-host URLs, `window.open` with `noopener,noreferrer`), protocol auto-detect (http/https/tcp), expose form (tunnel type + auth provider, schema-driven), active exposes (stop, nginx logs), allow-tool-download toggle; **Users** tab = provider user management + TOTP 2FA enroll/activate.
- **Provider knowledge lives in the library**: pi-web consumes `providerOrder`/`defaultProvider`/`userManagers`/`tunnelSchemas`/`tunnelTcpSupport` — no provider names hardcoded in pi-web (tcp exposes carry no auth: the library's tcp path ignores the provider).
- Tests: `node --test lib/service-ports.test.mjs lib/request-security.test.mjs lib/web-auth.test.mjs` (middleware-safe helpers, discovery cache, gates).

## No internal addresses in code

- **Real deployment addresses must never appear in code/tests/comments** (internal IPs, internal deployment domains,
  production ports, …) — the repo is publicly visible (including external mirrors) and would leak the internal topology.
- For example hostnames use RFC 2606 reserved domains (`example.com`, `web.example.com`,
  `attacker.example`, …); use generic ports (3000/8443/443); loopback `127.0.0.1`
  and RFC 1918 private ranges (`192.168.x.x`) are acceptable only as generic examples.
- Deployment-specific configuration lives only in the runtime environment (systemd unit `Environment=`, nginx
  configs, `~/.pi/service-tunnels`, …), never in the repo.
- This applies to AGENTS.md itself — these rules must not name internal domains either.
- The discipline also covers the rules/tools themselves (settled by the 2026-11-12 audit): sensitive patterns and
  private-registry URLs live in the machine-local `~/.aiti/release-redact.json` (CI injects the same JSON via the
  `AITI_RELEASE_REDACT` secret/env) and are loaded at runtime by release-audit, publish-all, the prepack scrubber
  and the pack self-check. Never commit them as source literals — and never as fragmented/obfuscated forms either:
  obfuscation is not redaction.
- Published npm tarballs must not carry build-machine absolute paths: pi-web relies on the prepack scrubber
  (`scripts/sanitize-npm-package.mjs`) + `files` excluding `.next/trace|trace-build|diagnostics` + the pack self-check
  as a backstop — do not bypass them when changing the release flow.
- Official npmjs publishes go only through the GitHub Actions workflows (`publish.yml` / `publish-npm.yml`);
  local machines publish to the private registry for verification only, never straight to the official registry.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Language discipline (commits & comments, effective 2026-11-08)

- **Commit messages are English-only** across all repos (aiti-ai / mirrors and work branches). Technical terms, commit hashes, version numbers and file paths stay verbatim; no Chinese in subjects or bodies.
- **Code comments default to English** for new code and rewritten sections. Formal localized content documents (README.zh-CN.md, Chinese pages under aiti-docs, Chinese SKILL.md bodies) are exempt — content language follows the document's purpose.
- **The public surface** (github.com/aiti-ai/aiti-ai and the aitiai/pi-web Docker Hub) is the public face: commit messages, code comments, workflow and tooling comments are English-only. Legacy Chinese comments in extensions/ are cleaned up opportunistically (whichever file you touch, anglicize its comments as you go) — no one-shot bulk translation planned.
- **History was rewritten on 2026-11-08** (git filter-repo): every Chinese commit authored by Wind Li/wind was anglicized (71 precisely translated; the rest had Chinese lines stripped). Upstream community authors (TossPig, Xie Kaiwen, Jiang Jun, …) keep their original PR squashes out of respect for attribution — same for their Co-authored-by trailers. Pre-rewrite backup: `/tmp/aiti-ai-backup-pre-rewrite.bundle` (36M, all refs).
- **Upstream-inherited commits are untouched**: the agegr/pi-web fork history (including its 2000+ Chinese commits) belongs to the upstream community and is neither rewritten nor translated.
