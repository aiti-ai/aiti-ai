#!/usr/bin/env node
/**
 * aiti-sysmon · deploy to ~/.pi/web/extensions/ and ~/.pi/web-dev/extensions/ (pi-web dual instances)
 *
 * Steps:
 *   0) build the JSX client bundle (client/src/*.tsx → dist/aiti-sysmon-client.mjs)
 *   1) copy server source (index.ts + core.cjs + package.json) + icon.svg + icons/ into both ext dirs
 *   2) copy the client bundle into dist/
 *   3) commit deploy state in the extensions git repo (failure tolerated)
 *
 * Server runtime deps (systeminformation) are declared in package.json and installed
 * into the shared <webRoot>/node_modules by aiti-extman reconcile — this script never
 * runs npm install nor copies node_modules by design.
 *
 * Usage: node tools/deploy.mjs
 * Activate: POST /api/extensions/reload (or restart pi-web); client refreshes on page reload.
 */
import { copyFileSync, cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-sysmon"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-sysmon"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) client bundle
console.log("[deploy] building JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] build failed, aborting deploy:", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  // package.json must ship: protocol gate + extman reconcile reads dependencies from it
  for (const f of ["package.json", "index.ts", "core.cjs", "icon.svg"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] file → " + resolve(extDir, f));
  }
  // extension-local line icons (dock header icon: icons/gauge.svg)
  const iconsSrc = resolve(root, "icons");
  if (existsSync(iconsSrc)) {
    const iconsDest = resolve(extDir, "icons");
    mkdirSync(iconsDest, { recursive: true });
    cpSync(iconsSrc, iconsDest, { recursive: true });
    console.log("[deploy] icons → " + iconsDest);
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-sysmon-client.mjs"), resolve(clientDir, "aiti-sysmon-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-sysmon-client.mjs"));
}
console.log("[deploy] done. Activate: POST /api/extensions/reload (or restart pi-web); client refreshes on page reload");

// Deploy-state commit in the production extensions git repo (failure tolerated)
deployCommit({ repo: extRepo, name: "aiti-sysmon", paths: ["aiti-sysmon"], log: (m) => console.log("[deploy] " + m) });

// Shared-deps reconcile notice: extman installs declared runtime deps
// (systeminformation) into each instance's shared <webRoot>/node_modules.
try {
  const { notifyReconcile } = await import("@aiti-ai/ext-shared/reconcile-deps");
  await notifyReconcile();
} catch (e) {
  console.log("[deploy] reconcile notice skipped (" + String((e && e.message) || e) + ")");
}

// ── dual-instance hot reload (basePath env per machine) — allowed to fail ──
try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] auto reload skipped (" + String((e && e.message) || e) + ") — POST /api/extensions/reload manually");
}
