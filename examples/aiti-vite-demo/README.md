# aiti-vite-demo — reference integration

The smallest complete example of attaching aiti-devtools to a web app: a plain
vite project whose only addition is one plugin call.

Published as **`@aiti-ai/example-vite`** (the `examples/aiti-vite-demo` directory).
The package is **standalone**: it depends on the vite carrier plugin and vite
only — it does not ship or pull the pi-web distribution, and the tarball is four
files plus a lockfile.

```bash
npm install
npm run dev          # http://127.0.0.1:5199
```

Then open the page. The launcher appears on it, and the same server answers:

| Path | What it is |
|---|---|
| `/aiti/aiti-launcher.js` | the injected launcher script (injected into every page automatically) |
| `/aiti/cockpit.html` | the agent cockpit / AI window |
| `/aiti/bridge/*` | bridge HTTP API the launcher talks to |
| `/aiti/mcp/*` | MCP endpoint, registered with installed agent CLIs at startup |

## What to look at

`vite.config.js` — the whole integration is `aitiDevtools()` inside `plugins`.
Every option is optional; the file shows the ones worth knowing (identity,
external bridge, mount prefix, MCP registration) as comments.

`index.html` — a normal page. There is nothing to add to the page itself: the
plugin injects the launcher through `transformIndexHtml`.

## Which packages it uses

As checked in, the demo installs the **published** packages, so `npm install && npm run dev` works anywhere without touching the rest of this repository.

### Depend on the sources (when working on the plugin)

Point the dependency at the local package and alias the core to its TypeScript sources so edits take effect without a rebuild:

```json
"@aiti-ai/aiti-devtools-vite": "file:../../packages/aiti-devtools-vite"
```

```js
resolve: { alias: { "@aiti-ai/aiti-devtools-core": fileURLToPath(new URL("../../packages/aiti-devtools-core/src/index.ts", import.meta.url)) } }
```

One extra step is required in that mode: the plugin package imports the core at
config-load time, before vite's aliases apply, so give it its own dependencies —
`npm install --prefix ../../packages/aiti-devtools-vite`.

## Other carriers

The same idea exists for other dev servers; the demo here is the vite one
because it is the least ceremony:

| Carrier | Package | Entry point |
|---|---|---|
| Vite (this demo) | `@aiti-ai/aiti-devtools-vite` | `aitiDevtools()` in `plugins` |
| Astro | `@aiti-ai/aiti-devtools-vite/astro` | the same plugin as an Astro integration |
| Nuxt | `@aiti-ai/aiti-devtools-nuxt` | module entry |
| webpack / Rspack | `@aiti-ai/aiti-devtools-webpack` | dev-server middleware plugin |
| Next.js | `@aiti-ai/aiti-devtools-core` | `patchProcessHttp()` from `instrumentation.ts` in dev |

## Notes

- Dev only: nothing is injected into `vite build` output.
- The bridge keeps its state under `~/.pi/aiti-bridge` by default (`dataDir` overrides it).
- If several aiti-instrumented projects run at once, give each a distinct `name`.
