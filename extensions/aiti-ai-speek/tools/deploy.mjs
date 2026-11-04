#!/usr/bin/env node
/**
 * aiti-ai-speek · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-ai-speek-client.mjs）
 *   1) 拷贝服务端源码 index.ts + icon.svg → 两个扩展目录
 *   2) 拷贝 client 产物 → 两个扩展目录 client/
 *   3) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新
 */
import { copyFileSync, mkdirSync, cpSync, readdirSync, existsSync, unlinkSync } from "node:fs";
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-ai-speek
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-ai-speek"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-ai-speek"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建
console.log("[deploy] 构建 JSX client bundle…");
try {
  // 清理源目录旧构建产物（vite emptyOutDir:false 不自清）
  try {
    for (const f of readdirSync(resolve(root, "dist"))) {
      if (f.endsWith(".js")) unlinkSync(resolve(root, "dist", f));
    }
  } catch { /* noop */ }
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  // server/ 辅助模块（speech-filter + tts-cache 等）
  const srvDir = resolve(extDir, "server");
  mkdirSync(srvDir, { recursive: true });
  for (const srvFile of ["speech-filter.ts", "tts-cache.ts"]) {
    try {
      copyFileSync(resolve(root, "server/" + srvFile), resolve(srvDir, srvFile));
      console.log("[deploy] server → " + resolve(srvDir, srvFile));
    } catch (e) { console.warn("[deploy] 跳过 server/" + srvFile + "：", e.message); }
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  try {
    // [D2 拆包] 拷主 bundle + 全部 hash 分块（speaker/components 按需 chunk），清理陈旧分块
    const srcClient = resolve(root, "dist");
    const srcFiles = readdirSync(srcClient).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
    for (const f of srcFiles) copyFileSync(resolve(srcClient, f), resolve(clientDir, f));
    for (const f of readdirSync(clientDir)) {
      if (f.endsWith(".js") && !srcFiles.includes(f)) { try { unlinkSync(resolve(clientDir, f)); } catch { /* noop */ } }
    }
    console.log("[deploy] client bundle + chunks（" + srcFiles.length + " 文件） → " + clientDir);
  } catch (e) { console.warn("[deploy] client 缺失：", e.message); }
  // AI 自管理 skills（skills/index.json + skills/<name>/SKILL.md，ai-helper 聚合读取）
  mkdirSync(resolve(extDir, "skills"), { recursive: true });
  cpSync(resolve(root, "skills"), resolve(extDir, "skills"), { recursive: true });
  console.log("[deploy] skills → " + resolve(extDir, "skills"));
}

console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新");

// 提交部署状态到扩展 git 仓库（生产目录是 git 仓库）

// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["volume-2"], { log: (m2) => console.log(m2) });
deployCommit({ repo: extRepo, name: "aiti-ai-speek", paths: ["aiti-ai-speek"], log: (m) => console.log("[deploy] " + m) });

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
