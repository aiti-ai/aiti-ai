#!/usr/bin/env node
/**
 * aiti-debug-inject · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 步骤：
 *   1) 拷贝服务端源码 index.ts + icon.svg → 两个扩展目录
 *   2) 拷贝 client bundle → 两个扩展目录 client/
 *   3) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-debug-inject
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-debug-inject"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-debug-inject"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(extDir, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  copyFileSync(resolve(root, "icon.svg"), resolve(extDir, "icon.svg"));
  console.log("[deploy] 源码 → " + resolve(extDir, "index.ts"));

  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "client/src/aiti-debug-inject-client.mjs"), resolve(clientDir, "aiti-debug-inject-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-debug-inject-client.mjs"));
}


deployCommit({ repo: extRepo, name: "aiti-debug-inject", paths: ["aiti-debug-inject"], ident: true, log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新");

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
