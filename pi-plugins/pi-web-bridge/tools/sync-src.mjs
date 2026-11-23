#!/usr/bin/env node
// sync-src.mjs — assemble the published package sources from the single-owner sources.
//
// The development sources live inside the dev monorepo (extensions/aiti-attach-agent);
// this package is the publishable view of them. One-way generation, always safe to re-run:
//
//   extensions/aiti-attach-agent/pi-tui/pi-web-bridge.ts  → src/pi-web-bridge.ts
//       (the "../bridge-registry" import is rewritten to "./bridge-registry" — the two
//        files are flattened into one src/ directory here)
//   extensions/aiti-attach-agent/bridge-registry.ts        → src/bridge-registry.ts
//   packages/aiti-devtools-pi/dist/aiti-devtools-pi.js     → dist/aiti-devtools-pi.js
//       (the aiti_* connector bundle; build it first with
//        `node packages/aiti-devtools-pi/tools/build.mjs` if missing)
//
// Usage: node tools/sync-src.mjs   (wired as the package `prepack` script)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
// Repo root candidates: aiti-ai keeps the package at <repo>/pi-plugins/pi-web-bridge,
// an older checkout layout had it at <repo>/pi-web-bridge — accept both.
const repoRoots = [resolve(pkg, "..", ".."), resolve(pkg, "..")];
// Single-source checkout = extensions/aiti-attach-agent (aiti-ai); older checkouts
// (pi-web-ext/...) are still accepted so the tool keeps working from old trees.
const srcRoot = repoRoots
  .flatMap((r) => [join(r, "extensions", "aiti-attach-agent"), join(r, "pi-web-ext", "aiti-attach-agent")])
  .find((d) => existsSync(d));
const repo = repoRoots.find((r) => existsSync(join(r, "packages", "aiti-devtools-pi"))) || repoRoots[0];
const tuiSrc = srcRoot ? join(srcRoot, "pi-tui", "pi-web-bridge.ts") : "";
const registrySrc = srcRoot ? join(srcRoot, "bridge-registry.ts") : "";
const guardSrc = srcRoot ? join(srcRoot, "registration-guard.mjs") : "";
const guardTypes = srcRoot ? join(srcRoot, "registration-guard.d.mts") : "";
const bundleSrc = join(repo, "packages", "aiti-devtools-pi", "dist", "aiti-devtools-pi.js");

// Mirror-repo guard: inside a publish snapshot of this package the monorepo sources are
// absent by design — src/dist are committed there already. Skip silently when they exist;
// only fail if the package is incomplete.
if (!srcRoot || !existsSync(tuiSrc)) {
  if (existsSync(join(pkg, "src", "pi-web-bridge.ts")) && existsSync(join(pkg, "src", "registration-guard.mjs")) && existsSync(join(pkg, "dist", "aiti-devtools-pi.js"))) {
    console.log("[pi-web-bridge] mirror snapshot: src/dist already assembled, skipping regeneration");
    process.exit(0);
  }
  console.error("[pi-web-bridge] not a dev checkout and src/dist missing — package incomplete");
  process.exit(1);
}

for (const f of [tuiSrc, registrySrc, guardSrc]) {
  if (!existsSync(f)) {
    console.error(`[pi-web-bridge] missing source: ${f}`);
    process.exit(1);
  }
}

mkdirSync(join(pkg, "src"), { recursive: true });

// Flatten the directory layout: pi-tui/ imports the registry and the duplicate guard
// from the extension root; in this package all files sit side by side in src/, so both
// imports are rewritten to "./…".
let bridge = readFileSync(tuiSrc, "utf8");
const rewritten = bridge
  .replace(/from "\.\.\/bridge-registry"/g, 'from "./bridge-registry"')
  .replace(/from "\.\.\/registration-guard\.mjs"/g, 'from "./registration-guard.mjs"');
if (!/from "\.\/bridge-registry"/.test(rewritten) || !/from "\.\/registration-guard\.mjs"/.test(rewritten)) {
  console.error('[pi-web-bridge] expected to rewrite `../bridge-registry` and `../registration-guard.mjs` — import shape changed? Check pi-tui/pi-web-bridge.ts');
  process.exit(1);
}
writeFileSync(join(pkg, "src", "pi-web-bridge.ts"), rewritten);

copyFileSync(registrySrc, join(pkg, "src", "bridge-registry.ts"));
copyFileSync(guardSrc, join(pkg, "src", "registration-guard.mjs"));
if (existsSync(guardTypes)) copyFileSync(guardTypes, join(pkg, "src", "registration-guard.d.mts"));

mkdirSync(join(pkg, "dist"), { recursive: true });
if (!existsSync(bundleSrc)) {
  console.error(`[pi-web-bridge] connector bundle missing: ${bundleSrc}`);
  console.error("[pi-web-bridge] build it first: node packages/aiti-devtools-pi/tools/build.mjs");
  process.exit(1);
}
copyFileSync(bundleSrc, join(pkg, "dist", "aiti-devtools-pi.js"));

console.log("[pi-web-bridge] src/ + dist/ assembled from monorepo sources");
