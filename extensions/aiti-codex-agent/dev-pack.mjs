/**
 * pi-web-ext · dev-pack 共享实现（方案 §3.2 / M5：扩展 dev-pack——src + 构建工具 + AGENTS.md 直达部署目录）
 *
 * 目标：用户在 AI 窗对 AI 说「帮我改一下 xxx 扩展」时，AI 能在**部署目录**直接：
 *   读 AGENTS.md → 改 src/ → node tools/build.mjs → curl reload → 浏览器生效，不等回开发机。
 *
 * 各扩展 tools/deploy.mjs 末尾统一追加一段（见本文件同级各 deploy.mjs 模式）：
 *   const { packDevPack } = await import("../../_shared/dev-pack.mjs");
 *   packDevPack({ extRoot: <扩展源码根>, log: console.log });
 *
 * packDevPack 向每个已存在的部署目录（~/.pi/web{,-dev}/extensions/<extId>）写入：
 *   AGENTS.md        源码目录有则拷，无则由模板生成（§3.4）
 *   src/             client/src/**、根级服务端源码 *.ts/*.cjs/*.mjs、lib/（跳 vendor）、server/、sched/、worker-src/
 *   tools/build.mjs  现场构建入口（扩展自带则拷真身，否则生成 esbuild 默认版）
 *   tools/deploy.mjs 部署脚本本身（大改后回源码仓重部署的入口）
 *   package.json     含 aitiConfigs 声明与 build 脚本
 *   vite.config.ts   有则拷
 *
 * 幂等：重复部署整目录覆盖；允许失败：任何异常只 log 不影响 deploy 退出码（调用方 try/catch）。
 */
"use strict";
import { homedir } from "node:os";
import { join, resolve, dirname, basename, sep as pathSep } from "node:path";
import {
  existsSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync,
} from "node:fs";

// 根级服务端源码文件：拷进 src/（运行时平铺文件在部署根不动，宿主 loader 路径不变）
const ROOT_SRC_EXTS = new Set([".ts", ".tsx", ".cjs", ".mjs"]);
const ROOT_SRC_SKIP = new Set(["dist", "node_modules"]);
// 源码子目录：整目录拷（vendor 类大资产跳过——部署目录本就有运行时副本）
const SRC_DIRS = ["client/src", "server", "lib", "sched", "worker-src"];
const DIR_SKIP = new Set(["vendor", "__pycache__", "node_modules"]);

function copyTree(src, dest, skip) {
  mkdirSync(dest, { recursive: true });
  for (const en of readdirSync(src, { withFileTypes: true })) {
    if (skip && skip.has(en.name)) continue;
    const s = join(src, en.name), d = join(dest, en.name);
    if (en.isDirectory()) copyTree(s, d, skip);
    else if (en.isFile()) cpSync(s, d);
  }
}

/** AGENTS.md 默认模板（§3.4；扩展自带 AGENTS.md 则不走到这里）。供 CLI 批量生成源码目录版复用。 */
export function agentsMdTemplate(extId) {
  return `# ${extId} 扩展（部署目录直改指南）

## 结构
- 运行时文件平铺在本目录根（index.ts / core.cjs …，宿主 loader 按相对路径加载——**禁手改运行时平铺文件**，改 src/ 再 build）
- \`src/\` 源码（client/src + 服务端 ts/cjs）· \`dist/\` 构建产物（禁手改）· \`tools/\` 构建/部署脚本
- npm 包形态的扩展：本目录 package.json 含 version 与 aitiConfigs 声明

## 小改现场流程（改文案/样式/小逻辑）
1. 改 \`src/\` 下对应源码
2. \`node tools/build.mjs\`（client 有构建产物的扩展；纯服务端改动跳过）
3. \`curl -X POST http://127.0.0.1:3001/api/extensions/reload\`（dev；prod 3002；外部经 nginx 带 basePath：/dev、/mac、/mdev、/win、/wdev → \`/xxx/api/extensions/reload\`）
4. 浏览器刷新页面验证

## 大改回源码仓
- 源码仓：\`extensions/${extId}/\`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 \`node tools/deploy.mjs\`（或仓库根 \`node scripts/deploy-all.mjs --only ${extId}\`）

## 数据目录（数据分层：config / cache）
- \`ctx.configDir\` 根级 = 配置与关键小状态（aiti-configs 备份范围；小、珍贵、人可读）
- \`ctx.cacheDir\`（= \`<configDir>/cache/\`）= 可删缓存：db/venv/日志/大文件；rm -rf 后扩展下次访问自动重建
- \`ctx.dataDir\` 已移除（访问即抛）——新代码禁用
- 本扩展白名单（永不为 cache 的配置文件）见 package.json \`aitiConfigs.configFiles\`

## 红线
- 禁轮询（setInterval 拉取）；需要等待用事件/回调/SSE（桥的 SSE、aiti-event-bus topics）
- 禁重启生产服务（pi-web 3002 等 restart 须用户明确同意）
- 禁手改 dist/ 与运行时平铺文件；跨扩展通信走 ctx.services（禁 globalThis.__ext 直穿）
- 服务端：SQLite 一律 WAL + 分批小事务（批间 setImmediate 让步）；禁 execFileSync 调 >1s 外部程序；>8MB 文件禁同步读
`;
}

