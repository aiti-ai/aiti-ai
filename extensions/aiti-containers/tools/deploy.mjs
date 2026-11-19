#!/usr/bin/env node
/**
 * Deploy aiti-containers to both pi-web extension roots (dev + prod directories;
 * only the dev instance is reloaded for this extension's first rollout).
 *
 * Steps: build client -> copy source/server/skills -> deploy commit -> reload.
 *
 * Usage: node tools/deploy.mjs [--no-reload]
 */
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const name = "aiti-containers";
// First rollout is dev-only (prod deployment requires explicit user approval).
const targets = [resolve(homedir(), ".pi", "web-dev", "extensions", name)];
const extRepo = resolve(homedir(), ".pi", "web-dev", "extensions");

console.log("[deploy] build client…");
try {
  execFileSync(process.execPath, [resolve(root, "tools/build.mjs")], { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] build failed:", e && e.message ? e.message : e);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["index.ts", "package.json", "icon.svg", "DESC.md", "README.md", "AGENTS.md"]) {
    try {
      copyFileSync(resolve(root, f), resolve(extDir, f));
    } catch {
      /* optional file */
    }
  }
  // server modules are part of the runtime entry (imported by index.ts)
  cpSync(resolve(root, "server"), resolve(extDir, "server"), { recursive: true });
  cpSync(resolve(root, "skills"), resolve(extDir, "skills"), { recursive: true });
  mkdirSync(resolve(extDir, "dist"), { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-containers-client.mjs"), resolve(extDir, "dist/aiti-containers-client.mjs"));
  console.log("[deploy] ->", extDir);
}

try {
  const { deployCommit } = await import("../../_shared/deploy-commit.mjs");
  deployCommit({ repo: extRepo, name, paths: [name], ident: true, log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] deploy commit skipped:", String((e && e.message) || e));
}

if (!process.argv.includes("--no-reload")) {
  // Reload the dev instance only (never prod from this script).
  const port = process.env.AITI_DEV_PORT || "30142";
  const bp = String(process.env.AITI_DEV_BASE_PATH || "dev").replace(/^\/+|\/+$/g, "");
  const url = `http://127.0.0.1:${port}/${bp ? bp + "/" : ""}api/extensions/reload`;
  try {
    const r = await fetch(url, { method: "POST" });
    console.log("[deploy] reload dev → HTTP " + r.status + (r.ok ? " ✓" : " ⚠"));
  } catch (e) {
    const msg = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
    console.log("[deploy] reload dev 不可达（" + msg + "）— 手动 POST " + url);
  }
}

console.log("[deploy] done.");
