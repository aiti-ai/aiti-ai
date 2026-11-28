#!/usr/bin/env node
/**
 * aiti-proc-tree · deploy to ~/.pi/web/extensions/ and ~/.pi/web-dev/extensions/.
 *
 * Steps: build the client bundle, copy server sources + package.json + icons,
 * copy the client bundle, then commit the deploy state (failure tolerated).
 * Runtime deps: none (zero-dependency extension; no npm install here).
 */
import { copyFileSync, cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-proc-tree"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-proc-tree"),
];

console.log("[deploy] building client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] build failed, aborting deploy:", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "core.ts", "icon.svg", "LICENSE"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] file → " + resolve(extDir, f));
  }
  // server sources keep the same relative layout (index.ts imports ./server/**)
  const serverSrc = resolve(root, "server");
  if (existsSync(serverSrc)) {
    cpSync(serverSrc, resolve(extDir, "server"), { recursive: true });
    console.log("[deploy] server → " + resolve(extDir, "server"));
  }
  const iconsSrc = resolve(root, "icons");
  if (existsSync(iconsSrc)) {
    cpSync(iconsSrc, resolve(extDir, "icons"), { recursive: true });
    console.log("[deploy] icons → " + resolve(extDir, "icons"));
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-proc-tree-client.mjs"), resolve(clientDir, "aiti-proc-tree-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-proc-tree-client.mjs"));
}

try {
  deployCommit({
    repo: resolve(homedir(), ".pi", "web", "extensions"),
    name: "aiti-proc-tree",
    paths: ["aiti-proc-tree"],
  });
} catch { /* deploy commit is best-effort */ }

// Dual-instance hot reload (basePath env per machine) — allowed to fail.
try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] auto reload skipped (" + String((e && e.message) || e) + ") — POST /api/extensions/reload manually");
}
console.log("[deploy] done. Client refreshes on page reload");