/** 默认 tools/build.mjs（esbuild 单包零配置；扩展自带 tools/build.mjs 则不走到这里）。 */
function buildMjsTemplate(extId, extRoot, clientOut, entryRel) {
  const repoHint = "/home/pi/workspace/aiti-ai"; // 现场构建探测源码仓 node_modules 用（三机各不同，缺失时走 npm exec）
  return `/**
 * ${extId} · 现场构建入口（dev-pack 默认模板，esbuild 单包零配置）
 * 用法：node tools/build.mjs
 * 本文件由 dev-pack 生成；复杂构建（多入口/插件链）请参照 src/vite.config.ts 改写本文件或回源码仓构建。
 */
"use strict";
import { existsSync, readdirSync, constants as fsConstants, accessSync } from "node:fs";
import { join, resolve, dirname, basename, sep as pathSep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");
const clientOut = ${JSON.stringify(clientOut || "dist/client-bundle.mjs")};
const entryRel = ${JSON.stringify(entryRel || "")};

// esbuild 解析：部署目录 node_modules → 源码仓 node_modules（本机开发场景）→ PATH 上的 esbuild → npm exec 现拉。
// 注意：node_modules/esbuild/bin/esbuild 是原生二进制（ELF/Mach-O），必须直接执行（不能当 JS 跑）。
function findEsbuild() {
  const home = (process.env.HOME || process.env.USERPROFILE || "").split(pathSep).join("/");
  const candidates = [
    extRoot + "/node_modules/esbuild/bin/esbuild",
    home + "/workspace/aiti-ai/node_modules/esbuild/bin/esbuild",
    "C:/workspace/aiti-ai/node_modules/esbuild/bin/esbuild", // windows dev box（源码在 D 盘）
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try { accessSync(c, fsConstants.X_OK); return [c]; } catch (e) { /* 无执行位 → 下一个来源 */ }
  }
  const r = spawnSync("esbuild", ["--version"], { encoding: "utf8" });
  if (r.status === 0) return ["esbuild"];
  return ["npm", "exec", "--yes", "esbuild", "--"];
}

function pickEntry() {
  if (entryRel) return entryRel;
  const srcDir = join(extRoot, "src", "client", "src");
  if (!existsSync(srcDir)) throw new Error("找不到 client 源码目录 src/client/src");
  for (const name of ["entry.tsx", "entry.ts", "entry.jsx", "entry.js", "index.tsx", "index.ts"]) {
    if (existsSync(join(srcDir, name))) return "client/src/" + name;
  }
  const first = readdirSync(srcDir).find((f) => /\\.(tsx?|jsx?)$/.test(f));
  if (!first) throw new Error("client/src 下没有可构建入口");
  return "client/src/" + first;
}

// 服务端源码同步：src/ 根级文件（index.ts/core.cjs/package.json/vite.config.ts 等）→ 部署根
// （服务端没有构建产物——jiti 直接加载部署根文件；不 sync 则「改 src → reload」永远不生效）
import { readdirSync as _rd, copyFileSync as _cp, statSync as _st } from "node:fs";
const srcRoot = join(extRoot, "src");
if (existsSync(srcRoot)) {
  for (const f of _rd(srcRoot)) {
    const fp = join(srcRoot, f);
    if (!_st(fp).isFile()) continue;
    _cp(fp, join(extRoot, f));
  }
  console.log("[build] 服务端源码已从 src/ 同步到部署根");
}

const entry = pickEntry();
const args = [join(extRoot, "src", entry), "--bundle", "--format=esm",
  "--outfile=" + join(extRoot, clientOut), "--jsx=automatic"];
// pi-web host-shim 委托（react → 本地 shim；jsx-runtime 同理）——与各扩展 vite.config 同款
const shim = join(extRoot, "src", "client", "src", "host-shim.ts");
const jsxRuntime = ["jsx-runtime.ts", "jsx-runtime.tsx", "jsx-dev-runtime.ts"].map((f) => join(extRoot, "src", "client", "src", f)).find(existsSync);
if (existsSync(shim)) args.push("--alias:react=" + shim);
if (jsxRuntime) args.push("--alias:react/jsx-runtime=" + jsxRuntime);
args.push("--log-level=info");

const [cmd, ...pre] = findEsbuild();
console.log("[build] esbuild:", cmd, ...pre);
const r = spawnSync(cmd, [...pre, ...args], { stdio: "inherit", cwd: extRoot });
if (r.status !== 0) { console.error("[build] 失败——可参照 src/vite.config.ts 调整本文件后重试，或回源码仓构建"); process.exit(r.status ?? 1); }
console.log("[build] ✓ " + clientOut + "（reload 后浏览器刷新生效）");
`;
}

