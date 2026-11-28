#!/usr/bin/env node
/**
 * aiti-agent-badge build + deploy.
 *
 * Usage: node tools/deploy.mjs [--dev|--prod]
 * Copies index.ts + package.json + dist bundle + icon into the selected web
 * roots (default: both), then reloads the dev/prod instances (best effort).
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, "..");
const prodOnly = process.argv.includes("--prod");
const devOnly = process.argv.includes("--dev");

console.log("[deploy] building client bundle...");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (error) {
  console.error("[deploy] build failed; aborting:", error.message);
  process.exit(1);
}

const bundle = resolve(root, "dist/aiti-agent-badge.mjs");
if (!existsSync(bundle)) {
  console.error("[deploy] client bundle missing:", bundle);
  process.exit(1);
}

const targets = [
  ...(prodOnly ? [] : [resolve(homedir(), ".pi/web-dev/extensions/aiti-agent-badge")]),
  ...(devOnly ? [] : [resolve(homedir(), ".pi/web/extensions/aiti-agent-badge")]),
];
for (const dir of targets) {
  mkdirSync(resolve(dir, "dist"), { recursive: true });
  cpSync(resolve(root, "index.ts"), resolve(dir, "index.ts"));
  cpSync(resolve(root, "package.json"), resolve(dir, "package.json"));
  cpSync(bundle, resolve(dir, "dist/aiti-agent-badge.mjs"));
  if (existsSync(resolve(root, "icon.svg"))) cpSync(resolve(root, "icon.svg"), resolve(dir, "icon.svg"));
  console.log(`[deploy] -> ${dir}`);
}

const extRepo = resolve(homedir(), ".pi", devOnly ? "web-dev" : "web", "extensions");
deployCommit({ repo: extRepo, name: "aiti-agent-badge", paths: ["aiti-agent-badge"], log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] done. Effective after POST /api/extensions/reload");

try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (error) {
  console.log("[deploy] automatic reload skipped (" + String((error && error.message) || error) + ") - POST /api/extensions/reload manually");
}

try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (error) {
  console.log("[deploy] dev-pack skipped (" + String((error && error.message) || error) + ")");
}
