#!/usr/bin/env node
/**
 * aiti-pair · 部署到 ~/.pi/web{,-dev}/extensions/（pi-web 双实例）——照 aiti-debug-inject 最小范式
 * 生效：deploy 末尾自动双实例 reload；client no-store 刷新页面即新
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-pair"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-pair"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(extDir, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  copyFileSync(resolve(root, "icon.svg"), resolve(extDir, "icon.svg"));
  const dist = resolve(extDir, "dist");
  mkdirSync(dist, { recursive: true });
  copyFileSync(resolve(root, "client/src/aiti-pair-client.mjs"), resolve(dist, "aiti-pair-client.mjs"));
  console.log("[deploy] → " + extDir);
}

deployCommit({ repo: extRepo, name: "aiti-pair", paths: ["aiti-pair"], ident: true, log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] 完成（软依赖 aiti-devtools 资产 pair-client.js；aiti-devtools 未部署时面板给引导）");

try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}
