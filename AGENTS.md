# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

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
  services/route.ts                  GET discovered service ports + tunnels (+?refresh=1)
  service-tunnels/route.ts           GET status/detect/logs | POST expose/tunnel/user/TOTP/allow-download
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  extensions/[...path]/route.ts   GET/POST/PUT/DELETE/PATCH extension api dispatch + assets（门禁后分发，asset 防穿越）
  extensions/manifest/route.ts    GET client manifest（ui 元数据 + clientUrl + i18n）
  extensions/status/route.ts      GET 全量状态（含禁用/失败条目 + 插入点/钩子/依赖）；管理操作在 aiti-extman 扩展
  extensions/reload/route.ts      POST hot reload（shutdown→loadAll→startAll）
  （扩展管理 UI/安装/在线注册表已迁出 core → aiti-ai pi-web-ext/aiti-extman 扩展：
    /api/extensions/aiti-extman/{status,registry,ops}）
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  ext/types.ts         PiWebExtension contract（server hooks + ui 元数据 + ExtCoreApi 数据契约）
  ext/loader.ts        jiti 加载 ~/.pi/web/extensions/<id>/（moduleCache:false 支持 reload）
  ext/registry.ts      globalThis.__piWebExt 单例：loadAll/startAll/shutdown/reload/api 分发/middleware 链/manifest/assetPath 防穿越
  ext/core.ts          makeExtCore()：listSessions/getRunningSessionIds/getHomeDir
  ext/data-dir.ts      代码 ~/.pi/web/extensions、数据 ~/.pi/web/data/<extId>/（PI_WEB_EXTENSIONS_DIR/PI_WEB_DATA_DIR 覆盖）
  ext-ui-store.ts      client 插槽注册表（window.__piWebExtUI + subscribe 版本号）
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations
  service-tunnels-integration.ts  singleton ServiceTunnels (globalThis) + listPiServices/exposeService
  service-ports.ts    server-side discovery adapter (lib-owned)
  service-proxy-shared.ts  middleware-safe helpers (suffixes, basePath strip, self-access gate)
  tunnels.ts          thin adapter: tunnel info shape for the Services dialog
  request-security.ts DNS-rebinding gate: isApiRequestAllowed / host+origin checks
  web-auth.ts         optional Basic password gate (PI_WEB_PASSWORD)
  base-path.ts        client-side basePath helpers (NEXT_PUBLIC_BASE_PATH)
  startup-preferences.ts  persists explicit model/thinking selections (no replay)

components/
  AppShell.tsx        layout + URL state + tab management + ExtSlot 挂载点（toolbar/sessionTopbar/banners/dialogs/pages）
  ExtSlots.tsx        ExtSlotsProvider（拉 manifest + 动态 import client bundle + register(ctx)）+ <ExtSlot name=.../>（sidebar/sessionRowActions 在 SessionSidebar 内）
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  ServicesDialog.tsx  service ports + exposes + tunnel/auth forms + user/TOTP management
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  ScrollToolbar.tsx   draggable follow/jump toolbar (prev/next user message, latest)
  QueueRecoveryDialog.tsx  queue crash-recovery checklist (re-queue/discard/export/import)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useI18n.tsx         i18n context (en/zh-CN message maps)
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

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

### Plugins and skills
- **扩展能力接管（ui.provides）**：扩展在 `ui.provides: string[]` 声明接管内置能力（能力名见 `lib/ext/types.ts` 的 `EXT_PROVIDES`，如 `"session-delete"`）。manifest 原样下发，客户端用 `useExtProvides()` 查询——有人声明时侧栏隐藏内置删除按钮（删除流由扩展接管，如 session-manager 的先归档再删），没人声明则内置按钮照常显示。新增能力：登记进 `EXT_PROVIDES` + 对应内置 UI 加门控。
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

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

## Service port proxy & expose (`proxy.ts` + `lib/service-*` + service-tunnels lib)

