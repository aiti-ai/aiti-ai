#!/usr/bin/env node
/**
 * Build the client bundle: client/src/entry.ts -> dist/aiti-containers-client.mjs
 *
 * Zero runtime dependencies (hyperscript only), so this is a plain TS -> ESM
 * transpile. Prefers a local esbuild install and falls back to the repo root
 * devDependency (the extension itself ships no bundler).
 *
 * Usage: node tools/build.mjs
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "..", "..");

const candidates = [
  resolve(root, "node_modules/esbuild/lib/main.js"),
  resolve(repoRoot, "node_modules/esbuild/lib/main.js"),
];
const esbuildEntry = candidates.find((p) => existsSync(p));
if (!esbuildEntry) {
  console.error("[build] esbuild not found. Install it with `npm i -D esbuild` here or at the repo root.");
  process.exit(1);
}

const mod = await import(pathToFileURL(esbuildEntry).href);
const build = mod.build || (mod.default && mod.default.build);
if (typeof build !== "function") {
  console.error("[build] esbuild module shape unexpected:", Object.keys(mod).join(","));
  process.exit(1);
}

const outfile = resolve(root, "dist", "aiti-containers-client.mjs");
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "client/src/entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  outfile,
  sourcemap: false,
  minify: false,
  logLevel: "info",
  legalComments: "none",
});

console.log("[build] dist/aiti-containers-client.mjs");
