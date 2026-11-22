#!/usr/bin/env node
/**
 * aiti-helper · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例；照 ai-input deploy）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-helper-client.mjs）
 *   1) 拷贝服务端源码 index.ts → 两个扩展目录
 *   2) 拷贝 client bundle → 两个扩展目录 client/
 *   3) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { copyFileSync, mkdirSync, existsSync, cpSync, readdirSync, unlinkSync } from "node:fs";
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-helper

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-helper-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-helper"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-helper"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  // 服务端源码：index.ts（入口）+ result-store.ts（结果状态机，index 相对 import；jiti 原地解析同目录）
  for (const f of ["index.ts", "result-store.ts"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  // 根 icon.svg 已退役：扩展 manifest icon 与所有 AI 星星统一用 icons/sparkles.svg（下方 copyIcons）
  console.log("[deploy] 源码 → " + resolve(extDir, "index.ts"));

  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  // [懒加载 v2 拆包] 拷贝全部 client 产物：薄 entry aiti-helper-client.mjs + 重 UI chunk（name-HASH.js）。
  // hash 文件名每次构建会变——拷贝后同步清理部署目录里源目录已不存在的陈旧 chunk（照 folder 先例）。
  for (const f of readdirSync(resolve(root, "dist"))) {
    if (f.endsWith(".mjs") || f.endsWith(".js")) copyFileSync(resolve(root, "dist", f), resolve(clientDir, f));
  }
  for (const f of readdirSync(clientDir)) {
    if (f.endsWith(".js") && !existsSync(resolve(root, "dist", f))) { try { unlinkSync(resolve(clientDir, f)); } catch { /* noop */ } }
  }
  console.log("[deploy] client（含重 UI chunk）→ " + clientDir);
  // skills/ 帮助点目录（pi skills 标准）
  const skillSrc = resolve(root, "skills");
  if (existsSync(skillSrc)) {
    const skillDest = resolve(extDir, "skills");
    mkdirSync(skillDest, { recursive: true });
    cpSync(skillSrc, skillDest, { recursive: true });
    console.log("[deploy] skills → " + skillDest);
  }
}



// 图标：单源 _shared/icons/sparkles.svg → 部署目录 icons/sparkles.svg。
// manifest icon（index.ts）与 client 内所有 AI 星星（SparkIcon / 弹窗注入 🤖）都指向它——
// 2026-09-09 修「两种 AI 图标」；2026-09-10 消灭手抆 path 漂移（ICONS.sparkles 漏 2 条 path 缺左下小星），
// 根 icon.svg 退役，全扩展只存这一个 svg 文件。
for (const t of targets) copyIcons(resolve(t, "icons"), ["sparkles"], { log: (m2) => console.log(m2) });
deployCommit({ repo: extRepo, name: "aiti-helper", paths: ["aiti-helper"], ident: true, log: (m) => console.log("[deploy] " + m) });

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
