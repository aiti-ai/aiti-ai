#!/usr/bin/env node
/**
 * Build the aiti-proc-tree JSX client bundle (Vite lib mode → dist/aiti-proc-tree-client.mjs)
 * Usage: node tools/build-client.mjs
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteBin = existsSync(viteJs) ? viteJs : resolve(createRequire(import.meta.url).resolve("vite/package.json"), "..", "bin", "vite.js");
const r = spawnSync(process.execPath, [viteBin, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (r.status !== 0) {
  console.error("[aiti-proc-tree] vite build failed (exit " + r.status + "). If vite is missing: cd extensions/aiti-proc-tree && npm install");
  process.exit(r.status ?? 1);
}
console.log("[aiti-proc-tree] JSX client bundle → dist/aiti-proc-tree-client.mjs");
