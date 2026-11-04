#!/usr/bin/env node
/**
 * aiti-session-cards · 构建 + 部署到 ~/.pi/web{,-dev}/extensions/
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（client 加载后刷新页面即新）
 */
import { cpSync, mkdirSync, existsSync } from "node:fs";
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

// 0) 构建 JSX client bundle（client/src/*.tsx → dist/aiti-session-cards.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}
const bundle = resolve(root, "dist/aiti-session-cards.mjs");
if (!existsSync(bundle)) {
  console.error("[deploy] client bundle 不存在：", bundle);
  process.exit(1);
}

// 1) 拷贝 index.ts + bundle + icon 到两个扩展根
const targets = [
  resolve(homedir(), ".pi/web/extensions/aiti-session-cards"),
  resolve(homedir(), ".pi/web-dev/extensions/aiti-session-cards"),
];
for (const dir of targets) {
  mkdirSync(resolve(dir, "dist"), { recursive: true });
  cpSync(resolve(root, "index.ts"), resolve(dir, "index.ts"));
  cpSync(resolve(root, "package.json"), resolve(dir, "package.json"));
  cpSync(bundle, resolve(dir, "dist/aiti-session-cards.mjs"));
  {
    const { copyIcons } = await import("../../_shared/ext-icons-deploy.mjs");
    copyIcons(resolve(dir, "icons"), ["message-square"], { log: (m) => console.log("[deploy] " + m) });
  }
  console.log(`[deploy] → ${dir}`);
}

// 2) 部署状态提交（生产根是 git 仓库；失败不影响部署）
const extRepo = resolve(homedir(), ".pi", "web", "extensions");
deployCommit({ repo: extRepo, name: "aiti-session-cards", paths: ["aiti-session-cards"], log: (m) => console.log("[deploy] " + m) });

// 3) 双实例热重载（共享实现，允许失败）
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

console.log("[deploy] 完成。生效：刷新页面即新");
