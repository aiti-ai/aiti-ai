# @aiti-ai/widget-interaction

Host-owned, refresh-safe user interaction for aiti widgets.

A page is only a renderer. The host owns pending requests and the Promise/callback;
SSE mirrors requests to the page, HTTP submits answers. Refreshing or reopening the
page does not lose the pending request.

## Install / build

This package lives in the aiti-ai monorepo:

```bash
cd packages/aiti-widget-interaction
npm run build
node --test test/*.test.mjs
```

## Host API

```ts
import { InteractionBroker, startInteractionServer, InteractionWidgetWindow } from "@aiti-ai/widget-interaction";

const broker = new InteractionBroker();
const server = await startInteractionServer({ broker, port: 0 });
const window = new InteractionWidgetWindow({ width: 560, height: 260 });
await window.open(server.url);

const answer = await broker.ask({
  kind: "confirm",
  title: "Continue?",
  message: "The host owns this pending request.",
  actions: [
    { id: "continue", label: "Continue", kind: "primary" },
    { id: "cancel", label: "Cancel", kind: "secondary" },
  ],
});
// { id, status: "answered", action: "continue", approved: true, tookMs, ... }

await window.close();
await server.close();
broker.close();
```

Custom / stateful UI:

```ts
const opened = broker.open({
  kind: "custom",
  keepOpen: true,
  custom: { pageUrl: "http://127.0.0.1:PORT/custom.html" },
  data: { project: "demo" },
});
await broker.update(opened.id, { state: "paused", label: "Paused" });
await broker.resolve(opened.id, { status: "answered", action: "stop" });
```

`open()` returns `{ id, request, result }`; `ask()` returns the result Promise directly.

## Page protocol

```text
GET  /interactions/pending
GET  /interactions/events       // SSE: snapshot / request / update / resolved
POST /interactions/:id/answer   // { action, approved?, value?, comment?, keepOpen?, state? }
POST /interactions/:id/cancel
```

The built-in page is served at `/` (with `?token=` if auth is enabled). It supports
`confirm`, `choose`, `input` and a queue. The token is required for state endpoints;
the static page/client assets are public.

Custom page:

```js
import { connectInteraction } from "/interaction-client.js";
const client = await connectInteraction();
client.onRequest((request) => render(request));
client.onUpdate((id, state) => update(id, state));
client.answer(id, { action: "continue", value: {} });
```

## Guarantees

- Pending state and callbacks live in the Host, not the page.
- Duplicate/late answers are rejected; the first final answer wins.
- Page refresh/reconnect recovers from `GET /pending` + an SSE snapshot.
- Timeout/cancel are host-owned; the page only displays them.
- The HTTP server binds loopback by default and uses a random token.

## Not in this first version

- Native file/folder picker.
- Custom page validation/registration policy beyond an explicit loopback URL.
- MCP server wrapper.
- Desktop cover / real-time mosaic.
- Reuse of aiti-devtools launcher UI primitives.
