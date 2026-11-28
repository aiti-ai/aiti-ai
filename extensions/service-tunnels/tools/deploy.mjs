#!/usr/bin/env node
/**
 * service-tunnels · 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/
 *
 * 标准流程：客户端 bundle 构建 → 拷贝源码到扩展根 → 目标目录内
 * `npm install --omit=dev` 安装运行时依赖（service-tunnels，私有源
 * npm.example.com）——扩展带自己的 node_modules，不依赖宿主。
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("@aiti-ai/ext-shared/check-client");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/service-tunnels

// 1) 客户端 bundle 构建（client/src/*.tsx → client/service-tunnels.mjs）
console.log("[deploy] 构建客户端 bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "service-tunnels"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "service-tunnels"),
];

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  rmSync(extDir, { recursive: true, force: true });
  // 排除：tools/（构建/部署工具）+ *.test.mjs（开发测试，不进部署包）+ 本地
  // node_modules（含 esbuild 等 dev 依赖；目标目录由 npm install --omit=dev 生成）。
  cpSync(root, extDir, {
    recursive: true,
    filter: (src) =>
      !src.includes("/tools/")
      && !src.endsWith(".test.mjs")
      && src !== resolve(root, "node_modules")
      && !src.startsWith(resolve(root, "node_modules") + "/"),
  });
  // 标准依赖安装（--omit=dev：只装 service-tunnels，esbuild 不进运行时）
  console.log(`[deploy] npm install（${extDir}）…`);
  execSync("npm install --omit=dev --no-audit --no-fund", { cwd: extDir, stdio: "inherit" });
  console.log("[deploy] → " + extDir);
}

// 3) 部署状态提交（生产根是 git 仓库；失败不影响部署）
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// Icons: sync every icons/<name>.svg the manifest or the client bundle references
// (this step used to be an empty placeholder here; deploy-all also does it centrally).
try {
  const { syncExtIconsForEntry } = await import("@aiti-ai/ext-shared/sync-ext-icons");
  syncExtIconsForEntry(import.meta.url, { log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] icon sync skipped: " + (e && e.message ? e.message : String(e)));
}

deployCommit({ repo: extRepo, name: "service-tunnels", paths: ["service-tunnels"], log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。reload: POST /api/extensions/reload");

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
