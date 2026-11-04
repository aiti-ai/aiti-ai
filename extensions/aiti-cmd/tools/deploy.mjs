#!/usr/bin/env node
/**
 * aiti-cmd · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（pi-web 双实例扩展目录）
 *
 * 步骤：
 *   1) 构建 client bundle（tools/build-client.mjs，esbuild 打包 xterm.js）
 *   2) 拷贝服务端源码（index/runner/store/recognize/audit）→ 两个扩展目录
 *   3) 拷贝 client bundle → 两个扩展目录 client/
 *   4) package.json（dependencies 声明 node-pty 等）拷入 + 清理扩展本地 node_modules 残留
 *   5) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *   6) 通知双实例 extman reconcile 共享依赖 → <webRoot>/node_modules（aiti-extman ops）
 *   7) macOS：node-pty spawn-helper 补可执行位（共享根/本地两处都探测）
 *   8) 双实例热重载
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload；client no-store 刷新页面即新
 */
import { copyFileSync, mkdirSync, existsSync, cpSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";
import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-cmd
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-cmd"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-cmd"),
];
const extRepo = resolve(targets[0], "..");

// 1) 构建 client
console.log("[deploy] 构建 client bundle…");
execSync("node " + resolve(root, "tools/build-client.mjs"), { cwd: root, stdio: "inherit" });

// 2) 服务端源码 + 3) client bundle（两个实例目录）
for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["index.ts", "icon.svg", "runner.ts", "store.ts", "recognize.ts", "audit.ts", "pi-commands.ts"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-cmd-client.mjs"), resolve(clientDir, "aiti-cmd-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-cmd-client.mjs"));
  // skills/ 帮助点目录（pi skills 标准：index.json + 每 skill 一个 SKILL.md）
  const skillSrc = resolve(root, "skills");
  if (existsSync(skillSrc)) {
    const skillDest = resolve(extDir, "skills");
    mkdirSync(skillDest, { recursive: true });
    cpSync(skillSrc, skillDest, { recursive: true });
    console.log("[deploy] skills → " + skillDest);
  }
}

// 4) 运行时依赖（node-pty / command-exists / shell-quote）：package.json 一并部署（registry 读
//    name/version/soul，dependencies 就是共享依赖的声明源）。依赖本体由 extman reconcile 统一装进
//    <webRoot>/node_modules（jiti 从扩展目录向上解析自动命中，见步骤 6）——不再 npm i --prefix 装进
//    扩展目录（旧方式 --no-save 还漏声明 node-pty）；本地 node_modules 残留每次部署清理，让解析稳定
//    走共享根。不能裸 npm i：部署目录若无 package.json，npm 会向上命中 ~/package.json「假成功」，
//    依赖全装进家目录 node_modules（历史踩坑）
for (const extDir of targets) {
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  const legacyNm = resolve(extDir, "node_modules");
  if (existsSync(legacyNm)) {
    rmSync(legacyNm, { recursive: true, force: true });
    console.log("[deploy] 清理扩展本地 node_modules（依赖走共享根）→ " + legacyNm);
  }
}

// 5) 部署 commit（扩展 git 仓库；无变更跳过，失败不影响部署）

// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["terminal"], { log: (m2) => console.log(m2) });

deployCommit({ repo: extRepo, name: "aiti-cmd", paths: ["aiti-cmd"], ident: true, log: (m) => console.log("[deploy] " + m) });

// 6) 通知双实例 extman reconcile 共享依赖（依赖装进各自 <webRoot>/node_modules；await 等完成再 chmod/reload）。
//    允许失败：extman 未就绪/实例不可达仅提示，不影响部署退出码（下次安装时自动对齐）
await notifyReconcile();

// 7) macOS：node-pty prebuild 的 spawn-helper 必须带可执行位（解包/拷贝链路可能丢 +x，
//    丢失时 helper 起不来、所有 pty spawn 报 "posix_spawnp failed."）；非 darwin prebuild 不存在则空转。
//    共享根（<webRoot>/node_modules，本部署刚 reconcile 出来）与扩展本地（残留兜底）两处都探测
for (const nm of [...targets, ...targets.map((t) => resolve(t, "..", ".."))].map((d) => resolve(d, "node_modules"))) {
  const prebuilds = resolve(nm, "node-pty", "prebuilds");
  if (!existsSync(prebuilds)) continue;
  for (const d of readdirSync(prebuilds)) {
    if (!d.startsWith("darwin-")) continue;
    const helper = resolve(prebuilds, d, "spawn-helper");
    if (existsSync(helper)) { chmodSync(helper, 0o755); console.log("[deploy] chmod +x " + helper); }
  }
}

console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新");

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
