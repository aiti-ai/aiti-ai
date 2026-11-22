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

`test/gui.test.mjs` drives a real window (cover geometry, pinned placement, daemon reopen);
it starts a private `Xvfb :97` + openbox when no DISPLAY is set and skips itself when neither
a display, xdotool nor the `aiti-desktop-widget` binary is available.

## CLI

```bash
aiti-dialog confirm --text "Continue?" [--ok-label OK] [--cancel-label Cancel]
aiti-dialog --dialog confirm --text "Continue?"          # same, zenity-ish flag form
aiti-dialog input --text "Name:" [--default foo] [--password]
aiti-dialog choose --text "Pick" --options "A,B,C"
aiti-dialog file [--multiple] [--filter "*.png"]
aiti-dialog directory
aiti-dialog notify --text "Done" [--timeout 5]
aiti-dialog custom --page http://127.0.0.1:PORT/page.html
aiti-dialog --daemon [--port 18095] [--token T] [--ttl 600]
```

Shared flags: `--json` (print the full host envelope), `--timeout <seconds>`,
`--title`, `--detail`, `--widget-bin`, `--no-window` (print the page URL instead of
opening a window), `--width`, `--height`, `--x`/`--y` (absolute screen coordinates),
`--display <index|name|primary>` (x/y then become monitor-local offsets), `--center`.
Passing any explicit geometry flag pins the window: the built-in page then skips auto-fit
(`?autosize=0`) so the card stays exactly at the requested position/size, which matters when
it was placed outside a recording rectangle.

Exit codes (zenity-compatible): `0` answered, `1` cancelled, `5` timeout,
`2` usage error, `4` runtime error (no window / no widget binary).

The daemon prints `{"ok":true,"port":N,"baseUrl":"…","token":"…"}` and accepts:

```text
POST /interactions            { kind, title, message, ... } -> { id }
GET  /interactions/:id/wait   blocks until resolved
GET  /interactions/pending
GET  /interactions/events     SSE
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

## Placement

The shell takes absolute screen coordinates; the package ships pure geometry helpers so a
host can keep cards outside a recording rectangle and handle multi-head layouts:

```ts
import { monitorRect, placeOnMonitor, placeOutside } from "@aiti-ai/widget-interaction";

const second = { x: 1920, y: 0, width: 2560, height: 1440 };
const capture = monitorRect(second, { x: 200, y: 120, width: 1600, height: 1000 });
const spot = placeOutside(capture, { width: 560, height: 260 }, { gap: 16, monitors: [second] });

const win = new InteractionWidgetWindow({ width: 560, height: 260, x: spot.x, y: spot.y });
await win.open(server.url);
win.move(spot.x, spot.y + 40);   // follow a moving target
```

`placeOutside` tries bottom → top → right → left, rejects slots that overlap the avoided
rect or leave the monitor, and falls back to a clamped position. `placeOnMonitor` maps
monitor-local offsets to absolute coordinates (the same math as `--display`); `clampRect`
keeps a rect inside a monitor. Cards placed outside the capture rect are never recorded.

## Desktop cover

`DesktopCover` hides a region from a desktop recording: the widget opens a click-through,
focus-proof, always-on-top window whose pixels are the cover. v1 covers (solid color /
pattern / translucent); real-time mosaic needs screen capture and is out of scope.

```ts
import { DesktopCover, monitorRect } from "@aiti-ai/widget-interaction";

