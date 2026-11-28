#!/usr/bin/env node
/**
 * aiti-queue-keeper · 构建 + 部署到 ~/.pi/web{,-dev}/extensions/
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（client 加载后刷新页面即新）
 */
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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

const root = resolve(import.meta.dirname, "..");

// 0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-queue-keeper.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}
const bundle = resolve(root, "dist/aiti-queue-keeper.mjs");
if (!existsSync(bundle)) {
  console.error("[deploy] client bundle 不存在：", bundle);
  process.exit(1);
}

// 1) 拷贝 index.ts + bundle + icon 到两个扩展根
const targets = [
  resolve(homedir(), ".pi/web/extensions/aiti-queue-keeper"),
  resolve(homedir(), ".pi/web-dev/extensions/aiti-queue-keeper"),
];
for (const dir of targets) {
  mkdirSync(resolve(dir, "dist"), { recursive: true });
  cpSync(resolve(root, "index.ts"), resolve(dir, "index.ts"));
  cpSync(resolve(root, "package.json"), resolve(dir, "package.json"));
  cpSync(bundle, resolve(dir, "dist/aiti-queue-keeper.mjs"));
  if (existsSync(resolve(root, "icon.svg"))) cpSync(resolve(root, "icon.svg"), resolve(dir, "icon.svg"));
  console.log(`[deploy] → ${dir}`);
}

// 2) 部署状态提交（生产根是 git 仓库；失败不影响部署）
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

deployCommit({ repo: extRepo, name: "aiti-queue-keeper", paths: ["aiti-queue-keeper"], log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] 完成。生效：POST /api/extensions/reload");

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
