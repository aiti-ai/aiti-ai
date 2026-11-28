# AGENTS.md — aiti-codehub

## Where things live

- `index.ts` — manifest: features, UI entries, server hooks, AI skills.
- `ui-i18n.ts` — the three locale tables (en / zh-CN / zh-TW) consumed by the manifest
  `ui.i18n`; client copy goes through `ctx.t()`, provider descriptor copy (auth fields /
  filters / platform names) is translated client-side by key with the server value as
  fallback (`tf()` in ui.tsx / store.ts). Deploy copies this file (see tools/deploy.mjs);
  tests/i18n.test.mjs guards key alignment and placeholder consistency.
- `server/`
  - `contract.ts` — the meta-model + provider interface (single source of truth).
  - `http.ts` — timeout / error mapping / pagination / token redaction.
  - `store.ts` — config (0600) / state / cache / recents scoring.
  - `oauth.ts` — generic OAuth orchestration (state, PKCE, DCR, refresh, event bus).
  - `routes.ts` — `/api/extensions/aiti-codehub/*` (provider-agnostic).
  - `tools.ts` — `aiti_codehub_*` agent tools (write tools gated + confirm).
  - `runtime.ts` — startup/shutdown, storage, registry, event publishing.
- `providers/<id>/` — API mapping only (`api.ts`), OAuth driver (`oauth.ts`), provider
  object (`index.ts`). **No provider-specific branching above this layer.**
- `client/src/` — entry, two surfaces (`workitems.tsx`, `code.tsx`), dialogs
  (`detail.tsx`, `settings.tsx`, `mr.tsx`, `clone.tsx`), hub source, UI primitives.
- `tests/` — contract / format / store / http / oauth / routes / provider mapping /
  instances (ids, alias rules, delete cascade, two-account isolation).

## Invariants

- Server owns secrets. `GET /config` returns `hasToken` / `hasSecret` only.
- Provider HTTP bases are allow-listed; never fetch a client-supplied URL.
- Rich text → plain text + image URLs; never `innerHTML` provider data.
- OAuth: Yunxiao = DCR + PKCE + virtual landing page (`/<basePath?>/aiti-codehub/oauth/<provider>`,
  served by `server/middleware.ts`, never under `/api`, path segment = instance id);
  default callback `127.0.0.1:30141`,
  override via global `oauthCallbackBase`. GitHub/GitLab = device code (server-side poll,
  stops on success/cancel/expiry). Gitee = PAT only.
- Instances (multi-account): `<platform>` is the default account, `<platform>~<slug>`
  additional ones. Every request goes through `bind()` (`server/binding.ts`); never key
  config/state/cache by the platform id. `metaFor()`'s OAuth metadata cache is the one
  exception (platform-scoped, keyed by baseUrl). Client code branches on `platform` or
  capabilities, never on `instance.id === "yunxiao"`.
- Agent tools: reads on, writes off by default (`tool.<name>` feature) and `confirm: true`.
- Client bundle: no React imports (vite aliases `react` → `client/src/host-shim.ts`).

## Commands

```bash
node tools/build-client.mjs     # vite → dist/
node --test tests/*.test.mjs    # 111 tests (incl. i18n guards)
node tools/deploy.mjs           # dev deploy + POST /api/extensions/reload
```

Typecheck (sibling aiti-ai checkout provides TypeScript + @types/node):

```bash
node ../../../aiti-ai/node_modules/typescript/bin/tsc -p . \
  --typeRoots ../../../aiti-ai/node_modules/@types --types node
```

## Integration points (aiti-ai)

- `aiti-quickstart` — consumes topic `workspace-hub.source`; materializes `aiti-codehub`
  before reading the topic (`SOURCE_HINTS`). The clone endpoint is reused as-is.
- `aiti-folder` — client services `aiti-folder.commit` (`open({cwd,message})`),
  `aiti-folder.pick` (`directory({initialPath})`) and `aiti-folder.commit-actions`
  (register a button into the commit dialog's message action row). Inbound:
  this extension registers the "Work item" button there (`client/src/commit-action.ts`,
  id `aiti-codehub.work-item`) and aiti-folder's group-commit rows call
  `aiti-codehub.pickWorkItem` (`open()` → `Promise<{ text, provider, item } | null>`,
  text = paste-template header); the manifest declares `ui.clientLazyVia: "service"`
  and `prefetchOnIdle: true` so both entry points are ready without opening a
  surface first. The picker overlay (`client/src/workitem-picker.tsx`, dialogs id
  `workitem-pick`) hosts the real WorkItemsPanel with an embedded detail view.
- `aiti-git-ops` — branch creation through its server service/REST (`branch-create`).

## Gotchas

- Vite lib mode needs `rollupOptions.external: []` and the regex aliases for
  `react` / `react/jsx-runtime`; string aliases would swallow the latter.
- `_shared/ext-float-dock` requires the host shim to export `createElement` + hooks.
- `openFloat(key)` is the open path for docked panels (host expands the right panel).
- Tests import `.ts` directly (Node 24 type stripping); keep imports explicit (`.ts`).