/**
 * 主入口：向已存在的部署目录写 dev-pack。
 * @param {object} opts
 * @param {string} opts.extRoot   扩展源码根（pi-web-ext/<extId>）
 * @param {string[]} [opts.targets] 显式部署目录；缺省 = ~/.pi/web{,-dev}/extensions/<extId>（存在的才写）
 * @param {(m: string) => void} [opts.log]
 */
export function packDevPack(opts) {
  const extRoot = resolve(opts.extRoot);
  const extId = basename(extRoot);
  const log = opts.log || (() => {});
  const targets = (opts.targets || [
    join(homedir(), ".pi", "web", "extensions", extId),
    join(homedir(), ".pi", "web-dev", "extensions", extId),
  ]).filter((t) => existsSync(t));
  if (!targets.length) return;

  // 1) 打包源码到临时区（staging）→ 逐目标 cpSync（多部署目录零重复扫描）
  const stage = join(extRoot, "dist", ".dev-pack-staging");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    // src/：根级源码文件 + 源码子目录
    const srcDir = join(stage, "src");
    mkdirSync(srcDir, { recursive: true });
    for (const en of readdirSync(extRoot, { withFileTypes: true })) {
      if (en.isDirectory()) continue;
      if (ROOT_SRC_SKIP.has(en.name)) continue;
      if (!ROOT_SRC_EXTS.has(en.name.slice(en.name.lastIndexOf(".") || 0)) && en.name !== "package.json") continue;
      cpSync(join(extRoot, en.name), join(srcDir, en.name));
    }
    for (const d of SRC_DIRS) {
      const s = join(extRoot, d);
      if (!existsSync(s)) continue;
      copyTree(s, join(srcDir, ...d.split("/")), DIR_SKIP);
    }
    for (const f of ["vite.config.ts", "package.json"]) {
      if (existsSync(join(extRoot, f))) cpSync(join(extRoot, f), join(srcDir, f));
    }
    // tools/build.mjs：扩展自带拷真身，否则生成默认 esbuild 版
    mkdirSync(join(stage, "tools"), { recursive: true });
    if (existsSync(join(extRoot, "tools", "build.mjs"))) {
      cpSync(join(extRoot, "tools", "build.mjs"), join(stage, "tools", "build.mjs"));
    } else {
      let clientOut = "";
      try {
        const pkg = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));
        if (pkg.client && String(pkg.client).startsWith("dist/")) clientOut = pkg.client;
      } catch (e) {}
      if (!clientOut) {
        // 回退：client 产物名常声明在 entry 的 client: "dist/<id>-client.mjs"（index.ts）——从 staging 的 src 里解析
        try {
          for (const f of readdirSync(srcDir)) {
            if (!/\.tsx?$/.test(f)) continue;
            const m = readFileSync(join(srcDir, f), "utf8").match(/client\s*:\s*["'`](dist\/[\w.-]+\.mjs)["'`]/);
            if (m) { clientOut = m[1]; break; }
          }
        } catch (e) {}
      }
      writeFileSync(join(stage, "tools", "build.mjs"), buildMjsTemplate(extId, extRoot, clientOut, ""));
    }
    // tools/deploy.mjs 本身
    if (existsSync(join(extRoot, "tools", "deploy.mjs"))) {
      cpSync(join(extRoot, "tools", "deploy.mjs"), join(stage, "tools", "deploy.mjs"));
    }
    // AGENTS.md：自带优先，否则模板生成
    if (existsSync(join(extRoot, "AGENTS.md"))) cpSync(join(extRoot, "AGENTS.md"), join(stage, "AGENTS.md"));
    else writeFileSync(join(stage, "AGENTS.md"), agentsMdTemplate(extId));

    // 1.5) _shared 依赖：部署 src 里的源码可能相对引用 ../../../_shared/*（源仓出仓路径）——
    // 部署根放一份 _shared（小体量、纯源码），让现场 build 的模块解析与源仓一致
    const sharedSrc = resolve(extRoot, "..", "_shared");
    if (existsSync(sharedSrc)) {
      const sharedStage = join(stage, "_shared");
      copyTree(sharedSrc, sharedStage, DIR_SKIP);
    }

    // 2) 落位（staging → 部署目录；package.json/vite.config.ts 双放：根级按 §3.2 结构，src 内供现场阅读）
    for (const t of targets) {
      cpSync(stage, t, { recursive: true });
      for (const f of ["package.json", "vite.config.ts"]) {
        if (existsSync(join(stage, f))) cpSync(join(stage, f), join(t, f));
      }
    }
    log(`dev-pack → ${targets.map((t) => t.replace(homedir(), "~")).join(", ")}（AGENTS.md + src/ + tools/）`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
