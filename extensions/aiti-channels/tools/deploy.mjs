#!/usr/bin/env node
/**
 * aiti-channels · 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/
 *
 * Sources live in extensions/aiti-channels/(authoritative source location);
 * 部署 = 整目录同步到两个扩展根 + git 提交部署状态。
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";
import { notifyReconcile } from "@aiti-ai/ext-shared/reconcile-deps";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("@aiti-ai/ext-shared/check-client");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-channels

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-channels-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-channels"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-channels"),
];

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  rmSync(extDir, { recursive: true, force: true });
  cpSync(root, extDir, { recursive: true, filter: (src) => !src.includes("/tools/") && !src.includes("node_modules") });
  console.log("[deploy] → " + extDir);
}

// 部署状态提交（生产根是 git 仓库；失败不影响部署）
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// Icons: sync every icons/<name>.svg the manifest or the client bundle references
// (this step used to be an empty placeholder here; deploy-all also does it centrally).
try {
  const { syncExtIconsForEntry } = await import("@aiti-ai/ext-shared/sync-ext-icons");
  syncExtIconsForEntry(import.meta.url, { log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] icon sync skipped: " + (e && e.message ? e.message : String(e)));
}

deployCommit({ repo: extRepo, name: "aiti-channels", paths: ["aiti-channels"], log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。reload: POST /api/extensions/reload");

// ── 共享依赖 reconcile 通知（依赖进 <webRoot>/node_modules；允许失败，永不 throw）──
await notifyReconcile();

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("@aiti-ai/ext-shared/dev-pack");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
