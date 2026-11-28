#!/usr/bin/env node
/**
 * aiti-float · 部署到 ~/.pi/web/extensions/aiti-float/ 与 ~/.pi/web-dev/extensions/aiti-float/
 *
 * 步骤：
 *   0) 构建 client bundle（client/src/*.ts → client/aiti-float-client.mjs）
 *   1) 拷贝 index.ts + icon.svg + client 产物 + skills/ → 两个扩展目录
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { copyFileSync, mkdirSync, cpSync } from "node:fs";
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-float
const DEST_DIRS = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-float"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-float"),
];

// 0) 客户端 bundle 构建（client/src/*.ts → client/aiti-float-client.mjs）
console.log("[deploy] 构建 client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of DEST_DIRS) {
  mkdirSync(resolve(extDir, "dist"), { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] " + f + " → " + resolve(extDir, f));
  }
  copyFileSync(resolve(root, "dist/aiti-float-client.mjs"), resolve(extDir, "dist/aiti-float-client.mjs"));
  console.log("[deploy] client → " + resolve(extDir, "dist/aiti-float-client.mjs"));
  // AI 自管理 skills（skills/index.json + skills/<name>/SKILL.md，ai-helper 聚合读取）
  mkdirSync(resolve(extDir, "skills"), { recursive: true });
  cpSync(resolve(root, "skills"), resolve(extDir, "skills"), { recursive: true });
  console.log("[deploy] skills → " + resolve(extDir, "skills"));
}

// 提交部署状态（无变更跳过；失败不阻断）

deployCommit({
  repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-float", paths: ["aiti-float"],
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

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
