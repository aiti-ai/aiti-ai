#!/usr/bin/env node
/**
 * aiti-editor · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例）
 *
 * 步骤：
 *   1) 拷贝服务端 index.ts + icon.svg → 两个扩展目录
 *   2) 拷贝 client/aiti-editor-client.mjs → client/
 *   3) 从 node_modules/monaco-editor/min/vs 拷贝 Monaco assets → assets/monaco/vs
 *      （首次或 monaco 版本变化时全量；已有且版本一致则跳过整拷——assets 不进 git）
 *   4) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, closeSync, openSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-editor

// vendored 库版本一致性检查（防 vendor/marked.min.js 与 package.json 声明的 marked 漂移；FAIL 即中止部署）
{
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "check-vendor-version.mjs")], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) { console.error("[deploy] 中止：vendor 版本一致性检查失败"); process.exit(r.status ?? 1); }
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-editor"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-editor"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-editor-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}


// Monaco 资产：route 的 /assets/ 前缀会被剥掉（registry.assetPath(extId, relPath) = ext.dir + relPath），
// 所以按 URL「/assets/monaco/vs/…」对应实际目录 ext.dir/monaco/vs
const SRC_VS = resolve(root, "node_modules", "monaco-editor", "min", "vs");
function monacoFingerprint() {
  const f = resolve(SRC_VS, "editor", "editor.main.js");
  if (!existsSync(f)) return null;
  return createHash("md5").update(readFileSync(f)).digest("hex").slice(0, 8);
}
const stampFile = (extDir) => resolve(extDir, "monaco", ".version");

function syncMonaco(extDir) {
  const stamp = stampFile(extDir);
  const fp = monacoFingerprint();
  if (!fp) {
    // 缺依赖必须 fail：静默跳过会让陈旧资产+旧指纹长期滞留无人发现（曾踩坑）
    console.error("[deploy] 未找到 monaco-editor min/vs —— 先在本目录 npm i monaco-editor 再部署");
    process.exit(1);
  }
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === fp) {
    console.log("[deploy] monaco assets 已是最新（" + fp + "）→ 跳过");
    return;
  }
  const parent = resolve(extDir, "monaco");
  const out = resolve(parent, "vs");
  mkdirSync(parent, { recursive: true });
  // 原子替换（2026-09-25）：旧实现 rmSync(out)+cpSync（整目录删后逐文件拷）存在秒级
  // 404 空窗——同步期间页面任何 Monaco 模块请求落空，且 vscode AMD loader 对失败模块
  // 留永久失败记录（刷新前所有 require 立即命中缓存失败），用户侧表现为「Monaco 编辑器
  // 加载失败 [object Event] 且重试无效」。先拷临时目录，再两次 rename（毫秒级窗口）。
  // rename 失败（如 Windows 文件被占用）时回退旧的 rm+cp 路径。
  const tmp = resolve(parent, ".vs-tmp-" + process.pid);
  const old = resolve(parent, ".vs-old-" + process.pid);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  cpSync(SRC_VS, tmp, { recursive: true, force: true });
  try {
    try { renameSync(out, old); } catch { /* out 不存在（首次）→ 跳过 */ }
    renameSync(tmp, out);
  } catch {
    rmSync(out, { recursive: true, force: true });
    cpSync(SRC_VS, out, { recursive: true, force: true });
  }
  try { rmSync(old, { recursive: true, force: true }); } catch { /* 删除失败不影响结果 */ }
  const fd = openSync(stamp, "w");
  writeFileSync(fd, fp); closeSync(fd);
  const mb = (statSync(out).size / 1048576).toFixed(0);
  console.log(`[deploy] monaco vs → ${out} (${mb}MB · 原子替换) · fp=${fp}`);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) copyFileSync(resolve(root, f), resolve(extDir, f));
  // preview/：index.ts 的运行时 import（HTML 预览路由 + iframe 上报协议）+ 目录内 package.json
  //（{type:"module"}：扩展根是 commonjs，node --test 直跑 .ts 要靠它）——漏拷 → 扩展加载失败
  cpSync(resolve(root, "preview"), resolve(extDir, "preview"), { recursive: true, force: true });
  copyFileSync(resolve(root, "..", "_shared", "convert-saveas.ts"), resolve(extDir, "convert-saveas.ts"));
  copyFileSync(resolve(root, "..", "_shared", "soffice-locate.ts"), resolve(extDir, "soffice-locate.ts"));
  // exec-async 已迁 @aiti-ai/ext-shared 包（package.json 声明 + extman 共享根 reconcile），
  // 旧「拷 exec-async.ts」行随迁移退役——勿再恢复文件拷贝（曾误改 copyFileSync(root) 炸 EISDIR）
  // aiti-helper skills（install-soffice 等）+ soffice 一键安装脚本（递归拷，漏拷聚合不到）
  cpSync(resolve(root, "skills"), resolve(extDir, "skills"), { recursive: true, force: true });
  mkdirSync(resolve(extDir, "tools"), { recursive: true });
  copyFileSync(resolve(root, "tools", "install-soffice.sh"), resolve(extDir, "tools", "install-soffice.sh"));
  // vendored 库（diff-match-patch / cp936 编码表等，自带不走 CDN）
  const vendorDir = resolve(extDir, "vendor");
  rmSync(vendorDir, { recursive: true, force: true });
  cpSync(resolve(root, "vendor"), vendorDir, { recursive: true, force: true });
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-editor-client.mjs"), resolve(clientDir, "aiti-editor-client.mjs"));
  // 安装依赖（纯 JS 压缩包解析：yauzl + tar-stream，跨平台零系统依赖）
  // 正常安装（写 package.json 锚定）：避免后续 npm prune 误清 --no-save 包
  try {
    execSync("npm install yauzl tar-stream", { cwd: extDir, stdio: "ignore", timeout: 30000 });
  } catch { /* 依赖安装失败不阻塞部署 */ }
  console.log("[deploy] 源码 → " + extDir);
}
await syncMonaco(targets[0]);
await syncMonaco(targets[1]);

// ── 共享依赖 reconcile 通知（依赖进 <webRoot>/node_modules；允许失败，永不 throw）──
await notifyReconcile();

// 双实例热重载：实现收敛到 _shared/reload-instances.mjs（env basePath 双变量按机器设值）——允许失败，不影响 deploy 退出码
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}
console.log("[deploy] 完成。生效：POST /api/extensions/reload（已自动 reload，若上面有 ⚠/不可达 则手动补一次）；client 刷新页面即新");

// 提交部署状态到扩展 git 仓库（生产目录是 git 仓库；无变更跳过）

deployCommit({ repo: extRepo, name: "aiti-editor", paths: ["aiti-editor"], log: (m) => console.log("[deploy] " + m) });
// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
