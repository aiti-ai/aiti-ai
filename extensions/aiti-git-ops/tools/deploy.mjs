#!/usr/bin/env node
/**
 * aiti-git-ops · 部署到 ~/.pi/web{,-dev}/extensions/（零 client bundle，纯服务端）
 *
 * 生效：POST /api/extensions/reload（自动）。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

const root = resolve(import.meta.dirname, "..");
const files = ["package.json", "index.ts", "git-engine.ts"];

const targets = [
  resolve(homedir(), ".pi/web/extensions/aiti-git-ops"),
  resolve(homedir(), ".pi/web-dev/extensions/aiti-git-ops"),
];
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) copyFileSync(resolve(root, f), resolve(dir, f));
  console.log(`[deploy] → ${dir}`);
}

const extRepo = resolve(homedir(), ".pi", "web", "extensions");
deployCommit({ repo: extRepo, name: "aiti-git-ops", paths: ["aiti-git-ops"], log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] 完成。生效：POST /api/extensions/reload");

// ── 共享依赖 reconcile（package.json dependencies → <webRoot>/node_modules）——允许失败，下次安装自动对齐 ──
try {
  const { notifyReconcile } = await import("@aiti-ai/ext-shared/reconcile-deps");
  await notifyReconcile();
} catch (e) {
  console.log("[deploy] reconcile 通知未执行（" + String((e && e.message) || e) + "）");
}

// ── 双实例热重载——允许失败，不影响退出码 ──
try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack——允许失败 ──
try {
  const { packDevPack } = await import("@aiti-ai/ext-shared/dev-pack");
  packDevPack({ extRoot: root, log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