- Test servers started by pi sessions are reachable at `http://<port><suffix>/` (default `.pi.localhost`). `proxy.ts` (Next middleware) runs the library's IN-PROCESS decision API (`st.proxy.resolve()`, shared `globalThis` instance) — the library owns vhost parsing, enrollment and per-site auth; Next forwards the rewritten target (HTTP + WebSocket). Only `127.0.0.1` targets are ever proxied. Accepted suffixes: `.pi.localhost` + `PI_WEB_SVC_HOST_SUFFIX` + every configured deployment domain (`PI_WEB_BASE_DOMAIN` primary — comma-separated, `host:port` allowed; legacy fallbacks `PI_WEB_ALLOWED_HOSTS`/`PI_WEB_HOSTNAME`). `PI_WEB_HOSTNAME` is the LISTEN address only (`next start -H`); deployment domains live in `PI_WEB_BASE_DOMAIN`.
- **No manual port allow-list** — enrollment (expose) is the gate; un-enrolled vhosts get 403 from the library. Only `127.0.0.1` targets are ever proxied.
- `lib/service-ports.ts` = server-side discovery adapter (library-owned); `lib/service-proxy-shared.ts` = middleware-safe helpers (suffixes, basePath strip, self-access gate) with NO library dependency; `lib/service-tunnels-integration.ts` = the `globalThis.__piServiceTunnels` singleton + `exposeService()`/self-expose. Middleware reads the singleton directly — no file/IPC channel.
- **Security gates**: service hosts pass the same host allow-list (suffix regex) + optional `PI_WEB_PASSWORD` Basic gate; ports must be in the discovery cache. The standalone library `createProxyServer()` additionally supports forward-auth (portal/authelia/oauth2-proxy) and its own allow-list.
- WebSocket upgrades are NOT proxied by the middleware (Next no-ops non-HMR upgrades) — Vite HMR etc. need direct localhost or a tunnel.
- `GET /api/services?refresh=1` lists discovered ports + `serviceHostSuffixes`; `GET /api/service-tunnels` returns exposes/status/provider order/default provider/user managers/tool status/allow-download. The top-toolbar globe opens `ServicesDialog` (10s auto-refresh): **Ports** tab = per-port access methods (direct + virtual-host URLs, `window.open` with `noopener,noreferrer`), protocol auto-detect (http/https/tcp), expose form (tunnel type + auth provider, schema-driven), active exposes (stop, nginx logs), allow-tool-download toggle; **Users** tab = provider user management + TOTP 2FA enroll/activate.
- **Provider knowledge lives in the library**: pi-web consumes `providerOrder`/`defaultProvider`/`userManagers`/`tunnelSchemas`/`tunnelTcpSupport` — no provider names hardcoded in pi-web (tcp exposes carry no auth: the library's tcp path ignores the provider).
- Tests: `node --test lib/service-ports.test.mjs lib/request-security.test.mjs lib/web-auth.test.mjs` (middleware-safe helpers, discovery cache, gates).

## pi-web-dev service 运维（重要：避免重复踩坑）

- **重启 pi-web-dev 用 `sudo systemctl restart pi-web-dev`**——不要手动
  `kill` + `nohup next dev`：手动进程会占住 30142，systemd 的
  auto-restart 一直起不来（`activating auto-restart`），且手动带的 env
  与 service 配置不一致（行为漂移）。
- **编译目录**：service 用 `PI_WEB_DEV_DIST=1` → distDir = **`.next-dev`**
  （next.config 的 `distDir: PI_WEB_DEV_DIST ? ".next-dev" : ".next"`）。
  **不要乱清/乱动 `.next-dev`**（service 正在用；清了会导致编译异常/404）。
  `.next` 与 `.next-aiti` 是其他用途（生产构建 / 隔离测试），清前先确认归属。
- **隔离测试实例**：另起 dev 时用 **`PI_WEB_DIST_DIR=<自定义目录>`**（如
  `.next-aiti`）——多个实例共享同一编译目录会互相覆盖（曾导致 middleware
  运行旧编译）。**端口**也要避开 30142（service）与生产端口。
- **service 的部署 env 在 drop-in**（`/etc/systemd/system/pi-web-dev.service.d/*.conf`：
  aiti/basepath/base-domain 等）——`systemctl restart` 自动加载，无需手动传。
- 改动 pi-web 代码（proxy.ts / components / lib）后 **`systemctl restart pi-web-dev`**
  生效；浏览器验证注意 **强制刷新**（`ignoreCache`）绕过 client bundle 缓存。

## service-tunnels 依赖

- pi-web 依赖**本地镜像**（registry.npmjs.org / 127.0.0.1:4873）的 service-tunnels
  内部构建；升级用 **`bun install`**（勿用 `npm i` —— 会破坏 node_modules，
  曾导致 enhanced-resolve / jiti 缺失）。
- **service-tunnels 是自维护仓库**（本地工作区 `~/workspace/service-tunnels`）：
  - 需要库能力时**直接改它的源码**（`src/` → `npm run build` → commit →
    `npm publish --registry=https://registry.npmjs.org` 升版本）→ pi-web 再
    `bun add service-tunnels@<新版本>` 升级；**不要 patch node_modules**。
  - 已内置 **`transformResponse`**（0.3.34+）通用响应注入：text/html 响应
    `</head>` 前（head）或响应开头（`{ position: "prepend" }`，不缓冲流式、
    最早执行）。aiti-devtools 的 launcher 注入用它（prepend）。
  - library mode：pi-web 转发在 `proxy.ts`（Next rewrite）——注入执行用
    **同一回调**（`__aitiInject.scriptFor`），与库内自托管 proxy 语义一致。
  - **注入开关 UI**（服务端口界面）：Ports 页每个端口卡的展开区 + Pi-web 页
    各有「注入 JS（AITI 调试器）」开关（`ServicesDialog.tsx` 的 `InjectJsSection`），
    读写 aiti-devtools 扩展的 `inject-ports` API（GET/PUT
    `/api/extensions/aiti-devtools/inject-ports`，按端口开关）。执行侧：
    **proxy 模式已生效**（service vhost）；**tunnel 模式**（nginx 网关响应）
    由 service-tunnels 开发中，UI 先就绪。
  - 注入配置（`inject-ports.json`）在 aiti-devtools 扩展 dataDir（不在本仓库）；
    PUT 不带 `baseUrl` 时扩展保留已存值（服务端口界面只改 ports）。
  - **aiti-devtools 扩展的 open enroll 跳过 pi-web 自身端口**：`enrollPort` 对
     `port === (globalThis.__piWebPort ?? PORT ?? 30141)` 只跳过 open binding——
     否则给 pi-web 端口注册 `{label:"",provider:""}` 等于无认证 vhost 直达
     管理界面。注入仍生效（自暴露的 labeled binding / 隧道通道）。
  - **exposeSelf 幂等短路按“同模式通道”判断**：tunnel/both 请求撞上运行中的
    自暴露隧道（记录带 url）才短路；proxy 请求重入 `st.auth.expose(mode=proxy)`
    （binding/记录覆盖写，天然幂等）→ 已有 tunnel 再点 proxy 会真正建出
    vhost 通道，不再静默吞掉（否则 UI“点了没反应、无错误”）。
  - **登录跳转 scheme 跟随公网协议（0.3.36+）**：https 隧道
    （localtunnel/ngrok/cloudflared 等）边缘 TLS 终结、公网 URL 是 https——
    loginRedirect 不能按本地端口协议判断（pi-web 本地 http + localtunnel 公网
    https → 登录页跳成 http → 浏览器混合内容拦截）。tunnel/网关路径在
    `expose.ts` 从公网 URL 推导 publicScheme（本地后端 scheme 仍按端口探测）；
    middleware 路径（`proxy.ts` renderLoginRedirectReq）按请求实际协议
    （forwardedProto）把 http 跳转模板升级为 https。

## 代码中禁止出现内部地址

- **代码/测试/注释里一律不得出现真实部署地址**（内网 IP、内部部署域名、
  生产端口号等）——仓库对外可见（含推送到外部镜像），泄露内部拓扑。
- 需要示例主机名时用 RFC 2606 保留域名（`example.com`、`web.example.com`、
  `attacker.example` 等）；端口用通用值（3000/8443/443）；回环 `127.0.0.1`
  与 RFC 1918 私有网段（`192.168.x.x`）仅作通用示例可用。
- 部署相关配置只存在于运行时环境（systemd unit 的 `Environment=`、nginx
  配置、`~/.pi/service-tunnels` 等），不进仓库。
- 本条同样适用于 AGENTS.md 自身——记录规则时不得点名内部域名。
