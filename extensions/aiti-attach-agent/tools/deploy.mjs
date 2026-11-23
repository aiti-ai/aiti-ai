#!/usr/bin/env node
/**
 * aiti-attach-agent 统一部署工具——一条命令部署 TUI 桥 + aiti_* 连接器 + pi-web 端扩展。
 *
 * 产物去向（4 个目的地）：
 *   ① ~/.pi/agent/extensions/pi-web-bridge/          TUI（/web + aiti_* 双入口，重启 TUI 生效）
 *      ├ package.json          pi.extensions 双入口清单（本脚本生成）
 *      ├ index.ts              = pi-tui/pi-web-bridge.ts（唯一源，替代旧三副本手工同步）
 *      ├ bridge-registry.ts    共享注册表
 *      └ aiti-devtools-pi.js   连接器 bundle（packages/aiti-devtools-pi esbuild 产物）
 *      ⚠ Only write this directory on machines WITHOUT a package-level registration:
 *        when settings.json `packages` already contains @aiti-ai/pi-web-bridge (an npm spec
 *        or a local dir such as /…/aiti-ai/pi-plugins/pi-web-bridge), pi loads the same
 *        plugin through the package's own pi.extensions — writing this dir too would
 *        register everything twice (pi reports `Tool "aiti_*" conflicts with …` and /web
 *        starts two bridges). In that case this script only refreshes the package's
 *        src/dist (sync-src) and moves a stale legacy dir out of the scan path.
 *   ② ~/.pi/web-dev/extensions/aiti-attach-agent/index.ts   pi-web dev（重启 dev 生效）
 *   ③ ~/.pi/web/extensions/aiti-attach-agent/index.ts       pi-web prod（重启 prod 生效）
 *   ④ ~/.pi/web{,-dev}/extensions/aiti-devtools/bridge-core.ts  桥核心（单例跨 reload，必须重启 pi-web）
 *
 * 用法：
 *   node tools/deploy.mjs              # 全量：构建 bundle + 全部拷贝
 *   node tools/deploy.mjs --no-build   # 跳过 bundle 构建（沿用 dist 现有产物）
 *
 * 源契约（改代码只改这些地方）：
 *   pi-tui/pi-web-bridge.ts                    /web 桥唯一源
 *   packages/aiti-devtools-pi/src/index.ts     连接器唯一源
 *   packages/aiti-devtools-core/src/bridge.ts  桥核心唯一源
 *   index.ts（本目录）                         pi-web 端 attach 后端唯一源
 */
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, existsSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { defaultSettingsFiles, findPluginEntry, isGeneratedLegacyDir } from "../registration-guard.mjs";
import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");                       // extensions/aiti-attach-agent
const repo = resolve(pkg, "..", "..");                 // aiti-ai repo root
const coreBridge = resolve(repo, "packages", "aiti-devtools-core", "src", "bridge.ts");
const piPkg = resolve(repo, "packages", "aiti-devtools-pi");
const bundleSrc = resolve(piPkg, "dist", "aiti-devtools-pi.js");
const agent = homedir();
const tuiDir = join(agent, ".pi", "agent", "extensions", "pi-web-bridge");
const webDirs = [join(agent, ".pi", "web-dev", "extensions", "aiti-attach-agent"), join(agent, ".pi", "web", "extensions", "aiti-attach-agent")];
const coreDirs = [join(agent, ".pi", "web-dev", "extensions", "aiti-devtools"), join(agent, ".pi", "web", "extensions", "aiti-devtools")];

const copy = (src, dest) => { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest); console.log("  ✓ " + dest.replace(agent, "~")); };

// ── Single-registration guard (the TUI plugin must have exactly one source) ────────
// pi has two load channels: ① settings.json `packages[]` (npm specs or local dirs, loaded
// via the package's pi.extensions) and ② directories under ~/.pi/agent/extensions/ (scanned
// automatically). Hitting both registers the same /web bridge + aiti_* tools twice, so this
// script treats ① as authoritative when it is present. Detection is shared with the runtime
// guard (../registration-guard.mjs) that both entry points call at load time — this script
// additionally cleans up a stale legacy dir so users do not need to.
const piAgentDir = process.env.PI_CODING_AGENT_DIR || join(agent, ".pi", "agent");
const settingsFiles = defaultSettingsFiles({ agentDir: piAgentDir });

/** Refresh the registered local package view (src/ + dist/) so pi loads current code. */
function refreshPackageView(dir) {
  const sync = join(dir, "tools", "sync-src.mjs");
  if (!existsSync(sync)) return;
  try {
    execFileSync(process.execPath, [sync], { stdio: "inherit", cwd: dir });
  } catch (e) {
    console.log("  ⚠ 包内 src/dist 刷新失败（不影响部署，可手动跑 node tools/sync-src.mjs）：" + String((e && e.message) || e));
  }
}

console.log("── aiti-attach-agent 部署 ──");

