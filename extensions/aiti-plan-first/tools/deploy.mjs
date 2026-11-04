#!/usr/bin/env node
/**
 * aiti-plan-first · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 步骤（照 aiti-git-trace 四步）：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-plan-first-client.mjs）
 *   1) 拷贝服务端源码 index.ts / plan-core.ts + icon.svg → 两个扩展目录
 *   2) 拷贝 client 产物 → 两个扩展目录 client/
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
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-plan-first
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-plan-first"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-plan-first"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("npm run build:client", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "plan-core.ts", "lib/ignore-semantics.ts", "icon.svg"]) {
    mkdirSync(resolve(extDir, f, ".."), { recursive: true }); // 子目录文件（lib/ 等）先建目录
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  try {
    copyFileSync(resolve(root, "dist/aiti-plan-first-client.mjs"), resolve(clientDir, "aiti-plan-first-client.mjs"));
    console.log("[deploy] client → " + resolve(clientDir, "aiti-plan-first-client.mjs"));
  } catch (e) { console.warn("[deploy] client 缺失"); }
}
console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新");

// 提交部署状态到扩展 git 仓库（生产目录是 git 仓库）


// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["clipboard-list"], { log: (m2) => console.log(m2) });
deployCommit({ repo: extRepo, name: "aiti-plan-first", paths: ["aiti-plan-first"], log: (m) => console.log("[deploy] " + m) });

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
