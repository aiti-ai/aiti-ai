#!/usr/bin/env node
/**
 * Build the client bundle with vite (resolved from this extension or the workspace root).
 * Usage: node tools/build-client.mjs [--watch]
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const watch = process.argv.includes("--watch");
const localVite = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteJs = existsSync(localVite)
  ? localVite
  : resolve(createRequire(import.meta.url).resolve("vite/package.json"), "..", "bin", "vite.js");

const args = [viteJs, "build", "--config", resolve(root, "vite.config.ts")];
if (watch) args.push("--watch");
const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", shell: false });
if (r.status !== 0) {
  console.error("[build] vite failed (exit " + r.status + "). Run `npm i` in the extension or the workspace root.");
  process.exit(r.status ?? 1);
}
console.log("[build] dist/aiti-codehub-client.mjs");
