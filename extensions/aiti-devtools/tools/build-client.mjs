#!/usr/bin/env node
/**
 * aiti-devtools · build:client — npm 包形态产物（build-bundled-package.mjs 调用；也可手动跑）
 *
 * 产出（布局与 tools/deploy.mjs 部署产物同源一致）：
 *   dist/aiti-client.mjs        ← client/src/aiti-client.mjs（扩展 client 入口，index.ts `client:` 声明）
 *   assets/aiti-launcher.js     ← packages/aiti-devtools-inject 现场构建（esbuild）
 *   assets/bridge-client.js     ← inject 构建产物（build.mjs 同轮拷出）
 *   assets/cdp-core.js          ← inject 构建产物（同上）
 *   assets/host-protocol.js     ← packages/aiti-devtools-core/src 直拷
 *   assets/pair-client.js       ← core/src 直拷（源缺失时跳过并告警，见下）
 *   assets/pair.html            ← core/src 直拷（同上）
 *   pair.ts                     ← core/src 直拷（服务端模块，存在才拷）
 *
 * 与 deploy.mjs 的差异：不写部署目录、不 deploy commit / reload / reconcile，只在本扩展目录产出。
 *
 * esbuild 解析：本扩展 devDependencies 提供 esbuild；inject 包的 tools/build.mjs 从自身位置
 * createRequire("esbuild")——那里没有 node_modules，这里把扩展的 esbuild / @esbuild 临时
 * symlink（Windows 回退拷贝）到 inject 包下，结束即清理。
 *
 * 已知缺口：npm 发布的 @aiti-ai/aiti-devtools-core（0.3.9）src 不含 pair-client.js / pair.html
 * （公开仓 packages 镜像同样缺失）→ npm 包形态 pair 手机页资产缺失、功能降级；补齐路径 =
 * core npm 包带上 pair 三件，或公开仓 core/src 镜像补齐后此处自动恢复拷贝。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, cpSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const warn = (m) => console.log("[build-client] ⚠ " + m);

// 仓库根：向上找含 packages/aiti-devtools-inject 的祖先（pi-work 三层 / 发布仓两层布局都兼容）
let repoRoot = dirname(extRoot);
while (repoRoot !== dirname(repoRoot) && !existsSync(resolve(repoRoot, "packages", "aiti-devtools-inject", "tools", "build.mjs"))) {
  repoRoot = dirname(repoRoot);
}
const injectRoot = resolve(repoRoot, "packages", "aiti-devtools-inject");
const coreSrc = resolve(repoRoot, "packages", "aiti-devtools-core", "src");
if (!existsSync(resolve(injectRoot, "tools", "build.mjs"))) {
  throw new Error("[build-client] 找不到 packages/aiti-devtools-inject——build:client 需要完整仓库树");
}

// 1) esbuild 暴露给 inject 包（临时，finally 清理）
const _req = createRequire(import.meta.url);
const extNm = resolve(extRoot, "node_modules");
let esbuildPkg;
try {
  esbuildPkg = dirname(_req.resolve("esbuild/package.json", { paths: [extNm, extRoot] }));
} catch {
  throw new Error("[build-client] esbuild 未找到——请先 npm install（devDependencies.esbuild）");
}
const injectNm = resolve(injectRoot, "node_modules");
const links = [];
mkdirSync(injectNm, { recursive: true });
const linkInto = (from, name) => {
  const to = resolve(injectNm, name);
  if (!existsSync(from)) return;
  rmSync(to, { force: true, recursive: true });
  try {
    symlinkSync(from, to, "dir");
  } catch {
    // Windows 无特权软链回退：只拷 esbuild 主包 + 当前平台二进制
    cpSync(from, to, { recursive: true });
  }
  links.push(to);
};
linkInto(esbuildPkg, "esbuild");
linkInto(resolve(extNm, "@esbuild"), "@esbuild");

try {
  // 2) 现场构建注入产物（aiti-launcher.js + bridge-client.js + cdp-core.js → inject/dist）
  const r = spawnSync("node", [resolve(injectRoot, "tools", "build.mjs")], { cwd: injectRoot, stdio: "inherit" });
  if (r.status !== 0) throw new Error("[build-client] inject 构建失败 (exit " + r.status + ")");

  // 3) client 入口 + assets 拷贝
  const distDir = resolve(extRoot, "dist");
  const assetsDir = resolve(extRoot, "assets");
  mkdirSync(distDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  copyFileSync(resolve(extRoot, "client", "src", "aiti-client.mjs"), resolve(distDir, "aiti-client.mjs"));

  const injectDist = resolve(injectRoot, "dist");
  for (const f of ["aiti-launcher.js", "bridge-client.js", "cdp-core.js"]) {
    copyFileSync(resolve(injectDist, f), resolve(assetsDir, f));
  }
  copyFileSync(resolve(coreSrc, "host-protocol.js"), resolve(assetsDir, "host-protocol.js"));
  // pair 三件：源缺失时降级跳过（见文件头「已知缺口」），不阻断 client 产物
  for (const [src, dst] of [
    [resolve(coreSrc, "pair-client.js"), resolve(assetsDir, "pair-client.js")],
    [resolve(coreSrc, "pair.html"), resolve(assetsDir, "pair.html")],
    [resolve(coreSrc, "pair.ts"), resolve(extRoot, "pair.ts")],
  ]) {
    if (existsSync(src)) copyFileSync(src, dst);
    else warn("core/src 缺 " + src.slice(coreSrc.length + 1) + "（npm 包形态 pair 功能降级）——跳过");
  }
  console.log("[build-client] ✓ dist/aiti-client.mjs + assets/（launcher/bridge-client/cdp-core/host-protocol）");
} finally {
  for (const l of links) rmSync(l, { force: true, recursive: true });
  try { rmdirSync(injectNm); } catch {} // 清掉仅为本脚本而建的空目录壳（非空说明有其他内容，不动）
}
