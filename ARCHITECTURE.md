# AITI Web — Architecture & Repository Map

AITI Web (`@aiti-ai/pi-web`) is a self-hosted browser workbench for the
[pi coding agent](https://github.com/earendil-works/pi), shipped as an npm package with
**63+ bundled extensions**. This document maps the repository, explains how the pieces fit
together, and details the extension structure that makes the bundled tier work.

Upstream lineage: this is a fork of [agegr/pi-web](https://github.com/agegr/pi-web)
(browser UI for pi), extended by the [aiti](https://aiti.pw/) ecosystem — see
[Why this fork](./README.md#why-this-fork).

---

## 1. Big picture

```
Browser (React UI in app/ + components/)
  │  fetch/SSE  (base-path aware: /<basePath>/api/…)
  ▼
Next.js server (app/api routes, instrumentation → extension runtime)
  │  jiti loads extension server entries (TS at runtime, fsCache)
  │  RPC to the pi engine process (JSONL sessions on disk)
  ▼
pi coding agent (separate CLI process, shared ~/.pi/agent config)

extensions/<id>/  ── server entry (index.ts) loaded by lib/ext/registry.ts
                  └─ client bundle (dist/*.mjs) loaded via the extension manifest
extensions/_shared/ → published as @aiti-ai/ext-shared; runtime copy installed by
                      the first-boot reconcile into <webRoot>/node_modules
```

- **Host runtime**: the Next.js server process. Owns the extension runtime (jiti),
  API routes, and the web push / session-liveness machinery.
- **Project command environment**: sandboxes for commands run on behalf of a selected
  project (terminal, shells, agent subprocesses).
- **Sessions** are pi's JSONL files on disk — the UI browses and resumes them; multiple
  front ends (pi CLI, IDE extensions, AITI Web) share the same files.

---

## 2. Top-level map

| Path | What it is |
|---|---|
| `app/` | Next.js App Router: page shell + all API routes (`app/api/**/route.ts`). Server-only. |
| `components/` | React UI: `AppShell` (top bar, sidebar, dock, tabs), `ChatWindow`/`ChatInput` (composer, queue, steer), session sidebar/kanban, settings panels, file viewers (text/MD/image/audio/video/pdf/docx/xlsx). |
| `hooks/` | `useAgentSession` (session lifecycle, event streams, steering/followUp), drag/resize/i18n/update hooks. |
| `lib/` | Server+client core: agent client/event wire, session reader & family (JSONL), extension loader/registry/store (`lib/ext/`), MCP host, model cache, i18n (en/zh-CN/zh-TW), base-path, security/allowed-roots. |
| `bin/` | `pi-web` CLI: start/stop/status/update/open; `bundled-extensions-reconcile.js` (first-boot dependency reconcile, see §4). |
| `extensions/` | **Bundled extensions tier** — 63 extension packages shipped inside the npm package (see §3). |
| `patches/` | `patch-package` patches (next + pi-agent race fix), applied on install. |
| `pi-plugins/` | pi engine plugins wired through the agent `settings.json` `packages` list (git-trace, models-combo, plan-sandbox). |
| `integrations/` | Out-of-tree web front ends: OpenClaw, OpenCode, DSH, browser extension, relay worker. |
| `packages/` | aiti-devtools injection packages (bridge, core, inject, vite/nuxt/pi/webpack adapters, agent connector). |
| `docker/` | Production images (`core`/`full`), entrypoint (phases: piweb/bridge/gui/asr/term), extension deploy & reconcile scripts, smoke/E2E helpers. |
| `scripts/` | Repo tooling: build helpers, upstream-merge guard (`check-upstream-merge.mjs`). |
| `e2e/` | Browser E2E scenarios (Playwright-style, `run.mjs` harness). |
| `demo/` | Interactive demo build (static, no model calls). |
| `docs/` | Upstream dev notes, zh-CN README, release & docker docs, upstream-merge guardrails. |
| `public/` | Static assets + `extensions.json` (online registry manifest consumed by the extension manager). |

Key single files:

- `lib/ext/registry.ts` — extension runtime: scan roots (user > extra > dev > **bundled**),
  load server entries via jiti, enable/disable, feature gates, error reporting.
- `lib/ext/data-dir.ts` — extension roots & priority (`bundledExtensionsRoot()` =
  `<pkgDir>/extensions`, overridable by `PI_WEB_BUNDLED_EXTENSIONS_DIR`).
- `lib/ext/loader.ts` — client bundle loader + jiti instance (fsCache pinned to
  `~/.pi/web/.cache/jiti`, virtual host-SDK module).
- `lib/base-path.ts` — sub-path deployment helper (`apiUrl()`); every client fetch goes
  through it (guarded by `lib/base-path-sweep.test.mjs`).
- `app/api/extensions/manifest` — the extension manifest (id, client bundle URL, slots,
  features) that drives the whole client-side extension system.
- `bin/pi-web.js` — CLI entry: parses options, runs the bundled-extensions reconcile
  (§4), spawns `next start`.

---

## 3. Extension structure

Every bundled extension lives at `extensions/<id>/` and is a self-contained package.

### 3.1 Anatomy

```
extensions/aiti-example/
├── package.json        # @aiti-ai/aiti-example; aitiExtProtocol: "1.0"; scripts.build:client
├── index.ts            # server entry (TypeScript, loaded at runtime by jiti — no build step)
├── server/             # optional: server-side modules (routes, workers) imported by index.ts
├── client/src/         # client source (TSX) — registered via ctx.registerItems(...)
├── dist/               # built client bundle (vite, output of build:client; gitignored,
│                       #   included in the npm package / bundled tier)
├── tools/
│   ├── build-client.mjs# build:client implementation (vite via esbuild helpers)
│   └── deploy.mjs      # deploy to ~/.pi/web{,-dev}/extensions (dev loop; unused in npm installs)
├── icon.svg  or icons/ # manifest icon (inline {svg} or files)
├── skills/             # AI skill markdown for the extension's ai.helpers entry points
├── AGENTS.md           # dev notes for AI assistants working on this extension
├── LICENSE             # MIT (injected by the release pipeline)
└── package-lock.json   # optional, for deterministic in-container dep install
```

### 3.2 Server/client split

- **Server side**: `index.ts` runs under jiti inside the Next.js server process. It can
  register API handlers, use Node APIs, and holds per-extension state. Loaded eagerly at
  boot (immediate extensions) or on demand (lazy ones, `clientImmediately: false`).
- **Client side**: `client/src/*.tsx` is built to `dist/*.mjs` by `build:client`. The
  manifest exposes `client: dist/<bundle>`; the host loads it lazily when a slot that
  references it renders. **Never import server code from client code** — the two run in
  different processes.

### 3.3 Extension kinds

| Kind | Example | Build | Notes |
|---|---|---|---|
| Agent backend | `aiti-zcode-agent`, `aiti-codex-agent`, `aiti-claude-code-agent` | `build:client: "true"` (no-op placeholder) | Spawns/wraps an external CLI or ACP process; registers a session backend + session-request cards |
| UI panel/dock extension | `session-manager`, `aiti-git-review`, `aiti-ai-schedule` | vite → `dist/` | Registers toolbar entries, dock faces, dialogs; server side provides `/api/extensions/<id>/...` routes |
| Pure client | `aiti-ctx-meter`, `aiti-float`, `aiti-msg-*` | vite → `dist/` | No API routes; pure UI enhancement |
| Takeover extension | `aiti-editor` (fileViewer), `aiti-model-wizard` (modelSelector/settingsModels), `aiti-subagents` (settingsAgents) | vite → `dist/` | Replaces a native UI surface entirely; unregistered → native fallback |

### 3.4 Registration surfaces (slots)

An extension declares integration points via `ctx.registerItems(slot, items)` in its
client entry. The host type union (`lib/ext/types.ts` `ExtSlotName`) lists all slots —
the contract test `extensions/_shared/ext-entry-contracts.test.mjs` pins the mirror and
fails on typos (a typo = a dead entry point). Major slots:

- **Toolbar / top bar**: `toolbar`, `sessionTopbar`, `sidebarFooter`
- **Sessions**: `sidebarProjects`, `sessionRowActions`, `sessionRowLeading`, `sessionRowMeta`, `workspacePickerActions`
- **Composer area**: `chatInputTop`, `chatOverlay`, `composerTools`, `composerAffix`, `userMessageActions`, `assistantMessageActions`, `assistantMessageFooter`, `compactLead`, `modelInfoLead`, `queuePanel`
- **Docks & dialogs**: `dialogs`, `pages`, `rightFileDock`, `sidebarExplorerDock`, `sidebarTasks`, `terminalDock`
- **Takeovers**: `fileViewer`, `pathPicker`, `modelSelector`, `modelSelectorFooter`, `settingsModels`, `settingsAgents`, `settingsAgentsFeature`, `noWorkspaceGuide`, `newSessionWidgets`, `newSessionSelectors`, `newSessionPreparers`, `newSessionBackendOptions`, `newSessionContextTrailing`, `sessionRequestCard`, `sessionStats`, `recoveryDialog`, `sidebarContent`
- **Extensions' own slots** (consumed cross-bundle): `sessionInfoPanel`, …

Items carry `meta: { label, icon, onClick }` (declarative — the host renders the button)
or `render` (self-drawn), optional `feature: "<featureId>"` gating, and `static: true`
markers for the lazy two-phase loading protocol.

### 3.5 Loading & priority

Load priority when an id exists in several roots: **user > extra > dev > bundled**.
Bundled is the baseline shipped with the package; users install/override via the
extension manager (extman) into `~/.pi/web/extensions`. `PI_WEB_BUNDLED_EXTENSIONS_DIR`
overrides the bundled root (used by E2E fixtures for isolation).

- **Server entries**: loaded through jiti (TypeScript at runtime, transpile cache in
  `~/.pi/web/.cache/jiti`). Lazy extensions materialize on first slot render.
- **Client bundles**: fetched via the manifest (`client: dist/<bundle>`), loaded lazily
  per slot.
- **Runtime dependencies**: an extension's `dependencies` are NOT installed by npm with
  the main package. On first boot `bin/bundled-extensions-reconcile.js` computes the
  union of all bundled extensions' dependencies and installs them into the shared root
  `<webRoot>/node_modules` (fingerprint-idempotent), then links
  `extensions/node_modules → <webRoot>/node_modules` so module resolution walks into it.
  `@aiti-ai/ext-shared` (the shared library: spawn-env, exec helpers, dock core, …) is
  one of those dependencies.
- **Shared library**: `extensions/_shared/` is the SOURCE of `@aiti-ai/ext-shared` —
  it is excluded from the bundled tier (not an extension) and ships as its own npm
  package, installed by the reconcile above.

### 3.6 Conventions & red lines

- `aitiExtProtocol: "1.0"` in every `package.json` (protocol contract; pinned by the
  entry-contracts test).
- `AITI_DEV` / hot-reload dev loop: deploy to `~/.pi/web-dev/extensions` + reload API;
  never `next build` during dev.
- Slot `extra` props carry **data only**; actions go through registered services
  (`ctx.registerExtService` / cross-bundle `getExtService`).
- Extensions must not execute code at install time (npm packages are installed
  file-level by the extension manager; server deps reconcile is the only code-bearing
  step).
- Client bundle URL and `client:` field must match the actual `dist/` output
  (contract-tested).

---

## 4. Build & release

```
extensions/<id>:  npm run build:client   →  dist/  (63 builds; no-op for server-only)
repo:             npm run build          →  .next  (Next.js production build)
npm pack          →  @aiti-ai/pi-web-<ver>.tgz (~16 MB)
                  files whitelist: bin, extensions (+dist, −node_modules), .next,
                  public, patches, next.config.ts
npm publish       →  registry.npmjs.org (official) or npm.alot.pw (staging)
docker/           →  core/full images; install the main package + pi plugins
```

Extension dependency publishing is governed by
`extensions/_shared/sync-gate.test.mjs` + `tools/release-audit.mjs` (15-item audit:
redaction, lock rewrite, LICENSE, dist presence, dependency resolution, install smoke).
The decision matrix in `tools/publish-all.mjs` compares a **content hash** (written into
each published `package.json` as `contentHash`) against the registry — the registry is
the single source of truth for "did this package change", so CI and local behave
identically: unchanged → skip; changed → auto-bump patch → publish; local version below
registry latest → skip (stale WIP); local above → publish as-is.

---

## 5. Testing

| Suite | Scope | Run |
|---|---|---|
| `lib/*.test.mjs`, `components/*.test.mjs`, `hooks/*.test.mjs` (node:test, jiti) | core units + source-pattern contracts (base-path sweep, upstream-merge guard pins) | `npm test` |
| `extensions/_shared/*.test.mjs` (+ per-extension tests, collected by `test-web-ext` runner) | extension units, entry contracts, mirror/gate behavior | `node scripts/test-web-ext.mjs` (from the pi-work source repo) |
| `e2e/*.mjs` | browser scenarios (sessions, model selector, file panel, appearance) | `node e2e/run.mjs` |
| docker smoke | production image boot, 63/63 extensions loaded, reload clean | `docker/scripts/smoke.sh` |
