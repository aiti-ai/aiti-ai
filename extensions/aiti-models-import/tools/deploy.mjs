#!/usr/bin/env node
/**
 * aiti-models-import · 部署到 ~/.pi/web{,-dev}/extensions/aiti-models-import/
 *
 * 步骤：client 残留检查 → 构建 JSX bundle → 拷服务端（index.ts/core.cjs/sources/）+ dist
 *   → copyIcons → notifyReconcile（smol-toml 装进共享根）→ deploy commit → 双实例热重载 → dev-pack
 * 允许失败项（reconcile/reload/commit/dev-pack）不影响退出码。
 */
import { copyFileSync, mkdirSync, readdirSync, cpSync } from "node:fs";
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-models-import
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-models-import"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-models-import"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 构建 JSX client bundle
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

// 1) 服务端源码 + 产物
const files = ["index.ts", "icon.svg", "core.cjs", "package.json"];
for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of files) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  cpSync(resolve(root, "sources"), resolve(extDir, "sources"), { recursive: true });
  console.log("[deploy] sources/ → " + resolve(extDir, "sources"));
  const dir = resolve(extDir, "dist");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(resolve(root, "dist"))) {
    if (f.endsWith(".mjs") || f.endsWith(".js")) copyFileSync(resolve(root, "dist", f), resolve(dir, f));
  }
  console.log("[deploy] client bundle → " + dir);
}

// 2) 图标（icon: "icons/import.svg" → 宿主内嵌；清单须覆盖引用全集，缺文件 throw）
for (const t of targets) copyIcons(resolve(t, "icons"), ["import"], { log: (m) => console.log(m) });

// 3) 共享依赖 reconcile（smol-toml → <webRoot>/node_modules；extman 未就绪时下次安装自动对齐）
try {
  const { notifyReconcile } = await import("../../_shared/reconcile-deps.mjs");
  await notifyReconcile();
} catch (e) {
  console.log("[deploy] reconcile 通知未执行（" + String((e && e.message) || e) + "）");
}

deployCommit({ repo: extRepo, name: "aiti-models-import", paths: ["aiti-models-import"], log: (m) => console.log("[deploy] " + m) });

// 4) 双实例热重载（允许失败，不影响退出码）
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// 5) dev-pack（允许失败）
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
