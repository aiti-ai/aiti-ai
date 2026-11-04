#!/usr/bin/env node
/**
 * aiti-folder · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 * 构建 JSX client bundle → 拷贝 index.ts + package.json + icon.svg + client/ → 两个扩展目录，
 * 并在目标目录 npm install（扩展自带依赖，loader 从扩展目录解析 node_modules），热重载双实例。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, "..");

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-folder-client.mjs）
// 清理源目录陈旧 hash 分块（上次构建产物；emptyOutDir=false 不会自清）
try {
  const { readdirSync: rds, unlinkSync: us } = await import("node:fs");
  for (const f of rds(resolve(root, "dist"))) {
    if (/^[A-Za-z][\w-]*-[\w-]{8}\.js$/.test(f)) us(resolve(root, "dist", f));
  }
} catch { /* noop */ }
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-folder"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-folder"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["index.ts", "icon.svg", "package.json"]) {
    if (existsSync(resolve(root, f))) copyFileSync(resolve(root, f), resolve(extDir, f));
  }
  // server/ 模块（git-plan.ts 等）：index.ts import 的服务端文件一并部署
  if (existsSync(resolve(root, "server"))) {
    const serverDir = resolve(extDir, "server");
    mkdirSync(serverDir, { recursive: true });
    for (const f of readdirSync(resolve(root, "server"))) {
      if (f.endsWith(".ts") || f.endsWith(".mjs")) copyFileSync(resolve(root, "server", f), resolve(serverDir, f));
    }
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  // 拷贝主 bundle + 全部代码分块（懒加载 v2 D3：FolderBrowser 为独立 hash 分块）
  for (const f of readdirSync(resolve(root, "dist"))) {
    if (f.endsWith(".mjs") || f.endsWith(".js")) copyFileSync(resolve(root, "dist", f), resolve(clientDir, f));
  }
  // 清理目标目录陈旧 hash 分块（源目录已不含旧名——防历史分块累积）
  for (const f of readdirSync(clientDir)) {
    if (f.endsWith(".js") && !existsSync(resolve(root, "dist", f))) { try { unlinkSync(resolve(clientDir, f)); } catch { /* noop */ } }
  }
  // 扩展自带依赖（trash 等）：目标目录 npm install（离线优先；package.json 比 lock 新才重装）
  const lockFile = resolve(extDir, "node_modules", ".package-lock.json");
  const pkgFile = resolve(extDir, "package.json");
  const pkgNewer = existsSync(pkgFile) && (!existsSync(lockFile) || statSync(pkgFile).mtimeMs > statSync(lockFile).mtimeMs);
  if (pkgNewer) {
    try {
      execSync("npm install --omit=dev --no-audit --no-fund --prefer-offline", { cwd: extDir, stdio: "ignore" });
      console.log("[deploy] npm install → " + extDir);
    } catch (e) {
      console.warn("[deploy] npm install 失败（" + extDir + "）: " + String(e?.message || e));
    }
  }
  console.log("[deploy] 源码 → " + extDir);
}

// 双实例热重载：实现收敛到 _shared/reload-instances.mjs（env basePath 双变量按机器设值）——允许失败，不影响 deploy 退出码
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}
console.log("[deploy] 完成。client 刷新页面即新。");


deployCommit({ repo: extRepo, name: "aiti-folder", paths: ["aiti-folder"], log: (m) => console.log("[deploy] " + m) });

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
