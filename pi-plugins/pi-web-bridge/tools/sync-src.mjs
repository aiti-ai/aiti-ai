#!/usr/bin/env node
// sync-src.mjs — assemble the published package sources from the single-owner sources.
//
// The development sources live inside the aiti-ai monorepo (pi-web-ext/aiti-attach-agent);
// this package is the publishable view of them. One-way generation, always safe to re-run:
//
//   pi-web-ext/aiti-attach-agent/pi-tui/pi-web-bridge.ts  → src/pi-web-bridge.ts
//       (the "../bridge-registry" import is rewritten to "./bridge-registry" — the two
//        files are flattened into one src/ directory here)
//   pi-web-ext/aiti-attach-agent/bridge-registry.ts        → src/bridge-registry.ts
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
const repo = resolve(pkg, "..");
const tuiSrc = join(repo, "pi-web-ext", "aiti-attach-agent", "pi-tui", "pi-web-bridge.ts");
const registrySrc = join(repo, "pi-web-ext", "aiti-attach-agent", "bridge-registry.ts");
const bundleSrc = join(repo, "packages", "aiti-devtools-pi", "dist", "aiti-devtools-pi.js");

// Mirror-repo guard: inside the aiti-ai publish snapshot (pi-plugins/pi-web-bridge) the
// monorepo sources are absent by design — src/dist are committed there already and were
// assembled by the aiti-ai sync before mirroring. Skip silently when they exist; only
// fail if the package is incomplete.
if (!existsSync(tuiSrc)) {
  if (existsSync(join(pkg, "src", "pi-web-bridge.ts")) && existsSync(join(pkg, "dist", "aiti-devtools-pi.js"))) {
    console.log("[pi-web-bridge] mirror snapshot: src/dist already assembled, skipping regeneration");
    process.exit(0);
  }
  console.error("[pi-web-bridge] not a dev checkout and src/dist missing — package incomplete");
  process.exit(1);
}

for (const f of [tuiSrc, registrySrc]) {
  if (!existsSync(f)) {
    console.error(`[pi-web-bridge] missing source: ${f}`);
    process.exit(1);
  }
}

mkdirSync(join(pkg, "src"), { recursive: true });

// Flatten the directory layout: pi-tui/ imports the registry via "../bridge-registry";
// in this package both files sit side by side in src/, so rewrite to "./bridge-registry".
let bridge = readFileSync(tuiSrc, "utf8");
const rewritten = bridge.replace(/from "\.\.\/bridge-registry"/g, 'from "./bridge-registry"');
if (rewritten === bridge) {
  console.error('[pi-web-bridge] expected to rewrite `from "../bridge-registry"` — import shape changed? Check pi-tui/pi-web-bridge.ts');
  process.exit(1);
}
writeFileSync(join(pkg, "src", "pi-web-bridge.ts"), rewritten);

copyFileSync(registrySrc, join(pkg, "src", "bridge-registry.ts"));

mkdirSync(join(pkg, "dist"), { recursive: true });
if (!existsSync(bundleSrc)) {
  console.error(`[pi-web-bridge] connector bundle missing: ${bundleSrc}`);
  console.error("[pi-web-bridge] build it first: node packages/aiti-devtools-pi/tools/build.mjs");
  process.exit(1);
}
copyFileSync(bundleSrc, join(pkg, "dist", "aiti-devtools-pi.js"));

console.log("[pi-web-bridge] src/ + dist/ assembled from monorepo sources");
