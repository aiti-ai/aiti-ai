/**
 * pi-web-ext · dev-pack shared implementation (plan §3.2 / M5: extension dev-pack — src + build tools + AGENTS.md delivered straight into the deploy directory)
 *
 * Goal: when the user asks the AI in the AI window to "tweak extension xxx", the AI can work
 *   directly in the **deploy directory**: read AGENTS.md → edit src/ → node tools/build.mjs →
 *   curl reload → live in the browser, without waiting for the dev machine.
 *
 * Every extension's tools/deploy.mjs appends the same block at the end (see sibling deploy.mjs files):
 *   const { packDevPack } = await import("../../_shared/dev-pack.mjs");
 *   packDevPack({ extRoot: <extension source root>, log: console.log });
 *
 * packDevPack writes into every existing deploy directory (~/.pi/web{,-dev}/extensions/<extId>):
 *   AGENTS.md        copied from the source dir when present, else generated from the template (§3.4)
 *   src/             client/src/**, root-level server sources *.ts/*.cjs/*.mjs, lib/ (vendor skipped), server/, sched/, worker-src/
 *   tools/build.mjs  on-site build entry (the real one is copied if the extension ships it, else the default esbuild version is generated)
 *   tools/deploy.mjs the deploy script itself (entry for redeploying from the source repo after big changes)
 *   package.json     includes the aitiConfigs declaration and the build script
 *   vite.config.ts   copied when present
 *
 * Idempotent: redeployment overwrites the whole directory; failure-tolerant: any exception is
 * only logged and never affects the deploy exit code (caller wraps in try/catch).
 */
"use strict";
import { homedir } from "node:os";
import { join, resolve, dirname, basename, sep as pathSep } from "node:path";
import {
  existsSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync,
} from "node:fs";

// Root-level server source files: copied into src/ (runtime flat files stay at the deploy root so host loader paths are unchanged)
const ROOT_SRC_EXTS = new Set([".ts", ".tsx", ".cjs", ".mjs"]);
const ROOT_SRC_SKIP = new Set(["dist", "node_modules"]);
// Source subdirectories: copied whole (vendor-style large assets skipped — the deploy directory already has runtime copies)
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

/** Default AGENTS.md template (§3.4; not reached when the extension ships its own AGENTS.md). Reused by the CLI bulk source-dir generator. */
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

/** Default tools/build.mjs (zero-config single-bundle esbuild; not reached when the extension ships its own tools/build.mjs). */
function buildMjsTemplate(extId, extRoot, clientOut, entryRel) {
  // No hardcoded checkout path: candidates are resolved at run time (see the template below).
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

// esbuild resolution: deployed node_modules → source-repo node_modules (local dev) → esbuild on PATH → fresh `npm exec`.
// Note: node_modules/esbuild/bin/esbuild is a native binary (ELF/Mach-O) — execute it directly (never as JS).
// Checkout roots are discovered by walking up from the extension dir (a root has node_modules/),
// plus AITI_REPO_ROOT when set — no machine-specific absolute paths baked into generated files.
function repoCandidates() {
  const out = [];
  if (process.env.AITI_REPO_ROOT) out.push(process.env.AITI_REPO_ROOT.split(pathSep).join("/") + "/node_modules/esbuild/bin/esbuild");
  let d = extRoot;
  for (let i = 0; i < 8; i++) {
    out.push(d.split(pathSep).join("/") + "/node_modules/esbuild/bin/esbuild");
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}
function findEsbuild() {
  const home = (process.env.HOME || process.env.USERPROFILE || "").split(pathSep).join("/");
  const candidates = [
    extRoot + "/node_modules/esbuild/bin/esbuild",
    ...repoCandidates(),
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

// Server source sync: src/ root files (index.ts/core.cjs/package.json/vite.config.ts etc.) → deploy root
// (the server has no build output — jiti loads the deploy-root files directly; without this sync "edit src → reload" never takes effect)
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
 * Main entry: write the dev-pack into existing deploy directories.
 * @param {object} opts
 * @param {string} opts.extRoot   extension source root (pi-web-ext/<extId>)
 * @param {string[]} [opts.targets] explicit deploy directories; default = ~/.pi/web{,-dev}/extensions/<extId> (only existing ones are written)
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

  // 1) pack sources into a staging area → cpSync per target (no repeated scans across deploy dirs)
  const stage = join(extRoot, "dist", ".dev-pack-staging");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    // src/: root-level source files + source subdirectories
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
    // tools/build.mjs: copy the extension's own, else generate the default esbuild version
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
        // fallback: the client bundle name is often declared in the entry as client: "dist/<id>-client.mjs" (index.ts) — parse it from the staged src
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
    // tools/deploy.mjs itself
    if (existsSync(join(extRoot, "tools", "deploy.mjs"))) {
      cpSync(join(extRoot, "tools", "deploy.mjs"), join(stage, "tools", "deploy.mjs"));
    }
    // AGENTS.md: the extension's own wins, else generated from the template
    if (existsSync(join(extRoot, "AGENTS.md"))) cpSync(join(extRoot, "AGENTS.md"), join(stage, "AGENTS.md"));
    else writeFileSync(join(stage, "AGENTS.md"), agentsMdTemplate(extId));

    // 1.5) _shared dependency: staged src files may reference ../../../_shared/* (source-repo-relative
    // paths) — a _shared copy at the deploy root (small, pure source) keeps on-site build resolution consistent
    const sharedSrc = resolve(extRoot, "..", "_shared");
    if (existsSync(sharedSrc)) {
      const sharedStage = join(stage, "_shared");
      copyTree(sharedSrc, sharedStage, DIR_SKIP);
    }

    // 2) place into position (staging → deploy dir; package.json/vite.config.ts written twice: root level per the §3.2 layout, inside src for on-site reading)
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
