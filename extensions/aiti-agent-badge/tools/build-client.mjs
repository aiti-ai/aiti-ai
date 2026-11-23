#!/usr/bin/env node
/**
 * Build the JSX client bundle (Vite lib mode -> dist/aiti-agent-badge.mjs).
 *
 * Wraps `vite build` and resolves vite from this extension's node_modules, so
 * the extension does not depend on a host-level vite install.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteBin = existsSync(viteJs)
  ? viteJs
  : resolve(createRequire(import.meta.url).resolve("vite/package.json"), "..", "bin", "vite.js");

const result = spawnSync(process.execPath, [viteBin, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (result.status !== 0) {
  console.error("[aiti-agent-badge] vite build failed (exit " + result.status + "). Run npm install in the extension dir if vite is missing.");
  process.exit(result.status ?? 1);
}
console.log("[aiti-agent-badge] client bundle -> dist/aiti-agent-badge.mjs");
