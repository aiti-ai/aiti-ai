#!/usr/bin/env node
/**
 * aiti-app-center · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例扩展目录）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → dist/aiti-app-center-client.mjs）
 *   1) 拷贝 index.ts + package.json + 图标 + client 产物 → 两个扩展目录
 *   2) 提交部署状态 + 双实例热重载（失败不影响部署）
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-app-center
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-app-center"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-app-center"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(resolve(extDir, "dist"), { recursive: true });
  for (const f of ["package.json", "index.ts"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] " + f + " → " + resolve(extDir, f));
  }
  copyFileSync(resolve(root, "dist/aiti-app-center-client.mjs"), resolve(extDir, "dist/aiti-app-center-client.mjs"));
  console.log("[deploy] client → " + resolve(extDir, "dist/aiti-app-center-client.mjs"));
  // 条目统一线图库（清单须覆盖引用全集，缺文件 throw）
  copyIcons(resolve(extDir, "icons"), ["layout-grid"], { log: (m) => console.log("[deploy] " + m) });
}

// 提交部署状态（无变更跳过；失败不阻断）
deployCommit({
  repo: extRepo, name: "aiti-app-center", paths: ["aiti-app-center"],
  log: (m) => console.log("[deploy] " + m),
});

console.log("[deploy] 完成。生效：POST /api/extensions/reload + 刷新页面。");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（源码+构建工具直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: root, log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
