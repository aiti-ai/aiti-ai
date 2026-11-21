#!/usr/bin/env node
/**
 * Build the JSX client bundle (Vite lib mode → dist/<your-ext>-client.mjs)
 *
 * Wraps `vite build`, making sure vite resolves from this extension's own
 * node_modules (the extension does not depend on the host install).
 * Sources: client/src/*.tsx; config: vite.config.ts.
 *
 * Usage: node tools/build-client.mjs
 *        npm run watch   (vite build --watch, rebuild on change → HMR with the
 *        frontend rev poller)
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// On Windows, spawning .bin/vite (an sh script without extension) fails
// silently with status=null; run vite.js directly via node on every platform
// (the real target behind the .bin shim — what npm scripts do internally).
const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteBin = existsSync(viteJs) ? viteJs : resolve(createRequire(import.meta.url).resolve("vite/package.json"), "..", "bin", "vite.js");

const r = spawnSync(process.execPath, [viteBin, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (r.status !== 0) {
  console.error("[ext-jsx] vite build failed (exit " + r.status + "). If vite is missing: cd <ext-dir> && npm install");
  process.exit(r.status ?? 1);
}
console.log("[ext-jsx] JSX client bundle built → dist/ (see vite.config.ts fileName)");
