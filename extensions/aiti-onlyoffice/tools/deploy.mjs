#!/usr/bin/env node
/**
 * aiti-onlyoffice · 部署到 ~/.pi/web{,-dev}/extensions/（aiti-sheet-univer 同款四步）。
 *
 * 1) 拷贝 index.ts + blob-save-route.ts（_shared 副本模式）+ icon.svg
 * 2) 构建 + 拷贝 client/aiti-onlyoffice-client.mjs
 * 3) deploy commit（~/.pi/web/extensions 扩展仓库）
 * （无 vendor：DS api.js 运行时从 DocumentServer 加载）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";

const root = resolve(import.meta.dirname, "..");

// client TS 残留检查
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

// 0) 构建 client bundle（先同步清旧 chunk：hash 名会变，残留永不引用）
console.log("[deploy] 构建 client bundle…");
{
  const dir = resolve(root, "dist");
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (/^aiti-onlyoffice-(chunk|client)/.test(f)) { try { unlinkSync(resolve(dir, f)); } catch { /* 忽略 */ } }
  }
}
execSync("npx vite build --config " + resolve(root, "vite.config.ts"), { cwd: root, stdio: "inherit" });

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-onlyoffice"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-onlyoffice"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const dest of targets) {
  mkdirSync(resolve(dest, "dist"), { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(dest, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(dest, "package.json"));
  copyFileSync(resolve(root, "icon.svg"), resolve(dest, "icon.svg"));
  // 共享 save-blob 白名单（resolveAllowedWriteRoot；副本模式：_shared 权威源 → 部署目录）
  copyFileSync(resolve(root, "..", "_shared", "blob-save-route.ts"), resolve(dest, "blob-save-route.ts"));
  // token 模块（HMAC 签发/校验，源在 client/src/ 供 node --test 直测；index.ts 经 ./token 引用）
  copyFileSync(resolve(root, "client", "src", "token.ts"), resolve(dest, "token.ts"));
  // client 目录全量拷贝（entry 产物；跳过 src 源码目录）
  {
    const srcDir = resolve(root, "dist");
    mkdirSync(resolve(dest, "dist"), { recursive: true });
    let _n = 0;
    for (const f of readdirSync(srcDir)) {
      const fp = resolve(srcDir, f);
      try { if (statSync(fp).isFile()) { copyFileSync(fp, resolve(dest, "dist", f)); _n++; } } catch (e) { console.log("[deploy][warn] " + f + ": " + e.message); }
    }
    console.log("[deploy] client " + _n + " 个文件 → " + dest);
  }
  // scripts（onlyoffice-up/down.sh）随扩展分发
  {
    const { cpSync, chmodSync } = await import("node:fs");
    try {
      cpSync(resolve(root, "scripts"), resolve(dest, "scripts"), { recursive: true });
      for (const f of readdirSync(resolve(dest, "scripts"))) chmodSync(resolve(dest, "scripts", f), 0o755);
    } catch (e) { console.log("[deploy][warn] scripts: " + e.message); }
  }
  console.log("[deploy] 源码 → " + dest);
}

// reload 双实例（dev 实例 basePath=/dev；prod 无前缀）
for (const [name, url] of [["dev", "http://127.0.0.1:3001/dev/api/extensions/reload"], ["prod", "http://127.0.0.1:3002/api/extensions/reload"]]) {
  try {
    const r = await fetch(url, { method: "POST" });
    console.log("[deploy] reload " + name + " → HTTP " + r.status + (r.ok ? " ✓" : " ⚠"));
  } catch {
    console.log("[deploy] reload " + name + " 不可达（跳过）");
  }
}

deployCommit({ repo: extRepo, name: "aiti-onlyoffice", paths: ["aiti-onlyoffice"] });
console.log("[deploy] 完成。client 刷新页面即新");

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
