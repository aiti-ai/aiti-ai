# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit` · Lint: `npm run lint`

**Never run `next build` during dev**: it pollutes `.next/` and breaks `npm run dev`. A build that fails mid-flight leaves `.next/` unusable (a leftover `dev/` tree and no `BUILD_ID`), after which every rebuild fails the same way and a running server starts answering 500 for `/_next/static/*`: `rm -rf .next` before rebuilding. To tell a product defect from a poisoned build directory, build a clean `git worktree` of the same commit — if that succeeds, the working directory is the problem, not the code.

### Dev server troubleshooting

- First run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse a healthy Pi Web process. A second `next dev` on another port is no workaround: both contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph, not a broken server or source. Use the browser's explicit reload, then compare the server log and a direct HTTP/API request.
- Restart only when the failure reproduces from a fresh page and the server-side checks fail too: stop that exact dev process gracefully, move `.next` into a `mktemp -d` backup, restart with `npm run dev`.
- Turbopack panic (`/tmp/next-panic-*.log`) leaves the incremental graph poisoned: pages reload-loop or render the top bar / composer half-dressed while `tsc --noEmit` passes. A plain restart does not clear it — stop the process, move `.next` away, restart, and judge only after the full rebuild.
- Do not trust `grep rescue` on served HTML: `rescue-hook.js` is injected into every page as a build-error probe; its mention appears on healthy pages too.
- Never fall back to `next dev --webpack`: the dev graph can fail on `undici` imports such as `node:console`. Development uses Turbopack.
- `next dev` may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md`. It is tooling output: check `git status` and keep it out of unrelated commits.

### Upgrading pi

The published pi-web ships no lockfile, so its dependencies resolve afresh on install, and pi up to 1.2.0 linked its own packages with `^` ranges. Install every `@earendil-works/*` package the tree holds, the SDK's own dependencies included (`pi-codemode`, `pi-mcp`, `pi-telemetry`, …), with `npm install --save-exact`, so npm reuses those exact versions for the SDK's ranges. `lib/pi-packages.test.mjs` fails on any pi package that is not pinned that way.

### Merging upstream (MUST READ before any origin/main merge)

This fork carries intentional divergences (custom-drawn top bar, WeChat-style mobile send, mobile composer v4, provider names …). Four regression classes have already shipped to users from past merges (duplicated buttons, a collapsed composer, a Send key that inserted newlines). Before merging origin/main, follow the merge SOP: whole-commit conflict resolution (never mix hunks of one upstream commit), the single-owner table (each guarded UI region has exactly one owner), then the post-merge checks — full test run plus `node scripts/check-upstream-merge.mjs --base <old-tip> --upstream origin/main`, triaging every reported line as fork-intentional or merge-loss. The full written SOP lives in the private source workspace, not in this repo. The guard pins (`AppShell.topbar-dedup`, `ChatInput.composer-shrink-chain`, `ChatInput.mobile-send`) go red on reintroduction — a red pin means the merge is wrong, not the test.

### Releases & version scheme (MUST READ before tagging/publishing)

Fork releases use the Debian/Ubuntu-style build suffix, never bare versions:

- Fork version = `X.Y.Z-aiti.N` where `X.Y.Z` is the **upstream core version** the build is based on; rebuilds increment `N`. Bare `X.Y.Z` is legacy and rejected by the release guard.
- Ordering is dpkg semantics, not semver: the upstream core dominates and the suffix only breaks ties (`0.16.0-aiti.2 > 0.16.0-aiti.1 > 0.16.0`; `0.16.1 > 0.16.0-aiti.3`). All consumers implement this ordering — do not "fix" it to strict semver.
- tag = `v<version>`; the npm package version and the `latest` dist-tag carry the same string.
- The **sole release entry point** is `node scripts/release-tag.mjs` (guard: version must be `X.Y.Z-aiti.N`, tag must not exist anywhere, working tree must be clean; `--dry-run` / `--suggest` / `--force` to exempt a dirty tree). Never `git tag` by hand.
- Full design and rationale: `docs/aiti-ai-fork-build-suffix-versioning-plan.md` lives in the private source workspace.
- npm publishing: the official registry (registry.npmjs.org) goes through GitHub Actions (`publish.yml` / `publish-npm.yml`, OIDC trusted publishing); the private registry is published locally — always with `--tag latest`.

---

## Architecture

- **Browsing** (read-only, no AgentSession): `GET /api/sessions` lists `~/.pi/agent/sessions/`; `GET /api/sessions/[id]` reads the `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts`, or an open wrapper's in-memory `SessionManager`. `GET /api/agent/running` snapshots the running ids.
- **Sending**: `POST /api/agent/[id]` → `startRpcSession()` (`lib/rpc-manager.ts`) creates the AgentSession in-process (`createAgentSessionFromServices()`); `session.send(cmd)` → `session.prompt()`.
- **Events**: `GET /api/agent/[id]/events` streams SSE `data: {...}` from `session.onEvent()`, fed by `session.subscribe()`.
- **Product scope**: a light web wrapper around pi, not an IDE or a platform of its own. Before adding a feature, check the out-of-scope list in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Extension compatibility (principle)**: extensions written for the pi CLI must behave the same here. Fix display problems in the web client; never add pi-web-only options or fields to the extension API (`ctx.ui.*` options, `extension_ui_request`). pi's TUI (`node_modules/@earendil-works/pi-tui`) is the reference for what an extension asking for something means.

## UI Copy

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## Bug Fixes

Fix a bug at its cause, reasoning from first principles and established best practice. Do not patch over the symptom.

---

## API Routes

Each route's methods and parameters; code elsewhere is found by name (`ls lib components hooks`) and through the topic notes' file lists.

```
app/api/
  sessions/route.ts                GET list all sessions
  sessions/[id]/route.ts           GET/PATCH/DELETE a session
  sessions/[id]/context/route.ts   GET ?leafId=&tail=&before= a page of a leaf's context (tail defaults to 50; before pages upward; leafId defaults to pi's leaf, named in the reply)
  sessions/[id]/export/route.ts    GET exported HTML
  sessions/[id]/fork/route.ts      POST copy the session's current branch into a new session, { side: true } a side chat, or { cwd } a session whose folder is gone into that folder (never starts an AgentSession)
  sessions/delete/route.ts         POST { ids } delete sessions and their subagents (a project's Delete all sessions); running ones kept
  sessions/stats/route.ts          POST { ids } each session's tokens, cost, tool calls, active time (the agent switcher's rows)
  sessions/[id]/state/route.ts     GET live wrapper state while running
  sessions/ui-state/route.ts       GET/POST sidebar pins, archive, project order and names, read times (set, restore, pin-project, add-projects, move-project, rename-project, read)
  sessions/[id]/auto-name/route.ts POST generate a session title
  sessions/search/route.ts         GET session search
  sessions/[id]/meta/route.ts      GET one SessionInfo without messages/context/tree (lightweight refresh)
  sessions/[id]/queue-recovery/route.ts GET a session's persisted queue awaiting recovery
  sessions/[id]/entries/[entryId]/thinking/route.ts       GET one thinking block's full text
  sessions/[id]/entries/[entryId]/tool-result-image/route.ts GET one tool-result image
  agent/new/route.ts               POST { cwd, type: prompt|ensure_session (start only), message?, toolNames?, provider?, modelId?, thinkingLevel? }
  agent/[id]/route.ts              GET state (?systemPrompt=0: without the prompt) | POST any command
  agent/[id]/events/route.ts       GET SSE stream
  agent/[id]/lease/route.ts        POST reset the selected session's idle timer (with or without its stream; never starts one); reply: running, awaitingInput, subagentsActive
  agent/[id]/bash-output/route.ts  GET/POST read a session's bash output temp file (?path= legacy; POST keeps paths out of URLs)
  agent/running/route.ts           GET running + awaiting-input session ids, sidebar pins/archive revision, the server's clock
  agent/running/events/route.ts    GET the page-wide single event SSE (running state + page events)
  agent/recovery/interrupted/route.ts GET interrupted runs awaiting a recovery decision
  agent/recovery/resolve/route.ts  POST resolve one interrupted run (keep / discard / continue)
  agent/debug/route.ts             GET ?session= the Debug panel's read-only snapshot: wrappers, streams, subagents, MCP, terminals, file watches
  emergency/route.ts               POST { message, cwd?, sessionId? } minimal rescue AI (streaming)
  auth/api-key/[provider]/route.ts POST/DELETE stored provider API key
  auth/all-providers/route.ts      GET API-key-capable providers incl. dual-auth ones
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
  worktrees/query/route.ts         POST { cwd } → { projectRoot, projectKey, isGit, isTopLevel, … }
  terminal/route.ts                POST create a terminal session
  terminal/[id]/route.ts           GET { id, cwd } (404 once closed; stream at [id]/events) | POST input/resize | DELETE kill
  terminal/[id]/events/route.ts    GET terminal output SSE
  terminal/[id]/buffered/route.ts  GET ?after=N terminal output snapshot (bus subscription)
  mcp/route.ts                     GET [?cwd=] Settings › MCP overview, files only | POST add/enable/disable/remove/undo/set-enabled/set-exposure/set-in-project/sign-out
  mcp/test/route.ts                POST { scope, name, cwd? } test one server once (entry read from its file)
  mcp/sign-in/route.ts             POST { scope, name, cwd? } start or join an OAuth sign-in
  mcp/sign-in/[flowId]/route.ts    GET flow state (polled) | POST { redirectUrl } | DELETE cancel
  project-trust/route.ts           GET trust status + project .pi/mcp.json servers (files only) | POST trust, rebuild the cwd's wrappers
  project-trust/status/route.ts    POST { cwd } → project trust status
  tools/settings/route.ts          GET/PUT defaultTools switches: PowerShell (Windows), Code mode automatic/always; codemode.mode, codemode.inlineBudget
  notices/route.ts                 GET/PUT { key, shown } pi's global notices.* (Settings › General)
  http-proxy/route.ts              GET global httpProxy state and sources | PUT { enabled, httpProxy? } save and apply
  queue-modes/route.ts             GET/PUT pi's global steeringMode and followUpMode (Settings › General), applied to open sessions
  models/route.ts                  GET ?cwd= { models, modelList, defaultModel, … }
  models/enabled/route.ts          GET/PUT enabledModels switches
  models/default/route.ts          PUT default model / reasoning level for new sessions
  models/refresh/route.ts          POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts           GET/PUT ~/.pi/agent/models.json
  models-config/catalog/route.ts   GET models.dev pricing presets
  models-config/discover/route.ts  POST fetch a configured provider's upstream model list
  models-config/test/route.ts      POST test a configured model/provider
  models-config/probe-cap/route.ts POST probe a model's max output token cap
  plugins/route.ts                 GET/POST package plugin management
  plugins/check/route.ts           POST check plugin package updates
  skills/route.ts                  GET/PATCH loaded skills, disable-model-invocation
  skills/content/route.ts          GET one loaded skill's bounded Markdown source, or ?document= a Markdown file in its folder
  skills/install/route.ts          POST install skills via npx skills add
  skills/search/route.ts           POST skills.sh search
  skills/check/route.ts            POST check skill updates
  skills/update/route.ts           POST update a skill
  subagents/settings/route.ts      GET/PUT built-in subagent switch and maxConcurrent
  subagents/profiles/route.ts      GET agent profiles for a cwd
  subagents/[id]/route.ts          GET one subagent run | POST steer/abort
  session-backends/route.ts        GET external agent session backends | POST manage
  session-backends/[id]/route.ts   one backend's sessions
  session-backends/rescan/route.ts POST re-run backend registration scans
  relay/route.ts                   POST { to, message, timeoutMs? } agent-to-agent message relay
  chat/ai-usage/route.ts           GET AI usage accounted by the core (?session=<id> to scope)
  provider-usage/overview/route.ts POST provider usage overview
  fx/route.ts                      GET USD→CNY exchange rate (24h lazy cache)
  web-auth/route.ts                GET status | POST login | DELETE logout (browser password)
  provider-usage/query/route.ts    POST provider usage quotas
  push/config/route.ts             GET VAPID public key
  push/subscribe/route.ts          POST register a push subscription
  app-update/route.ts              GET current vs latest published pi-web version
  extensions/[...path]/route.ts    GET/POST/PUT/DELETE/PATCH extension api dispatch + assets (behind the security gates)
  extensions/manifest/route.ts     GET client manifest (UI metadata + clientUrl + i18n)
  extensions/client-bundle/route.ts GET ?rev= eager extension client bundle (one request, many extensions)
  extensions/status/route.ts       GET full status (disabled/failed entries, insertion points, hooks, deps)
  extensions/reload/route.ts       POST hot reload (shutdown → loadAll → startAll)
```

---

## Topic Notes

Design decisions and traps live in `docs/agents/`, one note per area. Read every note whose files a change touches before making it. Add new notes to the area's file, not here.

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle, session file reads and rewrites, SSE and running state, the chat transcript's rendering (messages, tool cards, Markdown, code, notices), the session sidebar and new-session bar, the Debug panel, queue persistence and recovery. Files: `lib/rpc-manager.ts`, `lib/queue-store.ts`, `lib/startup-issues.ts`, `lib/session-reader.ts`, `lib/session-fork*.ts`, `lib/session-delete.ts`, `lib/normalize.ts`, `lib/message-keys.ts`, `lib/idle-message-read.ts`, `lib/draft-store.ts`, `lib/session-tree.ts`, `lib/session-ui-state*.ts`, `lib/unread-markers.ts`, `lib/user-attention.ts`, `lib/sidebar-prefs.ts`, `lib/sidebar-actions.ts`, `lib/session-links.ts`, `lib/session-search*.ts`, `lib/session-reference*.ts`, `lib/session-markdown.ts`, `lib/session-fuzzy.ts`, `lib/session-drag.ts`, `components/SessionReferenceBlock.tsx`, `components/ExpandableBlock.tsx`, `components/open-session-context.ts`, `lib/favicon-badge.ts`, `lib/new-session-context.ts`, `hooks/useAgentSession.ts`, `hooks/useSessionUiState.ts`, `hooks/useSidebarMotion.ts`, `hooks/useGroupDrag.ts`, `hooks/useFilesPlacement.ts`, `hooks/useResizablePanel.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/SessionSidebar.tsx`, `components/PiWebTitle.tsx`, `components/SessionTree.tsx`, `components/SidebarMenu.tsx`, `components/SidebarToast.tsx`, `components/SidebarIcons.tsx`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/WorktreeCreateForm.tsx`, `handleNewSession`, `handleSelectSession` and the bar's handlers in `components/AppShell.tsx`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `lib/message-display.ts`, `lib/patch.ts`, `components/FileViewer.tsx`, `components/MarkdownBody.tsx`, `lib/markdown.ts`, `lib/markdown-blocks.ts`, `lib/streaming-message.ts`, `hooks/useStreamingSelector.ts`, `hooks/useSkipOffscreenRows.ts`, `lib/turn-duration.ts`, `lib/tool-clock.ts`, `components/MermaidBlock.tsx`, `components/SvgBlock.tsx`, `lib/highlight-queue.ts`, `lib/prism-languages.ts`, `hooks/usePrismLanguages.ts`, `lib/session-view-cache.ts`, `components/CodemodeToolView.tsx`, `components/ExtensionStatusBar.tsx`, `components/ExtensionWidgets.tsx`, `lib/extension-ui-theme.ts`, `components/AnsiText.tsx`, `lib/transcript-notices*.ts`, `components/TranscriptNotices.tsx`, `app/api/notices/**`, `lib/tool-fields.ts`, `lib/debug-*.ts`, `lib/stream-client.ts`, `lib/page-stream-registry.ts`, `lib/page-debug.ts`, `lib/file-watch-registry.ts`, `components/DebugPanel.tsx`, `components/debug-panel-state.ts`.
- [tools.md](docs/agents/tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host and `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP: reads that run nothing, masking, row states and notices, the Code mode choice, trust, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-override.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add pane and the paste importer. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, provider catalogs and credentials, `enabledModels`, the models.json editor. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/model-runtime.ts`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-context.ts`, `lib/model-image-limits.ts`, `lib/model-provider-check.ts`, `lib/model-catalog-refresh.ts`, `lib/deferred-provider-models.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelContextWindow.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): the `/api/files` allow-list (the security boundary), worktrees and project grouping, the file tree, uploads and chat drops, file previews, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/file-tree-expansion.ts`, `lib/file-upload-client.ts`, `lib/file-version.ts`, `lib/html-sandbox-polyfill.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/FileExplorer.tsx`, `lib/delimited-table.ts`, `components/DelimitedTable.tsx`, the table branch of `components/FileViewer.tsx`, `hooks/useDragDrop.ts`, `components/DirectoryPicker.tsx`.
- [settings-ui.md](docs/agents/settings-ui.md): General settings, the Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks. Files: `app/api/plugins/**`, `app/api/skills/**`, `app/api/queue-modes/**`, `lib/skills-service.ts`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`, `hooks/useFilesPlacement.ts`; also before adding a settings section or add pane.
- [side-sessions.md](docs/agents/side-sessions.md): side chats (ADR 0007): the fork copy, the tool allow-list, the hidden boundary message, the shared tab, usage. Files: `lib/side-session.ts`, `lib/session-fork.ts`, `lib/session-family.ts`, `lib/session-delete.ts`, `lib/session-reader.ts`, side handling in `lib/rpc-manager.ts`, `app/api/sessions/[id]/fork/route.ts`, `app/api/sessions/stats/route.ts`, `components/SessionChatPanel.tsx`, `components/TabBar.tsx`, `components/AgentSessionPanel.tsx`, `components/ChatInput.tsx`, `components/QuoteSelectionPopover.tsx`, `hooks/useAgentSession.ts`, `lib/side-chat-client.ts`, side handling in `components/AppShell.tsx`.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles, run status, completion notifications, the subagent tab, the Agents strip. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`, `components/SessionChatPanel.tsx`, `components/AgentMiniStrip.tsx`, `lib/agent-strip-lock.ts`, `components/LockToggle.tsx`.
- [client-platform.md](docs/agents/client-platform.md): global shortcuts, the mobile keyboard and viewport, the terminal (shell, keys, theme, font size), the completion sound, the launcher. Files: `hooks/useKeyboardShortcuts.ts`, `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, `lib/done-chime.ts`, `terminalShell()` in `lib/terminal-manager.ts`, `components/TerminalExtraKeys.tsx`, `lib/terminal-extra-keys.ts`, `lib/terminal-theme.ts`, `hooks/useTerminalTheme.ts`, `terminalFontSize()` in `hooks/useChatAppearance.ts`, the keyboard-open CSS, `bin/browser-opener.js`, the browser opening in `bin/pi-web.js`.
- [extensions.md](docs/agents/extensions.md): the fork's extension host (`lib/ext/`), client slots and bundles, `ui.provides` capability takeover, the extension routes, service-tunnels. Files: `lib/ext/**`, `lib/ext-ui-store.ts`, `components/ExtSlots.tsx`, `app/api/extensions/**`.

---

## Package trees (aiti ecosystem)

This repo is the single source for the whole ecosystem: the Next app above, plus four independently published package trees. All four are **excluded from tsc/eslint and never bundled by `next build`** (see `tsconfig.json` / `eslint.config.mjs`), and each package has its own build and release lifecycle.

| Tree | What it is | Notes |
|---|---|---|
| `extensions/` | 66 pi-web extensions (`@aiti-ai/aiti-*`), full sources | edit here; `_shared/` is `@aiti-ai/ext-shared`, `sm-demo-source/` the session-manager agent template |
| `pi-plugins/` | pi CLI plugins (`@aiti-ai/pi-*`) | published from here; `pi-plugins.manifest.json` pins what the runtime auto-provisions |
| `packages/` | shared libraries (`@aiti-ai/aiti-bridge`, `aiti-devtools-*`, `secret-*`) | consumed by extensions and by the app at runtime |
| `integrations/` | carriers for other agents/hosts (`vscode-ext`, `browser-ext`, `dsh-*`, `opencode-ext`, `openclaw-web-ext`) | one level deeper than the others: `integrations/<carrier>/<pkg>` |

- **These are the sources**: edit them here. There is no upstream mirror to sync back to and no redaction step.
- Runtime dependency note: extensions declare repo dependencies in their own `package.json`; the installed `<webRoot>/node_modules` tree is reconciled by the extman extension — never hand-edit it.
- `tools/` holds publish/release tooling (`publish-all.mjs`, `release-audit.mjs`, asset materializers); `scripts/` holds build/release automation (`deploy-all.mjs` and the release chain).
- Code gates (protocol declarations, hand-written version lines, unregistered globals, comment language, release redaction) live in a separate policy workspace and run against this checkout: `node gates/gate-all.mjs --root <this repo>`.

---

## Old Safari (iOS 16.2)

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

---

## No internal addresses in code

- **Real deployment addresses must never appear in code/tests/comments** (internal IPs, internal domains, production ports, …) — the repo is publicly visible and would leak the internal topology. Example hostnames use RFC 2606 reserved domains (`example.com`, `attacker.example`, …) and generic ports; loopback and RFC 1918 ranges are acceptable only as generic examples.
- Deployment-specific configuration lives only in the runtime environment (systemd `Environment=`, nginx configs, …), never in the repo. This applies to AGENTS.md itself.
- Sensitive patterns and private-registry URLs live in the machine-local `~/.aiti/release-redact.json` (CI injects the same JSON via `AITI_RELEASE_REDACT`) loaded at runtime by release-audit, publish-all, the prepack scrubber and the pack self-check. Never commit them as source literals — obfuscation is not redaction.
- Published npm tarballs must not carry build-machine absolute paths: the prepack scrubber (`scripts/sanitize-npm-package.mjs`) + `files` excluding `.next/trace|trace-build|diagnostics` + the pack self-check are the backstop — do not bypass them when changing the release flow.
- Official npmjs publishes go only through the GitHub Actions workflows (`publish.yml` / `publish-npm.yml`); local machines publish to the private registry for verification only.

## Language discipline (commits & comments)

- **Commit messages are English-only** across all repos. Technical terms, commit hashes, version numbers and file paths stay verbatim.
- **Code comments default to English** for new code and rewritten sections. Formal localized content documents (README.zh-CN.md, Chinese pages under aiti-docs, Chinese SKILL.md bodies) are exempt — content language follows the document's purpose.
- The public surface (github.com/aiti-ai/aiti-ai, Docker Hub) is English-only. Legacy Chinese comments in `extensions/` are anglicized opportunistically as files are touched — no bulk translation planned.
- **Upstream-inherited commits are untouched**: the agegr/pi-web fork history (including its Chinese commits) belongs to the upstream community and is neither rewritten nor translated.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
