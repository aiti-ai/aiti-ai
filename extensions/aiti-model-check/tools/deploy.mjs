#!/usr/bin/env node
/**
 * aiti-model-check · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-model-check-client.mjs）
 *   1) 拷贝服务端源码 index.ts + core.cjs → 两个扩展目录
 *   2) 拷贝 client 产物 → 两个扩展目录 client/
 *   3) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { copyFileSync, cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-model-check
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-model-check"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-model-check"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-model-check-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg", "core.cjs"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  // 工作区共享模块（生效模型清单解析）：与 core.cjs 同目录分发
  copyFileSync(resolve(root, "vendor/effective-models.cjs"), resolve(extDir, "effective-models.cjs"));
  console.log("[deploy] shared/effective-models.cjs → " + resolve(extDir, "effective-models.cjs"));
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-model-check-client.mjs"), resolve(clientDir, "aiti-model-check-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-model-check-client.mjs"));
  // skills/ 递归拷贝（ai-helper 聚合帮助点；漏了会扫不到）
  const skillSrc = resolve(root, "skills");
  if (existsSync(skillSrc)) {
    const skillDest = resolve(extDir, "skills");
    cpSync(skillSrc, skillDest, { recursive: true });
    console.log("[deploy] skills → " + skillDest);
  }
}
console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新");

// 提交部署状态到扩展 git 仓库（生产目录是 git 仓库）

// Icons: sync every icons/<name>.svg the manifest or the client bundle references
// (this step used to be an empty placeholder here; deploy-all also does it centrally).
try {
  const { syncExtIconsForEntry } = await import("@aiti-ai/ext-shared/sync-ext-icons");
  syncExtIconsForEntry(import.meta.url, { log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] icon sync skipped: " + (e && e.message ? e.message : String(e)));
}
deployCommit({ repo: extRepo, name: "aiti-model-check", paths: ["aiti-model-check"], log: (m) => console.log("[deploy] " + m) });

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
