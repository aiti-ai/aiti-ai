"use strict";

// bundled-extensions-reconcile.js —— 主包预打包扩展（bundled）的运行时依赖 reconcile。
//
// 背景：npm 主包的 files 含 extensions/（bundled 全量扩展随包分发），但 npm 只装主包
// 自身的 dependencies——bundled 扩展各自 package.json 声明的 server 运行时依赖
//（@aiti-ai/ext-shared、command-exists、node-pty…）不会自动安装，扩展加载即
// Cannot find module。docker 场景由部署脚本做 webRoot reconcile；npm 安装场景
// 由本模块在 CLI 启动流里补齐同一语义：把全部 bundled 扩展的 dependencies 并集
// 一次 npm install 进共享根 <webRoot>/node_modules（jiti 从扩展目录向上 walk-up
// 解析命中）。
//
// 幂等：<webRoot>/node_modules/.bundled-reconcile.json 记录上次安装的依赖集指纹，
// 依赖集未变则跳过（二次启动零开销）。失败不阻塞启动（扩展按缺失依赖各自降级，
// 下次启动重试），仅 stderr 提示。
//
// webRoot 与宿主同款语义：PI_WEB_DEV_DIST=1 → ~/.pi/web-dev，否则 ~/.pi/web；
// PI_WEB_EXTENSIONS_ROOT 指定时以其父目录为准（自定义部署）。

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { spawn } = require("child_process");

const MARKER = ".bundled-reconcile.json";
// Cool-down after a failed install: a persistent failure (ETARGET for a version
// that does not exist anywhere, offline machine) would otherwise re-run npm and
// stall diagnostics on every single startup. Within the cool-down window the
// retry is skipped; a dependency-set change (new fingerprint) always retries.
const FAIL_COOLDOWN_MS = 30 * 60_000;
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "__pycache__", "vendor", "dist"]);
const N = (s) => (s || "").trim();

function webRootFor(pkgDir) {
  if (process.env.PI_WEB_DEV_DIST === "1") return path.join(require("os").homedir(), ".pi", "web-dev");
  const custom = N(process.env.PI_WEB_EXTENSIONS_ROOT);
  if (custom) return path.dirname(path.resolve(custom));
  return path.join(require("os").homedir(), ".pi", "web");
}

function listExtensionDirs(pkgDir) {
  const root = path.join(pkgDir, "extensions");
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  // 点目录（.build-root 等构建脚手架）不是扩展——其 package.json 可含 CI 绝对路径的
  // file: 依赖（共享构建根），union 进来会在用户机 ENOENT
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => path.join(root, e.name));
}

function readDeps(extDir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));
    return p.dependencies || null;
  } catch { return null; }
}

function depsFingerprint(depsUnion) {
  const hash = createHash("sha256");
  for (const name of Object.keys(depsUnion).sort()) hash.update(`${name}@${depsUnion[name]}\n`);
  return hash.digest("hex").slice(0, 16);
}

// Asynchronous counterpart of the old spawnSync: bin/pi-web.js runs the
// reconcile in the background while the server is already serving traffic —
// a synchronous spawn would freeze the event loop for the whole install.
function spawnShell(cmdLine, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmdLine, {
      shell: true,
      env: { ...process.env, npm_config_update_notifier: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? -1 : code, stdout: output, stderr: output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout: "", stderr: String(error && error.message ? error.message : error) });
    });
  });
}

/**
 * Reconcile bundled extensions' runtime dependencies into the shared root.
 * Async: the npm install runs without blocking the caller (server boot).
 * @returns {Promise<{ran:boolean, installed:boolean, skipped:string, count:number}|null>} null = nothing to do
 */
