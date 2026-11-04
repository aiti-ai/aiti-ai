#!/usr/bin/env node
/**
 * aiti-ctx-meter · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 纯 client 扩展（无 server 段）：package.json/index.ts + dist/ client bundle + icons/。
 *   0) 构建 client（cp client/src/aiti-ctx-meter-client.mjs → dist/）
 *   1) 拷 package.json（aitiExtProtocol 协议检测/reconcile 读）+ index.ts → 两个扩展目录
 *   2) 拷 client 产物 + icons/meter-vertical.svg（_shared/icons 库）
 *   3) deploy-commit + 双实例热重载（允许失败）
 *
 * 用法：node tools/deploy.mjs
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-ctx-meter
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-ctx-meter"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-ctx-meter"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

console.log("[deploy] 构建 client bundle…");
execSync("npm run build:client", { cwd: root, stdio: "inherit" });

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  const distDir = resolve(extDir, "dist");
  mkdirSync(distDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-ctx-meter-client.mjs"), resolve(distDir, "aiti-ctx-meter-client.mjs"));
  console.log("[deploy] client → " + resolve(distDir, "aiti-ctx-meter-client.mjs"));
}

// 图标（icon: "icons/meter-vertical.svg" → 宿主 loader 内嵌；库在 _shared/icons/，缺文件 throw）
for (const t of targets) copyIcons(resolve(t, "icons"), ["meter-vertical"], { log: (m) => console.log(m) });

deployCommit({ repo: extRepo, name: "aiti-ctx-meter", paths: ["aiti-ctx-meter"], log: (m) => console.log("[deploy] " + m) });

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（源码+工具直达部署目录）——允许失败 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: root, log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
