#!/usr/bin/env node
/**
 * aiti-ark-usage · deploy into ~/.pi/web{,-dev}/extensions/ (zero client bundle,
 * server-only: manifest + lib + skills).
 *
 * Takes effect via POST /api/extensions/reload (automatic).
 */
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

const root = resolve(import.meta.dirname, "..");

const targets = [
  resolve(homedir(), ".pi/web/extensions/aiti-ark-usage"),
  resolve(homedir(), ".pi/web-dev/extensions/aiti-ark-usage"),
];
for (const dir of targets) {
  mkdirSync(resolve(dir, "lib"), { recursive: true });
  cpSync(resolve(root, "package.json"), resolve(dir, "package.json"));
  cpSync(resolve(root, "index.ts"), resolve(dir, "index.ts"));
  for (const f of ["adapter.ts", "ark-api.ts", "config.ts", "sigv4.ts"]) {
    cpSync(resolve(root, "lib", f), resolve(dir, "lib", f));
  }
  mkdirSync(resolve(dir, "skills", "setup"), { recursive: true });
  cpSync(resolve(root, "skills", "index.json"), resolve(dir, "skills", "index.json"));
  cpSync(resolve(root, "skills", "setup", "SKILL.md"), resolve(dir, "skills", "setup", "SKILL.md"));
  console.log(`[deploy] → ${dir}`);
}

const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// Icons: sync every icons/<name>.svg the manifest references (the top-level icon
// lives in the shared line-icon library; deploy-all also does it centrally).
try {
  const { syncExtIconsForEntry } = await import("@aiti-ai/ext-shared/sync-ext-icons");
  syncExtIconsForEntry(import.meta.url, { log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] icon sync skipped: " + (e && e.message ? e.message : String(e)));
}
deployCommit({ repo: extRepo, name: "aiti-ark-usage", paths: ["aiti-ark-usage"], log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] done. Takes effect via POST /api/extensions/reload");

// Shared-dependency reconcile (package.json dependencies → <webRoot>/node_modules) — best effort.
try {
  const { notifyReconcile } = await import("@aiti-ai/ext-shared/reconcile-deps");
  await notifyReconcile();
} catch (e) {
  console.log("[deploy] reconcile notify skipped (" + String((e && e.message) || e) + ")");
}

// Dual-instance hot reload — best effort, never fails the deploy.
try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] auto reload skipped (" + String((e && e.message) || e) + ") — POST /api/extensions/reload manually");
}

// dev-pack — best effort (source lands next to the deploy dir for live AI edits).
try {
  const { packDevPack } = await import("@aiti-ai/ext-shared/dev-pack");
  packDevPack({ extRoot: root, log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack skipped (" + String((e && e.message) || e) + ")");
}