async function reconcileBundledExtensions(pkgDir) {
  const extDirs = listExtensionDirs(pkgDir);
  if (extDirs.length === 0) return null;
  const depsUnion = {};
  let withDeps = 0;
  for (const dir of extDirs) {
    const deps = readDeps(dir);
    if (!deps) continue;
    withDeps++;
    for (const [name, spec] of Object.entries(deps)) {
      // 同名依赖取并集里更宽松的语义（重复声明一致时无感；冲突时保留先见者，扩展间
      // 依赖冲突极为罕见——共享根单版本语义与 extman reconcile 一致）
      if (!depsUnion[name]) depsUnion[name] = spec;
    }
  }
  const sharedRoot = path.join(webRootFor(pkgDir), "node_modules");

  // walk-up 命中保障（所有路径都要做——包括指纹命中秒过路径）：npm 主包场景扩展位于
  // <pkgDir>/extensions/<id>/，其依赖解析 walk-up 链为 extensions/<id> → extensions →
  // <pkgDir> → …，不经过 ~/.pi/web。在 extensions/ 下放一个 node_modules symlink 指向
  // 共享根——该位点就在链上，Node/jiti 的模块解析对祖先 node_modules 的目录 symlink
  // 是跟随的（monorepo workspace 同原理）。已存在（上次创建/用户自管）则跳过。
  const linkPath = path.join(pkgDir, "extensions", "node_modules");
  try {
    if (!fs.existsSync(linkPath)) {
      // Windows: "dir" symlinks require SeCreateSymbolicLinkPrivilege (admin
      // process or Developer Mode) — a plain user shell gets EPERM. A junction
      // needs no privilege, resolves identically for Node/jiti module walking,
      // and libuv accepts a dangling (not-yet-created) target, which matters
      // because the shared root below may not exist on first launch.
      const type = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(sharedRoot, linkPath, type);
      process.stderr.write(`[pi-web] extensions/node_modules → ${sharedRoot} (${type})\n`);
    }
  } catch (e) {
    const hint = process.platform === "win32"
      ? `manual fix: cmd /c mklink /J "${linkPath}" "${sharedRoot}"`
      : `manual fix: ln -s "${sharedRoot}" "${linkPath}" (or set NODE_PATH=${sharedRoot})`;
    process.stderr.write(`[pi-web] extensions/node_modules link 创建失败（${hint}）: ${e.message}\n`);
  }

  const markerPath = path.join(sharedRoot, MARKER);
  const fingerprint = depsFingerprint(depsUnion);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch {}
  if (prev && prev.fingerprint === fingerprint) {
    if (!prev.failed) {
      return { ran: true, installed: false, skipped: "fingerprint-match", count: withDeps };
    }
    const age = prev.at ? Date.now() - new Date(prev.at).getTime() : Infinity;
    if (age < FAIL_COOLDOWN_MS) {
      return { ran: false, installed: false, skipped: "failed-cooldown", count: withDeps };
    }
    // cool-down expired — fall through and retry
  }

  fs.mkdirSync(sharedRoot, { recursive: true });
  const names = Object.keys(depsUnion).sort();
  // Windows cannot use an args array with shell:true here: the array is joined
  // with spaces and handed to cmd.exe, which eats the "^" in semver ranges as an
  // escape character (^0.2.4 → 0.2.4), degrading the range into an exact version.
  // When the registry lacks that exact version the whole shared-root install fails
  // (ETARGET). Build a single command-line string instead, double-quoting every
  // argument: cmd and sh treat "^" inside quotes literally, so npm receives the
  // full range; this also removes the DEP0190 deprecation warning (no more args
  // array combined with shell:true).
  const SAFE_SPEC = /^[A-Za-z0-9@/._^~><=*+-]+$/; // name@range whitelist: keep dirty package.json data out of the shell
  const specs = names.map((n) => {
    const spec = `${n}@${depsUnion[n]}`;
    if (!SAFE_SPEC.test(spec)) throw new Error(`unsafe dependency spec skipped install: ${spec}`);
    return `"${spec}"`;
  });
  const cmdLine = `npm install --prefix "${path.dirname(sharedRoot)}" --omit=dev --legacy-peer-deps --no-audit --no-fund --loglevel=error ${specs.join(" ")}`;
  const shell = await spawnShell(cmdLine, 10 * 60_000);
  if (shell.status !== 0) {
    process.stderr.write(`[pi-web] bundled 扩展依赖 reconcile 失败（扩展将按缺失依赖降级，30 分钟后下次启动重试）:\n${(shell.stderr || shell.stdout || "").slice(-600)}\n`);
    try { fs.writeFileSync(markerPath, JSON.stringify({ fingerprint, failed: true, at: new Date().toISOString() })); } catch {}
    return { ran: true, installed: false, skipped: "failed", count: withDeps };
  }
  try { fs.writeFileSync(markerPath, JSON.stringify({ fingerprint, at: new Date().toISOString(), count: names.length })); } catch {}
  return { ran: true, installed: true, skipped: "", count: withDeps, deps: names.length };
}

module.exports = { reconcileBundledExtensions };

// CLI 直跑（bin/pi-web.js 内部使用；亦支持 node bundled-extensions-reconcile.js 手动触发）
if (require.main === module) {
  const pkgDir = path.resolve(__dirname, "..");
  const t0 = Date.now();
  reconcileBundledExtensions(pkgDir)
    .then((res) => {
      if (!res) { console.log("[pi-web] 无 bundled 扩展，跳过 reconcile"); return; }
      if (res.installed) console.log(`[pi-web] bundled 扩展依赖已 reconcile（${res.count} 个扩展，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      else if (res.skipped === "fingerprint-match") console.log("[pi-web] bundled 扩展依赖指纹未变，跳过 reconcile");
      else if (res.skipped === "failed-cooldown") console.log("[pi-web] bundled 扩展依赖上次安装失败，冷却期内跳过重试");
      else if (res.skipped === "failed") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`[pi-web] bundled 扩展依赖 reconcile 异常: ${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    });
}
