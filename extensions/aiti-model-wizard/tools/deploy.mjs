#!/usr/bin/env node
/**
 * aiti-model-wizard · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-model-wizard-client.mjs）
 *   1) 拷贝服务端源码 index.ts + core.cjs + china-catalog.json → 两个扩展目录
 *   2) 拷贝 client → client/，catalog 快照 → catalog/
 *   3) 种子数据到运行时 cache（~/.pi/web/data/aiti-model-wizard/cache/catalog/，首次离线也能出目录）
 *   4) 提交部署状态到扩展 git 仓库（失败不影响部署）
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-model-wizard
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-model-wizard"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-model-wizard"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-model-wizard-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}


const files = ["index.ts", "icon.svg", "core.cjs", "china-catalog.json", "package.json"];
for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of files) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  // 工作区共享模块（生效模型清单解析）：与 core.cjs 同目录分发
  copyFileSync(resolve(root, "vendor/effective-models.cjs"), resolve(extDir, "effective-models.cjs"));
  console.log("[deploy] shared/effective-models.cjs → " + resolve(extDir, "effective-models.cjs"));
  // [D1 拆包] 拷主 bundle + 全部 hash 分块（wizard-app 按需 chunk），并清理目标陈旧分块
  {
    const srcClient = resolve(root, "dist");
    for (const extDir of targets) {
      const dir = resolve(extDir, "dist");
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(srcClient)) {
        if (f.endsWith(".mjs") || f.endsWith(".js")) copyFileSync(resolve(srcClient, f), resolve(dir, f));
      }
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".js") && !existsSync(resolve(srcClient, f))) { try { unlinkSync(resolve(dir, f)); } catch { /* noop */ } }
      }
    }
    console.log("[deploy] client bundle + chunks → " + targets.join(" / "));
  }
  for (const sub of ["dist/aiti-model-wizard-client.mjs"]) {
    const dir = resolve(extDir, "dist");
    mkdirSync(dir, { recursive: true });
    copyFileSync(resolve(root, sub), resolve(dir, "aiti-model-wizard-client.mjs"));
    console.log("[deploy] client → " + resolve(dir, "aiti-model-wizard-client.mjs"));
  }
  // skills（ai-helper 帮助点：index.json + 各 skill 目录）
  if (existsSync(resolve(root, "skills"))) {
    cpSync(resolve(root, "skills"), resolve(extDir, "skills"), { recursive: true });
    console.log("[deploy] skills → " + resolve(extDir, "skills"));
  }
  const catDir = resolve(extDir, "catalog");
  mkdirSync(catDir, { recursive: true });
  copyFileSync(resolve(root, "catalog/models.dev.json"), resolve(catDir, "models.dev.json"));
  console.log("[deploy] catalog 快照 → " + resolve(catDir, "models.dev.json"));
}

// 种子运行时 dataDir（首次离线也能出目录）
for (const webRoot of [resolve(homedir(), ".pi", "web"), resolve(homedir(), ".pi", "web-dev")]) {
  const dataCat = resolve(webRoot, "data", "aiti-model-wizard", "cache", "catalog"); // 数据分层：目录快照可再抓取 → cache
  const target = resolve(dataCat, "models.dev.json");
  if (!existsSync(target)) {
    mkdirSync(dataCat, { recursive: true });
    copyFileSync(resolve(root, "catalog/models.dev.json"), target);
    console.log("[deploy] 种子 dataDir → " + target);
  }
}
console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新");



// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["sparkles"], { log: (m2) => console.log(m2) });
deployCommit({ repo: extRepo, name: "aiti-model-wizard", paths: ["aiti-model-wizard"], log: (m) => console.log("[deploy] " + m) });

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