// 1) 连接器 bundle（esbuild：内联 core+agent，外置 pi SDK/typebox 由 jiti 提供）
if (process.argv.includes("--no-build")) {
  if (!existsSync(bundleSrc)) { console.error("[deploy] --no-build 但 dist 不存在，先去掉该 flag 构建"); process.exit(1); }
  console.log("① 跳过 bundle 构建（--no-build）");
} else {
  console.log("① 构建连接器 bundle…");
  execFileSync(process.execPath, [resolve(piPkg, "tools", "build.mjs")], { stdio: "inherit", cwd: piPkg });
}

// 2) TUI plugin: with a package registration only refresh that package, else install the dir
const registered = findPluginEntry({ settingsFiles });
if (registered) {
  console.log("② TUI 扩展：已由 pi 包注册（" + registered.source + "）— 跳过目录安装");
  if (existsSync(tuiDir) && isGeneratedLegacyDir(tuiDir)) {
    if (process.argv.includes("--keep-legacy-tui")) {
      console.log("  ⚠ 旧目录仍存在（--keep-legacy-tui）：会被 pi 当第二套扩展加载，工具名会冲突");
    } else {
      // Renaming inside the same extensions/ dir would still get scanned → move it out.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = join(agent, ".pi", "agent", "legacy-extensions-backup", "pi-web-bridge-" + stamp);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(tuiDir, backup);
      console.log("  ⚠ 移走重复注册的旧目录 → " + backup.replace(agent, "~"));
    }
  }
  if (registered.dir && (registered.dir + sep).startsWith(repo + sep)) refreshPackageView(registered.dir);
} else {
  console.log("② TUI 扩展 → " + tuiDir.replace(agent, "~"));
  mkdirSync(tuiDir, { recursive: true });
  // The deployed dir is flat, so rewrite the two "../" imports of the source file.
  const tuiEntry = readFileSync(resolve(pkg, "pi-tui", "pi-web-bridge.ts"), "utf8")
    .replace(/from "\.\.\/bridge-registry"/g, 'from "./bridge-registry"')
    .replace(/from "\.\.\/registration-guard\.mjs"/g, 'from "./registration-guard.mjs"');
  writeFileSync(join(tuiDir, "index.ts"), tuiEntry);
  console.log("  ✓ " + join(tuiDir, "index.ts").replace(agent, "~"));
  copy(resolve(pkg, "bridge-registry.ts"), join(tuiDir, "bridge-registry.ts"));
  copy(resolve(pkg, "registration-guard.mjs"), join(tuiDir, "registration-guard.mjs"));
  copy(resolve(pkg, "registration-guard.d.mts"), join(tuiDir, "registration-guard.d.mts"));
  copy(bundleSrc, join(tuiDir, "aiti-devtools-pi.js"));
  // pi multi-entry manifest: index.ts (/web bridge) + aiti-devtools-pi.js (aiti_* connector)
  writeFileSync(join(tuiDir, "package.json"), JSON.stringify({
    name: "pi-web-bridge", private: true,
    pi: { extensions: ["index.ts", "aiti-devtools-pi.js"] },
  }, null, 2) + "\n");
}

// 3) pi-web 端 attach 后端（dev 必重启；prod 重启生效）
console.log("③ pi-web attach 后端…");
// index.ts 依赖 ./bridge-registry.ts（同一 import 链）——必须随行拷贝
// （fresh deploy 实证：漏拷 → 容器/新机首启即 "Cannot find module './bridge-registry.ts'"）
for (const d of webDirs) {
  copy(resolve(pkg, "index.ts"), join(d, "index.ts"));
  copy(resolve(pkg, "bridge-registry.ts"), join(d, "bridge-registry.ts"));
  copy(resolve(pkg, "package.json"), join(d, "package.json")); // 协议声明/版本仲裁/依赖 reconcile 数据源
}

// 4) 桥核心（dev/prod aiti-devtools 的 bridge-core.ts，与 core 源同源）
console.log("④ 桥核心 bridge-core.ts…");
if (!existsSync(coreBridge)) { console.error("[deploy] 找不到核心源：" + coreBridge); process.exit(1); }
for (const d of coreDirs) { mkdirSync(d, { recursive: true }); copy(coreBridge, join(d, "bridge-core.ts")); }

console.log(`
── 完成。生效方式 ──
  TUI:   重启 pi 终端会话（扩展进程级注册）
  dev:   重启 pi-web-dev 进程（桥单例跨 reload 存活，热重载不换核心）
  prod:  重启 pi-web 服务（bridge-core/index.ts 已就位）
提示: AITI_ATTACH_DEBUG=1 可开 attach handle 帧级日志；AITI_PI_EXT_FORCE=1 可强制
      连接器在 pi-web 内嵌进程注册（默认按 PI_WEB_* env 守卫跳过）。`);

// ── 共享依赖 reconcile 通知（依赖进 <webRoot>/node_modules；允许失败，永不 throw）──
await notifyReconcile();

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
