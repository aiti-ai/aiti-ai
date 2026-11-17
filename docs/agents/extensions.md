# Extension host & slots (fork)

The extension system is aiti-ai's main addition on top of upstream pi-web: extensions install into `~/.pi/web/extensions/<id>/` and get server hooks, UI slots and an api dispatch surface. The upstream compatibility principle (AGENTS.md, Architecture) still governs: pi CLI extensions must behave the same here; fix display problems in the web client.

## Server side (`lib/ext/`)

- `lib/ext/types.ts` — PiWebExtension contract: server hooks (`server.startup/middleware/api/…`) + `ui` metadata + the `ExtCoreApi` data contract.
- `lib/ext/loader.ts` — loads each extension via jiti (`moduleCache:false` enables reload). Bare specifiers resolve against the extension's own directory, so extensions carry standard npm `node_modules`.
- `lib/ext/registry.ts` — `globalThis.__piWebExt` singleton: loadAll / startAll / shutdown / reload / api dispatch / middleware chain / manifest / asset-path traversal protection.
- `lib/ext/core.ts` — `makeExtCore()`: listSessions / getRunningSessionIds / getHomeDir.
- `lib/ext/data-dir.ts` — code at `~/.pi/web/extensions`, data at `~/.pi/web/data/<extId>/` (overridable via `PI_WEB_EXTENSIONS_DIR` / `PI_WEB_DATA_DIR`).
- Draft persistence moved out of core → the aiti-draft-keeper extension (composer contract v2).

## Client side

- `components/ExtSlots.tsx` — `ExtSlotsProvider` fetches the manifest, dynamic-imports client bundles and calls each extension's `register(ctx)`; `<ExtSlot name=…/>` marks the slot points (sidebar blocks, `sessionRowActions` inside SessionSidebar, …).
- `lib/ext-ui-store.ts` — client slot registry (`window.__piWebExtUI` + subscribe revision).
- `GET /api/extensions/client-bundle?rev=<rev>` serves the eager client-bundle batch (one request for many extensions).

## Capability takeover (`ui.provides`)

An extension declares built-in capabilities it takes over in `ui.provides: string[]` (names live in `EXT_PROVIDES`, `lib/ext/types.ts`). The manifest ships as-is and the client queries it with `useExtProvides()` — when a capability is declared, the corresponding built-in UI hides (the flow belongs to the extension); with no declarer the built-in shows as usual. Adding a capability: register it in `EXT_PROVIDES` + gate the built-in UI. Registered capabilities:

- `session-delete` — session deletion takeover (session-manager's archive-then-delete): the sidebar hides its built-in delete button.
- `session-agent-source` — external agent session source (session-manager slot contract: normalized pulls across the manifest/list/session endpoints).

## Routes

`app/api/extensions/**`: `[...path]` api dispatch + assets (behind the security gates, asset traversal protection) · `manifest` (client manifest: UI metadata + clientUrl + i18n) · `client-bundle` · `status` (full status: disabled/failed entries, insertion points, hooks, deps) · `reload` (hot reload: shutdown → loadAll → startAll). Extension management UI/install/online registry moved out of core → the external aiti-extman extension (`/api/extensions/aiti-extman/{status,registry,ops}`).

## service-tunnels (extracted extension)

Service port discovery / virtual-host proxying / tunnels / auth / self-exposure live in the `service-tunnels` extension (source mirrored under `extensions/service-tunnels/`, deployed to `~/.pi/web/extensions/service-tunnels/`):

- `server.startup` creates the library singleton (`globalThis.__piServiceTunnels`); `server.middleware` handles service vhosts (`st.proxy.parseHost/resolve`) and the allowlocal direct-access gate ahead of the core gates; `server.api` serves `/api/extensions/service-tunnels/*` (discovery/expose/tunnels/users/TOTP/self-exposure).
- core keeps only the generic security gates (DNS-rebinding + `PI_WEB_PASSWORD`); `request-security.ts` still reads the extension-written `globalThis.__piWebExposeConfig` / `__piWebAllowHostsOverride` for allowHost exceptions.
- WebSocket upgrades are NOT proxied by the middleware (Next no-ops non-HMR upgrades) — Vite HMR etc. need direct localhost or a tunnel.
- Provider knowledge lives in the library: pi-web consumes `providerOrder`/`defaultProvider`/`userManagers`/`tunnelSchemas`/`tunnelTcpSupport` — no provider names hardcoded in pi-web.
- Tests: `node --test lib/service-ports.test.mjs lib/request-security.test.mjs lib/web-auth.test.mjs`.