const cover = new DesktopCover({
  rect: monitorRect(display, { x: 200, y: 120, width: 900, height: 600 }),
  color: "#101216",
  opacity: 0.9,
  pattern: "grid",          // solid | grid | stripes
});
await cover.open();          // spawns aiti-desktop-widget --html page/cover.html?...
cover.move({ x: 320, y: 200 });                 // follow the target window
await cover.update({ color: "#000000", opacity: 1 });
await cover.close();
```

The cover is a separate process: refreshing/repainting the recorded page cannot remove it,
and it survives page navigation. It is inside the capture area on purpose — being captured
is what hides the pixels.

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

### Custom pages

A host can render its own UI instead of the built-in cards. The page is opened with the
broker coordinates appended (`withInteractionParams`, also used by
`aiti-dialog custom --page <url>`):

```text
http://127.0.0.1:<page-port>/custom.html?base=http://127.0.0.1:<broker-port>/&token=<token>
```

The page imports the public client module from the broker origin (static assets send
`access-control-allow-origin: *`) and answers with the same id:

```js
const params = new URLSearchParams(location.search);
const base = (params.get("base") || location.origin).replace(/\/+$/, "");
const { connectInteraction } = await import(`${base}/interaction-client.js`);
const client = await connectInteraction({ baseUrl: base });

client.onRequest((request) => render(request));       // request.kind === "custom"
client.onUpdate((id, state) => update(id, state));    // host-owned UI state
client.onResolved((id, result) => close(id, result));
await client.answer(request.id, { action: "approve", approved: true, value: { ... } });
```

[`page/custom-example.html`](page/custom-example.html) is a complete, dependency-free
example. Pending state still lives in the broker, so the custom page can be refreshed or
reopened without losing the request; only the rendering restarts.

`aiti-dialog custom --page <url>` requires a loopback URL: the token travels in the page
URL, so a remote origin would receive it. Hosts that embed the API (`broker.open({ kind: "custom",
custom: { pageUrl } })` + `window.open(...)`) should apply the same rule and pass the URL
through `withInteractionParams(pageUrl, server.baseUrl, server.token)`.

## Guarantees

- Pending state and callbacks live in the Host, not the page.
- Duplicate/late answers are rejected; the first final answer wins.
- Page refresh/reconnect recovers from `GET /pending` + an SSE snapshot.
- Timeout/cancel are host-owned; the page only displays them.
- The HTTP server binds loopback by default and uses a random token.

## MCP stdio

```bash
npm run build
node bin/widget-interaction-mcp.mjs --no-widget   # print the page URL on stderr
node bin/widget-interaction-mcp.mjs               # also opens aiti-desktop-widget
```

Tools: `widget_confirm`, `widget_choose`, `widget_input`, `widget_pick_path`,
`widget_presence`, `widget_notify`, `widget_await`, `widget_cancel`. The tool call blocks
until the page answers (or the request times out); every tool returns the host envelope.
`stdout` is JSON-RPC only; diagnostics go to stderr.

Pass `async: true` to any ask tool to get `{id, status:"pending"}` immediately; collect the
answer with `widget_await({ id })` (optionally with a client-side `timeout`, which returns
`{status:"timeout", pending:true}` and leaves the host request pending).

### Share one window with a daemon

Start the daemon once, then point any number of MCP clients at it — they all reuse the
same broker and window instead of paying the WebView start-up cost per request:

```bash
# terminal 1: long-lived host + window; prints {ok, port, baseUrl, token}
aiti-dialog --daemon --port 18095

# terminal 2: MCP server that proxies to the daemon
node bin/widget-interaction-mcp.mjs --http http://127.0.0.1:18095/ --token <token>
```

Over HTTP the tools map to `POST /interactions` + `GET /interactions/:id/wait`, so late
waits replay the stored envelope; `widget_cancel` maps to `POST /interactions/:id/cancel`.
In-process code can use the same transport without MCP:

```ts
import { createHttpInteractionTransport } from "@aiti-ai/widget-interaction";
const transport = createHttpInteractionTransport({ baseUrl: "http://127.0.0.1:18095/", token });
const answer = await transport.ask({ kind: "confirm", title: "Continue?" });
```

## Not in this first version

- Form builder / schema-driven custom UI (bring your own page instead).
- Real-time desktop mosaic (the click-through cover window is v1).
- Reuse of aiti-devtools launcher UI primitives.
