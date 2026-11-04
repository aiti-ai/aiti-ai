#!/usr/bin/env node
/**
 * aiti-opencode-agent · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 纯服务端扩展（无 client bundle）：index.ts + package.json。
 * 用法：node tools/deploy.mjs
// ── 共享依赖 reconcile 通知（依赖进 <webRoot>/node_modules；允许失败，永不 throw）──
await notifyReconcile();

 * 生效：POST /api/extensions/reload（deploy 末尾自动双实例热重载）
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-opencode-agent
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-opencode-agent"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-opencode-agent"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["index.ts", "package.json"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
  }
  console.log("[deploy] 源码 → " + resolve(extDir, "index.ts"));
}

deployCommit({ repo: extRepo, name: "aiti-opencode-agent", paths: ["aiti-opencode-agent"], ident: true, log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（源码+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
