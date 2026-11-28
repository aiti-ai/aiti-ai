#!/usr/bin/env node
/**
 * aiti-word-superdoc · 部署到 ~/.pi/web{,-dev}/extensions/（aiti-sheet-univer 同款四步）。
 *
 * 1) 拷贝 index.ts + blob-save-route.ts（_shared 副本模式）+ icon.svg
 * 2) 构建 + 拷贝 client/aiti-word-superdoc-client.mjs
 * 3) 拷贝 vendor/superdoc/（SuperDoc 整棵 dist，AGPL 隔离）
 * 4) deploy commit（~/.pi/web/extensions 扩展仓库）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { syncDir } from "../../_shared/sync-dir.mjs";

const root = resolve(import.meta.dirname, "..");

// client TS 残留检查
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

// 0) 构建 client bundle（先同步清旧产物：hash 名会变，残留永不引用）
console.log("[deploy] 构建 client bundle…");
{
  const { rmSync } = await import("node:fs");
  const dir = resolve(root, "dist");
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (/^aiti-word-superdoc-/.test(f)) { try { unlinkSync(resolve(dir, f)); } catch { /* ignore */ } }
  }
  rmSync(resolve(dir, "assets"), { recursive: true, force: true }); // worker entry 产物同步清
}
execSync("npx vite build --config " + resolve(root, "vite.config.ts"), { cwd: root, stdio: "inherit" });

// Per-file size report: hosts with an upload cap (EdgeOne Makers free plan:
// 25MB per file) reject the whole deploy, so surface the largest chunk here
// instead of discovering it at upload time.
{
  const distDir = resolve(root, "dist");
  let largest = { size: 0, file: "" };
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.isFile() && statSync(p).size > largest.size) largest = { size: statSync(p).size, file: p };
    }
  };
  if (existsSync(distDir)) walk(distDir);
  const mb = largest.size / 1048576;
  console.log(`[deploy] largest client file: ${mb.toFixed(1)}MB (${largest.file.slice(distDir.length + 1)})`);
  if (mb > 24) console.log(`[deploy][warn] ${mb.toFixed(1)}MB exceeds the 25MB per-file cap of upload-only hosts (EdgeOne Makers) — split chunks in vite.config.ts`);
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-word-superdoc"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-word-superdoc"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const dest of targets) {
  mkdirSync(resolve(dest, "dist"), { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(dest, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(dest, "package.json"));
  copyFileSync(resolve(root, "icon.svg"), resolve(dest, "icon.svg"));
  // 共享 save-blob 工厂（副本模式：_shared 权威源 → 部署目录）
  copyFileSync(resolve(root, "..", "_shared", "blob-save-route.ts"), resolve(dest, "blob-save-route.ts"));
  // client dist: rsync-style sync with delete. Hash names change every build,
  // and the old copy-forever loop left every past generation behind (160MB of
  // deployed tree for one 26MB bundle). sync-dir keeps the previous generation
  // for 6h so pages already open can still resolve their lazy chunks.
  {
    const srcDir = resolve(root, "dist");
    const st = syncDir(srcDir, resolve(dest, "dist"), {
      del: true,
      exclude: (rel) => rel === ".dev-pack-staging" || rel.startsWith(".dev-pack-staging/"),
    });
    console.log(`[deploy] client → ${dest}（拷 ${st.copied} / 同 ${st.skipped} / 清 ${st.deleted}）`);
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

deployCommit({ repo: extRepo, name: "aiti-word-superdoc", paths: ["aiti-word-superdoc"] });
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
