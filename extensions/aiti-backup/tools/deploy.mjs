#!/usr/bin/env node
/**
 * aiti-backup · 部署到 ~/.pi/web{,-dev}/extensions/aiti-backup/
 *
 * 纯服务端扩展（M1/M2 无 client/dist）：拷 index.ts + lib/ + bin/ + package.json + icon.svg
 *   → deploy commit → 双实例热重载。无运行时依赖（不触发 reconcile）、无 UI（不需要 icons/）。
 * 允许失败项（reload/commit）不影响退出码。
 */
import { copyFileSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-backup
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-backup"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-backup"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

const files = ["index.ts", "package.json", "icon.svg"];
const dirs = ["lib", "bin"];
for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of files) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  for (const d of dirs) {
    cpSync(resolve(root, d), resolve(extDir, d), { recursive: true });
    console.log("[deploy] " + d + "/ → " + resolve(extDir, d));
  }
}

deployCommit({ repo: extRepo, name: "aiti-backup", paths: ["aiti-backup"], log: (m) => console.log("[deploy] " + m) });

// 双实例热重载（允许失败，不影响退出码）
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}
