#!/usr/bin/env node
/** aiti-msg-share · build + deploy to ~/.pi/web{,-dev}/extensions/. */
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

const root = resolve(import.meta.dirname, "..");
console.log("[deploy] build client…");
execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
const bundle = resolve(root, "dist/aiti-msg-share-client.mjs");
if (!existsSync(bundle)) { console.error("[deploy] bundle missing"); process.exit(1); }

for (const dir of [
  resolve(homedir(), ".pi/web/extensions/aiti-msg-share"),
  resolve(homedir(), ".pi/web-dev/extensions/aiti-msg-share"),
]) {
  mkdirSync(resolve(dir, "dist"), { recursive: true });
  cpSync(resolve(root, "index.ts"), resolve(dir, "index.ts"));
  cpSync(resolve(root, "package.json"), resolve(dir, "package.json"));
  cpSync(bundle, resolve(dir, "dist/aiti-msg-share-client.mjs"));
  cpSync(resolve(root, "lib"), resolve(dir, "lib"), { recursive: true });
  cpSync(resolve(root, "skills"), resolve(dir, "skills"), { recursive: true });
  cpSync(resolve(root, "icon.svg"), resolve(dir, "icon.svg"));
  mkdirSync(resolve(dir, "icons"), { recursive: true });
  cpSync(resolve(root, "icon.svg"), resolve(dir, "icons/share-2.svg"));
  console.log(`[deploy] → ${dir}`);
}
deployCommit({ repo: resolve(homedir(), ".pi/web/extensions"), name: "aiti-msg-share",
  paths: ["aiti-msg-share"], log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] done. Reload via POST /api/extensions/reload");
