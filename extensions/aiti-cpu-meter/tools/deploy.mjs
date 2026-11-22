#!/usr/bin/env node
/**
 * aiti-cpu-meter · 部署到 ~/.pi/web/extensions/aiti-cpu-meter/ 与 ~/.pi/web-dev/extensions/aiti-cpu-meter/
 *
 * 步骤：
 *   0) 构建产物（node tools/build.mjs：core + 双壳 → dist/）
 *   1) 拷贝 index.ts + icon.svg → 两个扩展目录
 *   2) 拷贝内部版 client 产物 → 扩展目录 dist/
 *   3) 拷贝外部版 standalone 产物 → 扩展目录 assets/aiti-cpu-meter.js（供 api 静态服务 + 注入）
 *   4) 拷贝 skills/（ai-helper 帮助点：jank-debug 调试页面卡顿）→ 扩展目录 skills/（递归）
 *   5) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新；
 *       service-tunnels 注入注册需 reload 后生效。
 */
import { copyFileSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-cpu-meter
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-cpu-meter"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-cpu-meter"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 构建产物（esbuild；失败即中止）
console.log("[deploy] 构建产物…");
try {
  execFileSync(process.execPath, ["tools/build.mjs"], { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(extDir, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  copyFileSync(resolve(root, "icon.svg"), resolve(extDir, "icon.svg"));
  // markdown 描述（extman 详情页渲染；缺文件则详情页无描述块）
  try { copyFileSync(resolve(root, "DESC.md"), resolve(extDir, "DESC.md")); } catch {}
  console.log("[deploy] 源码 → " + resolve(extDir, "index.ts"));

  // 内部版 client（产物统一 dist/，宿主按 index.ts 声明 /assets/dist/… 服务）
  const distDir = resolve(extDir, "dist");
  mkdirSync(distDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-cpu-meter-client.mjs"), resolve(distDir, "aiti-cpu-meter-client.mjs"));
  console.log("[deploy] dist → " + resolve(distDir, "aiti-cpu-meter-client.mjs"));

  // 外部版 standalone（api 静态服务 + service-tunnels 注入用）
  const assetsDir = resolve(extDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-cpu-meter.js"), resolve(assetsDir, "aiti-cpu-meter.js"));
  copyFileSync(resolve(root, "assets/gate.html"), resolve(assetsDir, "gate.html")); // 「问 AI」认证入口页（同源 POST ask-ai）
  console.log("[deploy] assets → " + resolve(assetsDir, "aiti-cpu-meter.js") + " + gate.html");

  // skills（ai-helper 帮助点手册；必须整目录递归拷贝——漏了聚合不到）
  const skillsDir = resolve(extDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  cpSync(resolve(root, "skills"), skillsDir, { recursive: true });
  console.log("[deploy] skills → " + skillsDir);
}

deployCommit({ repo: extRepo, name: "aiti-cpu-meter", paths: ["aiti-cpu-meter"], ident: true, log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新；注入注册 reload 后生效");

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
