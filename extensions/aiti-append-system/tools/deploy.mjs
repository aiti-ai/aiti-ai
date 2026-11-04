#!/usr/bin/env node
/**
 * aiti-append-system · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * client 是手写 .mjs（无构建链）：直接拷贝源码四件套 + skills/。
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（server 侧）；client 刷新页面即新
 */
import { copyFileSync, cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-append-system
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-append-system"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-append-system"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "client/src/aiti-append-system-client.mjs"), resolve(clientDir, "aiti-append-system-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-append-system-client.mjs"));
  // skills/ 递归拷贝（ai-helper 聚合帮助点；漏了会扫不到）
  const skillSrc = resolve(root, "skills");
  if (existsSync(skillSrc)) {
    const skillDest = resolve(extDir, "skills");
    cpSync(skillSrc, skillDest, { recursive: true });
    console.log("[deploy] skills → " + skillDest);
  }
}
console.log("[deploy] 完成。生效：POST /api/extensions/reload（server 侧）；client 刷新页面即新");

// 提交部署状态到扩展 git 仓库（生产目录是 git 仓库）

// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["pen-line"], { log: (m2) => console.log(m2) });
deployCommit({ repo: extRepo, name: "aiti-append-system", paths: ["aiti-append-system"], log: (m) => console.log("[deploy] " + m) });

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
