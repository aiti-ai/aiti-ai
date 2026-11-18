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
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";

{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
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
for (const t of targets) copyIcons(resolve(t, "icons"), ["key-round"], { log: (m) => console.log(m) });

deployCommit({ repo: extRepo, name: "aiti-secret-vault", paths: ["aiti-secret-vault"], log: (m) => console.log("[deploy] " + m) });

try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] auto reload skipped (" + String((e && e.message) || e) + ") — POST /api/extensions/reload manually");
}
console.log("[deploy] aiti-secret-vault done. Shared dep @aiti-ai/secret-vault-core must resolve from the web root node_modules (aiti-extman reconciles it).");
