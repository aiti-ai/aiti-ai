#!/usr/bin/env node
/**
 * Build the JSX client bundle (Vite lib mode → dist/aiti-session-cards.mjs)
 *
 * Wraps `vite build`, ensuring vite resolves from this extension's own node_modules (no host install dependency).
 * Sources: client/src/*.tsx; config: vite.config.ts.
 *
 * Usage: node tools/build-client.mjs
 *        npm run watch   (vite build --watch; source edits rebuild automatically → HMR with the frontend rev poller)
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// On Windows spawning .bin/vite (extension-less sh script) silently fails with status=null;
// cross-platform we run the vite.js entry directly with node (the .bin shim's real target — what npm scripts do internally).
const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteBin = existsSync(viteJs) ? viteJs : resolve(createRequire(import.meta.url).resolve("vite/package.json"), "..", "bin", "vite.js");

const r = spawnSync(process.execPath, [viteBin, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (r.status !== 0) {
  console.error("[ext-jsx] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/<your-ext> && npm install");
  process.exit(r.status ?? 1);
}
console.log("[ext-jsx] JSX client bundle → client/（见 vite.config.ts 的 fileName）");
