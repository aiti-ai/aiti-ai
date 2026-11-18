/**
 * The whole integration: one plugin.
 *
 * `aitiDevtools()` attaches a second surface to this dev server on the same
 * origin — the bridge (`/aiti/bridge/*`), the MCP endpoint (`/aiti/mcp/*`),
 * the launcher script and the cockpit page — then injects the launcher into
 * every served HTML page. Nothing is added to the production build.
 *
 * Everything below is optional; the defaults are what a first run wants.
 */
import { defineConfig } from "vite";
import { aitiDevtools } from "@aiti-ai/aiti-devtools-vite";

export default defineConfig({
  root: import.meta.dirname,
  server: {
    port: 5199,
    strictPort: true,
    // Reachable from other devices/tunnels; drop both for a loopback-only demo.
    host: true,
    allowedHosts: true,
  },
  // Working on the plugin itself? Point at the repository sources instead and drop
  // the alias below in the dependency; see README "Depend on the sources".
  // resolve: {
  //   alias: {
  //     "@aiti-ai/aiti-devtools-core": fileURLToPath(
  //       new URL("../../packages/aiti-devtools-core/src/index.ts", import.meta.url),
  //     ),
  //   },
  // },
  plugins: [
    aitiDevtools({
      // name: "aiti-devtools-demo", // identity in MCP entries/logs/annotations when several projects run side by side
      // bridgeUrl: "",              // external bridge; empty = same origin as this app
      // aiUrl: "",                  // agent/cockpit address; empty = same-origin cockpit.html
      // prefix: "/aiti",            // mount prefix for every endpoint
      mcp: {
        register: true, // register the MCP endpoint with installed agent CLIs at startup
        targets: "auto", // only rewrite config files that already exist
        // dryRun: true, // report what would be written
      },
      // assetsDir: "../../packages/aiti-devtools-inject/dist", // watch launcher edits live
    }),
  ],
});
