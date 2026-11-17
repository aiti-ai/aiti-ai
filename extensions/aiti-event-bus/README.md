# @aiti-ai/aiti-event-bus

> The page event bus for pi-web: takes over `__piPageEvents`, topic subscriptions with server-side filtering, publish-local for high-frequency frames, load-priority guarantee, and STALE_CONN silent rebuild.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## What it does

The single event bus for page events in pi-web. The bus implementation is owned by this extension; the core `lib/agent-page-events.ts` stays untouched as the fallback host + core's own channel (SessionSidebar running).

## Mechanism: accessor-property takeover

All page-event publishes (core `running`, plan-first `pf:remind`, model-check `mc:avail`, editor `ed-watch`, …) go through the global `globalThis.__piPageEvents.publish` mouth. At startup this extension converts the `__piPageEvents` property into an **accessor** (`installPageEventSlot`, bus-core.ts):

- **Reads** always return a stable slot object (`publish` = a wrapper feeding both the previous owner and this bus) — core receives every frame with zero changes
- **Writes** (module re-evaluation / reassignment by others) are absorbed by the setter as "previous owner update" — immune to turbopack dev's unconditional global reassignment, independent of evaluation order
- **Restore guard**: uninstall only when the accessor is still the one installed by this extension (no hot-reload stacking); on reload all SSE connections are closed so clients' EventSource reconnects to the new bus instance
- `bus-core.ts` is a pure kernel (`createEventBus` broadcaster + `installPageEventSlot`), directly tested with `node --test`

## Surfaces

| Surface | Contract |
|---|---|
| SSE | `GET /api/extensions/aiti-event-bus/events` — frame contract `{type,...}` identical to the core route; a named `hello` (`{conn}`) is pushed on connect (clients declare subscriptions based on it); named `heartbeat` every 30s, never dispatched as frames |
| Subscription declaration | `POST /api/extensions/aiti-event-bus/subscribe` `{conn, types:[...]|null}` — type whitelist for this connection (whole replacement; empty array = legal empty whitelist; null = all frames). Forwarding filters by the whitelist (`frameMatches`): **non-matching frames never leave the SSE** — high-frequency extensions (aiti-cmd terminal `cmd-<id>`) rely on this to keep unrelated frames away from subscribers; undeclared connections receive all frames (v0.1 compatible). Exact items match exactly; trailing `*` items act as prefix wildcards (e.g. `sched:*`). After EventSource reconnection the new connection's subscription set is empty → clients re-send the full set after hello |
| Connection keep-alive | `POST /heartbeat {conn}` — client broker every 45s; server scan (60s): connections that sent heartbeats but weren't refreshed for 3min are judged half-open (page dead, TCP not closed) → cleanup. Old v0.1 clients don't send heartbeats and never time out (compatible) |
| Server service outlets | `ctx.services.provide("aiti-event-bus.publish", { publish(type, data) })` — feeds through the global slot (the core route also receives; for low-frequency state frames). `ctx.services.provide("aiti-event-bus.publish-local", { publish })` — straight to the bus, **not fed to core** (v0.2): dedicated to high-volume frames (terminal streams), keeping core-route subscribers clean; local frames never appear on `/api/agent/running/events` |
| Client service outlets | `ctx.registerExtService("aiti-event-bus.subscribe", subscribePageFrames)` (all frames, v0.1 compatible) + `ctx.registerExtService("aiti-event-bus.subscribe-topics", subscribeTopics)` (topic subscription, v0.2) |
| Client broker | Page-level singleton SSE + reference counting (closed when the last subscription leaves); dispatch/unsubscribe contract matches core `window.__piPageEventsClient` |

## Consumer integration (topics only)

```js
// The only subscription mode: type whitelist (server-side SSE filtering + local dispatch filtering)
const topics = ctx.getExtService?.("aiti-event-bus.subscribe-topics");
if (!topics) return;               // bus not enabled → don't subscribe, degrade the feature; no fallback
const h = topics(handler, ["cmd-s_ab12", "sched:*"], (status) => { /* up/down/reconnecting */ });
// h.ready: the whitelist is active server-side (pull initial snapshots after this for a seamless join)
// ...h.off() to unsubscribe
```

> **No fallback paths**: do not write all-frame subscriptions (`subscribePageFrames`), core `__piPageEventsClient`, or hand-rolled EventSource as a fallback — the `subscribePageFrames` outlet exists only for compatibility; new code always uses topics.

### High-frequency stream conventions (aiti-cmd paradigm)

- **Publishers manage their own sending**: one dedicated type per instance (terminal `cmd-<sessionId>`, agent command `cmd-<toolCallId>`); list snapshots use fixed types (`cmd-sessions` / `cmd-pilist`); frames are `{ type, evt, seq?, ...}`.
- **Publish via publish-local**: high-volume terminal frames go straight to the bus without feeding the core route; low-frequency state frames (`pf:remind`/`mc:avail`/`ed-watch`/`gr:task`/`sched:*`) keep using `aiti-event-bus.publish` (dual-fed).
- **Subscription keep-alive (stop-push protocol)**: while a frontend subscription exists, the producer's client POSTs its active type list to **its own backend** every 15s (aiti-cmd: `/alive`); the backend stops pushing types that were reported alive but timed out (aiti-cmd: 45s) and optimistically pushes types never reported (no frame loss before a new subscriber's first heartbeat). Page/panel closed → heartbeat stops → source disconnects; reopened → heartbeats resume → pushing continues automatically (interruption gaps are filled via REST snapshots + `seq`).
- **Big messages don't use the bus**: initial replay / full snapshots (potentially MB-sized) are fetched by subscribers via REST after subscribing; producers carry a monotonic `seq` per frame so clients dedupe real-time frames against the snapshot baseline.
- Only real-time incremental frames (small) go through the bus.

### Consumer topology

| Consumer | Channel | Whitelist |
|---|---|---|
| aiti-cmd (TerminalView/PiCommandView/overview list) | bus topics | `cmd-<id>` / `cmd-sessions` / `cmd-pilist` |
| aiti-ai-schedule | bus topics | `sched:*` (wildcard) |
| aiti-editor (two watchers) | bus topics | `ed-watch` |
| aiti-git-review | bus topics | `gr:task` |
| aiti-plan-first | bus topics | `pf:remind` |
| aiti-model-wizard | bus topics | `mc:avail` |
| session-manager / SessionSidebar | core route (`__piPageEventsClient`) | — |

Producer integration (service outlets first, global mouth as transitional):

```ts
ctx.services?.get("aiti-event-bus.publish")?.publish("my:evt", { ... });
// transitional equivalent: (globalThis as any).__piPageEvents?.publish("my:evt", { ... })
```

Steady state: two SSE connections — the core route (SessionSidebar's own running) + this extension's `/events` (all other page consumers, including topic subscriptions for aiti-cmd terminal streams).

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-event-bus/` and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/guide/ext-services.html>
- 文档（中文）: <https://aiti.pw/guide/ext-services.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
