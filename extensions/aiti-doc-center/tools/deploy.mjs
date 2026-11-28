#!/usr/bin/env node
/**
 * aiti-doc-center · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 步骤（照 aiti-plan-first 四步）：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-doc-center-client.mjs，M2 起存在）
 *   1) copy server sources index.ts / doc-core.ts to both extension dirs (icon comes from the
 *      shared line-icon library via deploy-all's icon sync)
 *   2) 拷贝 client 产物 / skills（存在才拷）
 *   3) 提交部署状态到扩展 git 仓库（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const t = join(dst, name);
    if (statSync(s).isDirectory()) copyDir(s, t);
    else copyFileSync(s, t);
  }
}

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("@aiti-ai/ext-shared/check-client");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, "..");
const extRepo = resolve(homedir(), ".pi", "web", "extensions");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-doc-center"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-doc-center"),
];
const files = ["index.ts", "doc-core.ts", "lib/ignore-semantics.ts", "package.json"];
const optionalDirs = ["dist", "skills"];
// doc-worker 是手写运行时源（Worker 线程直载，无构建）——随产物进 dist/（index.ts 按 dist/ 引用）
{
  const { mkdirSync: _mk, copyFileSync: _cp } = await import("node:fs");
  _mk(resolve(root, "dist"), { recursive: true });
  _cp(resolve(root, "client", "src", "doc-worker.mjs"), resolve(root, "dist", "doc-worker.mjs"));
}

// 0) client 构建（M2 起才有 vite 配置）
if (existsSync(join(root, "vite.config.ts"))) {
  console.log("[deploy] 构建 JSX client bundle…");
  try {
    execSync("npm run build:client", { cwd: root, stdio: "inherit" });
  } catch {
    // 本机 npm prefix 配置异常（装不进本地 node_modules）→ 兜底用兄弟扩展的 vite
    const alt = resolve(root, "..", "aiti-ai-schedule", "node_modules", "vite", "bin", "vite.js");
    console.log("[deploy] npm vite 不可用，兜底：", alt);
    execFileSync(process.execPath, [alt, "build", "--config", "vite.config.ts"], { cwd: root, stdio: "inherit" });
  }
}

for (const t of targets) {
  mkdirSync(t, { recursive: true });
  for (const f of files) {
    if (!existsSync(join(root, f))) continue;
    mkdirSync(join(t, f, ".."), { recursive: true }); // 子目录文件（lib/ 等）先建目录
    copyFileSync(join(root, f), join(t, f));
  }
  for (const d of optionalDirs) {
    const src = join(root, d);
    if (!existsSync(src)) continue;
    copyDir(src, join(t, d));
  }
  console.log("[deploy] →", t);
}

try {

  deployCommit({ repo: extRepo, name: "aiti-doc-center", paths: ["aiti-doc-center"], log: (m) => console.log("[deploy] " + m) });
} catch { /* 部署本体优先 */ }
console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("@aiti-ai/ext-shared/dev-pack");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
