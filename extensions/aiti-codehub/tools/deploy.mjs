#!/usr/bin/env node
/**
 * Deploy aiti-codehub to the pi-web dev extension root and reload the dev instance.
 * Production deployment requires explicit operator consent (--prod) and is never automated.
 *
 * Usage: node tools/deploy.mjs [--no-reload] [--prod]
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const name = "aiti-codehub";
const PROD = process.argv.includes("--prod");
const targets = [
  { name: "dev", dir: resolve(homedir(), ".pi", "web-dev", "extensions", name) },
  ...(PROD ? [{ name: "prod", dir: resolve(homedir(), ".pi", "web", "extensions", name) }] : []),
];

console.log("[deploy] build client…");
execFileSync(process.execPath, [resolve(root, "tools/build-client.mjs")], { cwd: root, stdio: "inherit" });

function copyTree(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

for (const t of targets) {
  mkdirSync(t.dir, { recursive: true });
  for (const f of ["index.ts", "ui-i18n.ts", "package.json", "icon.svg", "README.md", "README.zh-CN.md", "DESC.md", "DESC.en.md", "AGENTS.md", "LICENSE"]) {
    try { copyFileSync(resolve(root, f), resolve(t.dir, f)); } catch { /* optional */ }
  }
  for (const d of ["server", "providers", "skills", "icons", "dist"]) copyTree(resolve(root, d), resolve(t.dir, d));
  // Client source is not needed at runtime, but the ext-shared reconcile reads package.json only.
  console.log(`[deploy] ${t.name} → ${t.dir}`);
}

if (!process.argv.includes("--no-reload")) {
  const port = process.env.AITI_DEV_PORT || "30142";
  const bp = String(process.env.AITI_DEV_BASE_PATH || "dev").replace(/^\/+|\/+$/g, "");
  const url = `http://127.0.0.1:${port}/${bp ? bp + "/" : ""}api/extensions/reload`;
  try {
    const r = await fetch(url, { method: "POST" });
    console.log("[deploy] reload dev → HTTP " + r.status + (r.ok ? " ✓" : " ⚠"));
  } catch (e) {
    const msg = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
    console.log("[deploy] reload dev unreachable (" + msg + ") — POST " + url);
  }
}
console.log("[deploy] done.");
