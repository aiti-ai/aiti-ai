#!/usr/bin/env node
/**
 * aiti-msg-smart · 部署到 ~/.pi/web/extensions/aiti-msg-smart/（pi-web 扩展目录）
 *
 * 步骤：
 *   1) 构建 client bundle（tools/build-client.mjs，esbuild）
 *   2) 拷贝服务端源码（index.ts）→ 扩展目录
 *   3) 拷贝 client bundle → 扩展目录 client/
 *   4) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload；client no-store 刷新页面即新
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-msg-smart
const DEST_DIRS = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-msg-smart"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-msg-smart"),
];

// 1) 构建 client
console.log("[deploy] 构建 client bundle…");
execSync("node " + resolve(root, "tools/build-client.mjs"), { cwd: root, stdio: "inherit" });

// 2) 服务端源码（manifest）
for (const extDir of DEST_DIRS) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-msg-smart-client.mjs"), resolve(clientDir, "aiti-msg-smart-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-msg-smart-client.mjs"));
}

// 3) 提交部署状态（无变更跳过——不再报「nothing to commit」假警报；失败不阻断）

deployCommit({
  repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-msg-smart", paths: ["aiti-msg-smart"],
  log: (m) => console.log("[deploy] " + m),
});

console.log("[deploy] 完成。生效：POST /api/extensions/reload（pi-web 服务端热重载）+ 刷新页面。");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
