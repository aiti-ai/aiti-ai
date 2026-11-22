#!/usr/bin/env node
/**
 * aiti-ai-schedule · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 拷贝：index.ts + icon.svg + sched/*.ts（内核）+ client/*.mjs（管理页，零构建）
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）
 */
import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-ai-schedule
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-ai-schedule"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-ai-schedule"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// client bundle 构建（每次 deploy 都构建——源码有变更即出新产物）
console.log("[deploy] 构建 client bundle…");
execSync("npx vite build --config " + resolve(root, "vite.config.ts"), { cwd: root, stdio: "inherit" });

const COPY_EXTS = [".mjs", ".js", ".ts", ".md", ".json"]; // client 产物 / sched 内核 / skills
function copyDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const f of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, f.name);
    if (f.isDirectory()) copyDir(src, join(dstDir, f.name));
    else if (COPY_EXTS.includes(extname(f.name))) copyFileSync(src, join(dstDir, f.name));
  }
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(extDir, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  copyFileSync(resolve(root, "icon.svg"), resolve(extDir, "icon.svg"));
  // 调度内核（sched/*.ts）
  copyDir(resolve(root, "sched"), resolve(extDir, "sched"));
  // 管理页 client bundle（vite 构建产物 .mjs；src 源码不部署）
  copyDir(resolve(root, "dist"), resolve(extDir, "dist"));
  // AI 技能（M3 机制：ai-helper 聚合）
  if (existsSync(resolve(root, "skills"))) copyDir(resolve(root, "skills"), resolve(extDir, "skills"));
  console.log("[deploy] 源码 → " + extDir);
}
console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）");

// 提交部署状态到扩展 git 仓库（生产目录是 git 仓库）

// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["clock"], { log: (m2) => console.log(m2) });

deployCommit({ repo: extRepo, name: "aiti-ai-schedule", paths: ["aiti-ai-schedule"], log: (m) => console.log("[deploy] " + m) });

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
