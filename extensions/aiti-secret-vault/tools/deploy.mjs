#!/usr/bin/env node
/**
 * aiti-secret-vault · deploy to ~/.pi/web{,-dev}/extensions/aiti-secret-vault
 *
 * Copies index.ts + package.json + client dist (zero-build mjs) + icons
 * (key-round from _shared/icons). Then commits the deploy snapshot and
 * reloads the running instances (best effort).
 */
import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

{
  const { checkClientDir } = await import("@aiti-ai/ext-shared/check-client");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-secret-vault"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-secret-vault"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

function copyDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const f of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, f.name);
    if (f.isDirectory()) copyDir(src, join(dstDir, f.name));
    else if ([".mjs", ".js", ".ts", ".md", ".json"].includes(extname(f.name))) copyFileSync(src, join(dstDir, f.name));
  }
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(extDir, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  copyDir(resolve(root, "client", "src"), resolve(extDir, "dist"));
  console.log("[deploy] source → " + extDir);
}

deployCommit({ repo: extRepo, name: "aiti-secret-vault", paths: ["aiti-secret-vault"], log: (m) => console.log("[deploy] " + m) });

try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] auto reload skipped (" + String((e && e.message) || e) + ") — POST /api/extensions/reload manually");
}
console.log("[deploy] aiti-secret-vault done. Shared dep @aiti-ai/secret-vault-core must resolve from the web root node_modules (aiti-extman reconciles it).");
