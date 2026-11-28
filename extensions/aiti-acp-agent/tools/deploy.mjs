#!/usr/bin/env node
/**
 * aiti-acp-agent · 部署到 ~/.pi/web{,-dev}/extensions/（默认双写；--prod 仅 prod、--dev 仅 dev）
 *
 * 部署 = client bundle 构建（vite，client/src/*.tsx → client/acp-manager.mjs）
 *       → 整目录同步到扩展根（排除 tools/node_modules）。
 * 用法：node tools/deploy.mjs [--prod|--dev]
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { notifyReconcile } from "@aiti-ai/ext-shared/reconcile-deps";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("@aiti-ai/ext-shared/check-client");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-acp-agent
// 目标：默认双写 web + web-dev；--prod 仅 prod、--dev 仅 dev（向后兼容旧单边用法）
const prod = process.argv.includes("--prod");
const devOnly = process.argv.includes("--dev");

// 0) 客户端 bundle 构建
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

const targets = [
  ...(prod ? [] : [resolve(homedir(), ".pi", process.env.PI_WEB_DEV_DIR ? `web-${process.env.PI_WEB_DEV_DIR}` : "web-dev", "extensions", "aiti-acp-agent")]),
  ...(devOnly ? [] : [resolve(homedir(), ".pi", "web", "extensions", "aiti-acp-agent")]),
];

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  rmSync(extDir, { recursive: true, force: true });
  cpSync(root, extDir, { recursive: true, filter: (src) => !src.includes("/tools/") && !src.includes("node_modules") });
  console.log("[deploy] → " + extDir);
}

// 部署状态 commit（无变更跳过；失败不阻断）——crash-rescue #9：纯 mjs 扩展也可回滚

// Icons: sync every icons/<name>.svg the manifest or the client bundle references
// (this step used to be an empty placeholder here; deploy-all also does it centrally).
try {
  const { syncExtIconsForEntry } = await import("@aiti-ai/ext-shared/sync-ext-icons");
  syncExtIconsForEntry(import.meta.url, { log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] icon sync skipped: " + (e && e.message ? e.message : String(e)));
}
deployCommit({ repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-acp-agent", paths: ["aiti-acp-agent"], ident: true, log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。reload: POST /api/extensions/reload");

// ── 共享依赖 reconcile 通知（依赖进 <webRoot>/node_modules；允许失败，永不 throw）──
await notifyReconcile();

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
