#!/usr/bin/env node
/**
 * aiti-quickstart · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例扩展目录）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → dist/aiti-quickstart-client.mjs）
 *   1) 拷贝 index.ts + package.json + 图标 + client 产物 → 两个扩展目录
 *   2) 提交部署状态 + 双实例热重载（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-quickstart
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-quickstart"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-quickstart"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(resolve(extDir, "dist"), { recursive: true });
  for (const f of ["package.json", "index.ts"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] " + f + " → " + resolve(extDir, f));
  }
  copyFileSync(resolve(root, "dist/aiti-quickstart-client.mjs"), resolve(extDir, "dist/aiti-quickstart-client.mjs"));
  console.log("[deploy] client → " + resolve(extDir, "dist/aiti-quickstart-client.mjs"));
  // server/ 是运行时依赖（index.ts import "./server/api.ts"）——必须进正式清单；
  // 此前缺失时宿主靠 dev-pack 兜底拷源码才跑起来，容器内 dev-pack 静默失败即炸（2026-11-07）
  cpSync(resolve(root, "server"), resolve(extDir, "server"), { recursive: true });
  console.log("[deploy] server/ → " + resolve(extDir, "server"));
  // 条目统一线图库（清单须覆盖引用全集，缺文件 throw）
  copyIcons(resolve(extDir, "icons"), ["rocket"], { log: (m) => console.log("[deploy] " + m) });
}

// 提交部署状态（无变更跳过；失败不阻断）
deployCommit({
  repo: extRepo, name: "aiti-quickstart", paths: ["aiti-quickstart"],
  log: (m) => console.log("[deploy] " + m),
});

console.log("[deploy] 完成。生效：POST /api/extensions/reload + 刷新页面。");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（源码+构建工具直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: root, log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
