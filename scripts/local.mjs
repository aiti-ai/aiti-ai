#!/usr/bin/env node
/**
 * Local in-place runner: clone → one command.
 *
 * Pi-web already loads extensions from `<pkgDir>/extensions` (the bundled tier:
 * user > extra > dev > bundled). Running an instance from the repository root
 * therefore loads the extension sources in place — no deploy step needed.
 * This script only fills the gaps around that mechanism:
 *
 *   1. root deps      install when node_modules/next or node_modules/vite is missing
 *   2. pi plugins     write pi-plugins/* as local paths into ~/.pi/agent/settings.json
 *   3. ext deps       run bin/bundled-extensions-reconcile.js (shared node_modules + symlink)
 *   4. build clients  run each extension's build:client when its product is missing or stale
 *   5. start          next dev, or `next build` + `next start` with --prod
 *
 * No host env is introduced: PI_WEB_EXTENSIONS_DIR is never set, and deployment
 * env leakage (PI_WEB_BASE_PATH, PI_WEB_BUNDLED_EXTENSIONS_DIR, …) is stripped
 * from the child process.
 *
 * Usage:
 *   npm run local                     # dev mode on port 30141
 *   npm run local -- --prod           # build + start
 *   npm run local -- --build-only     # init + build clients, no server
 *   npm run local -- --only aiti-cmd,aiti-float --force-build
 *   npm run local -- --no-plugins --no-install
 *   npm run local -- --restore-plugins
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  lstatSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, cpus } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_ROOT = join(REPO, "extensions");
const LOCAL_DIR = join(REPO, ".pi", "local");
const DIST_DIR = ".next-local";
const DEFAULT_PORT = 30141;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PROD = has("--prod");
const BUILD_ONLY = has("--build-only");
const SKIP_BUILD = has("--skip-build");
const FORCE_BUILD = has("--force-build");
const NO_INSTALL = has("--no-install");
const NO_PLUGINS = has("--no-plugins");
const RESTORE_PLUGINS = has("--restore-plugins");
const ONLY = (opt("--only") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = Number(opt("--port", String(DEFAULT_PORT))) || DEFAULT_PORT;

if (has("-h") || has("--help")) {
  console.log(`Usage: npm run local [-- options]

  --prod              build (next build --webpack) and start
  --port <n>          listen port (default ${DEFAULT_PORT})
  --build-only        run init + client builds, do not start a server
  --only a,b          build only these extension ids
  --skip-build        do not build extension clients
  --force-build       rebuild even when products look up to date
  --no-install        skip npm install / extension dependency reconcile
  --no-plugins        do not write pi-plugins local paths into settings.json
  --restore-plugins   remove plugin entries previously added by this script

Dev mode:     PI_WEB_DEV_DIST=1, distDir ${DIST_DIR}, data ~/.pi/web/data
Prod mode:    next build + next start, same distDir/data
Extensions:   loaded in place from <repo>/extensions (bundled tier).`);
  process.exit(0);
}

// ── small helpers ───────────────────────────────────────────────────────────
const log = (msg) => console.log(`[local] ${msg}`);
const warn = (msg) => console.warn(`[local] ⚠ ${msg}`);
const fail = (msg) => {
  console.error(`[local] ✗ ${msg}`);
  process.exit(1);
};
const step = (n, msg) => console.log(`\n[local] ── ${n}. ${msg} ──`);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Run a child with piped output; resolve { code, output } (never throws). */
function run(cmd, args, { cwd = REPO, env = process.env } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    child.on("error", (e) => resolveRun({ code: -1, output: `${output}\n${e.message}` }));
    child.on("close", (code) => resolveRun({ code: code ?? -1, output }));
  });
}

/** Simple concurrency pool. */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ── 1. root deps ────────────────────────────────────────────────────────────
async function ensureRootDeps() {
  step(1, "root dependencies");
  const needed = ["next", "vite", "esbuild"].filter(
    (pkg) => !existsSync(join(REPO, "node_modules", pkg, "package.json")),
  );
  if (needed.length === 0) {
    log("node_modules ok (next, vite, esbuild)");
    return true;
  }
  if (NO_INSTALL) {
    warn(`missing root packages: ${needed.join(", ")} — continuing (--no-install)`);
    return false;
  }
  log(`installing root dependencies (missing: ${needed.join(", ")})…`);
  const res = await new Promise((resolveRun) => {
    const child = spawn(NPM, ["install", "--no-audit", "--no-fund"], {
      cwd: REPO,
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("close", (code) => resolveRun(code ?? -1));
    child.on("error", () => resolveRun(-1));
  });
  if (res !== 0) fail("npm install failed — fix the error above and re-run");
  log("root dependencies installed");
  return true;
}

// ── 2. pi plugins ───────────────────────────────────────────────────────────
function piAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function settingsPath() {
  return join(piAgentDir(), "settings.json");
}

function ledgerPath() {
  return join(LOCAL_DIR, "plugin-links.json");
}

function sourceOf(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
  return null;
}

function isLocalPath(source) {
  return (
    source.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(source) ||
    source.startsWith("./") ||
    source.startsWith("../")
  );
}

/** "npm:@scope/name@1.2.3" → "@scope/name"; non-npm sources → null. */
function npmSourceName(source) {
  if (!source.startsWith("npm:")) return null;
  const s = source.slice(4);
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

function localSourceName(source, baseDir) {
  if (!isLocalPath(source)) return null;
  const dir = resolve(baseDir, source);
  return readJson(join(dir, "package.json"))?.name ?? null;
}

/** Best-effort package name for any settings.json package source. */
function packageNameOf(source, baseDir) {
  if (!source) return null;
  if (isLocalPath(source)) return localSourceName(source, baseDir);
  const npm = npmSourceName(source);
  if (npm) return npm;
  if (/^(git|https?|ssh)/.test(source)) return null;
  const at = source.lastIndexOf("@");
  return at > 0 ? source.slice(0, at) : source;
}

function repoPlugins() {
  const dir = join(REPO, "pi-plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: join(dir, e.name), pkg: readJson(join(dir, e.name, "package.json")) }))
    .filter((p) => p.pkg && p.pkg.pi && typeof p.pkg.name === "string");
}

function writeSettings(next) {
  const file = settingsPath();
  const backup = `${file}.bak-inplace`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  writeJsonAtomic(file, next);
}

/** Add pi-plugins/* as local path entries (idempotent; npm entries are replaced). */
function linkPiPlugins() {
  step(2, "pi plugins (local paths)");
  const file = settingsPath();
  if (!existsSync(file)) {
    warn(`settings.json not found at ${file} — start pi once, then re-run`);
    return;
  }
  const settings = readJson(file);
  if (!settings) {
    warn(`cannot parse ${file} — skipped`);
    return;
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const known = new Map();
  packages.forEach((entry, index) => {
    const source = sourceOf(entry);
    const name = packageNameOf(source, piAgentDir());
    if (name) known.set(name, { index, source });
  });

  const ledger = readJson(ledgerPath()) ?? { added: [] };
  const added = [];
  for (const plugin of repoPlugins()) {
    const name = plugin.pkg.name;
    const existing = known.get(name);
    if (existing) {
      const source = existing.source;
      if (isLocalPath(source) && resolve(source) === resolve(plugin.dir)) {
        log(`keep existing entry for ${name}`);
        continue;
      }
      if (isLocalPath(source)) {
        warn(`keep ${name} (already points to another local path: ${source})`);
        continue;
      }
      // npm/git spec with the same package name: replace so the in-place source wins.
      const replaced = packages[existing.index];
      packages[existing.index] = plugin.dir;
      added.push({ name, path: plugin.dir, replaced });
      log(`~ ${name}: ${source} → local path`);
      continue;
    }
    packages.push(plugin.dir);
    known.set(name, { index: packages.length - 1, source: plugin.dir });
    added.push({ name, path: plugin.dir });
    log(`+ ${name} → ${plugin.dir}`);
  }

  if (added.length === 0) {
    log("all repository plugins already declared");
    return;
  }
  settings.packages = packages;
  writeSettings(settings);

  const seen = new Set((ledger.added ?? []).map((a) => a.path));
  for (const item of added) if (!seen.has(item.path)) ledger.added.push(item);
  ledger.updatedAt = new Date().toISOString();
  writeJsonAtomic(ledgerPath(), ledger);
  log("restart the instance for plugin changes to take effect");
}

function restorePlugins() {
  const file = settingsPath();
  const ledger = readJson(ledgerPath());
  if (!ledger || !Array.isArray(ledger.added) || ledger.added.length === 0) {
    log("nothing to restore (no plugin-links ledger)");
    return;
  }
  if (!existsSync(file)) {
    warn(`settings.json not found at ${file}`);
    return;
  }
  const settings = readJson(file);
  if (!settings) {
    warn(`cannot parse ${file}`);
    return;
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const byPath = new Map(ledger.added.map((a) => [resolve(a.path), a]));
  let removed = 0;
  let restored = 0;
  const kept = [];
  for (const entry of packages) {
    const source = sourceOf(entry);
    const item = source && isLocalPath(source) ? byPath.get(resolve(source)) : null;
    if (!item) {
      kept.push(entry);
      continue;
    }
    if (item.replaced !== undefined) {
      kept.push(item.replaced);
      restored++;
    } else {
      removed++;
    }
  }
  if (removed + restored > 0) {
    settings.packages = kept;
    writeSettings(settings);
  }
  writeJsonAtomic(ledgerPath(), { added: [], updatedAt: new Date().toISOString() });
  log(`restored settings.json (removed ${removed}, reverted ${restored})`);
}

// ── 3. extension runtime deps ───────────────────────────────────────────────
/** Union of extension runtime deps (name → first spec seen). */
function collectExtDeps() {
  const deps = new Map();
  for (const ext of listExtensions()) {
    for (const [name, spec] of Object.entries(ext.pkg.dependencies ?? {})) {
      if (!deps.has(name)) deps.set(name, spec);
    }
  }
  return deps;
}

/**
 * Fallback when the bundled reconcile fails as a whole (one dependency version
 * missing from the registry aborts the single npm install). Retries the union
 * package-by-package, dropping unavailable packages so every other extension
 * still gets its runtime deps.
 */
async function installSharedDepsDegraded() {
  const sharedRoot = join(homedir(), ".pi", "web-dev"); // reconcile runs with PI_WEB_DEV_DIST=1
  const modules = join(sharedRoot, "node_modules");
  const link = join(EXT_ROOT, "node_modules");
  if (!existsSync(link)) {
    try {
      mkdirSync(sharedRoot, { recursive: true });
      symlinkSync(modules, link, "dir");
    } catch (e) {
      warn(`cannot link ${link}: ${e.message}`);
      return;
    }
  }
  const deps = collectExtDeps();
  const skipped = new Set();
  for (let round = 0; round < 6; round++) {
    const specs = [...deps]
      .filter(([name]) => !skipped.has(name))
      .map(([name, spec]) => `${name}@${spec}`);
    if (specs.length === 0) break;
    const res = await run(
      NPM,
      [
        "install",
        "--prefix",
        sharedRoot,
        "--omit=dev",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...specs,
      ],
      { cwd: sharedRoot },
    );
    if (res.code === 0) {
      log(`installed ${specs.length} extension deps (degraded mode)`);
      break;
    }
    const missing = res.output.match(/No matching version found for (\S+?)@/);
    if (!missing) {
      warn(res.output.split("\n").filter(Boolean).slice(-6).join("\n"));
      break;
    }
    skipped.add(missing[1]);
    warn(`skip unavailable dependency ${missing[1]}`);
  }
  if (skipped.size > 0) warn(`unavailable extension dependencies: ${[...skipped].join(", ")}`);
}

/**
 * The in-repo @aiti-ai/ext-shared can be ahead of the published copy (new
 * exports land in the source tree first). Point the shared root at the
 * repository directory so in-place extensions resolve the same source the
 * build does.
 */
function linkLocalExtShared() {
  const src = join(EXT_ROOT, "_shared");
  const pkg = readJson(join(src, "package.json"));
  if (!pkg?.name) return;
  const sharedRoot = join(homedir(), ".pi", "web-dev"); // reconcile runs with PI_WEB_DEV_DIST=1
  if (!existsSync(join(sharedRoot, "node_modules"))) return;
  const parts = pkg.name.split("/");
  const dest = join(sharedRoot, "node_modules", ...parts);
  const already = (() => {
    try {
      return realpathSync(dest) === realpathSync(src);
    } catch {
      return false;
    }
  })();
  if (!already) {
    try {
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      symlinkSync(src, dest, "dir");
      log(`link ${pkg.name} → ${src} (in-repo source wins)`);
    } catch (e) {
      warn(`cannot link ${pkg.name}: ${e.message}`);
    }
  }
  // Per-extension copies installed by the retry npm install shadow the shared root.
  for (const ext of listExtensions()) {
    const local = join(ext.dir, "node_modules", ...parts);
    let present = existsSync(local);
    if (!present) {
      try {
        lstatSync(local);
        present = true;
      } catch {
        present = false;
      }
    }
    if (!present) continue;
    let same = false;
    try {
      same = realpathSync(local) === realpathSync(src);
    } catch {
      same = false;
    }
    if (same) continue;
    try {
      rmSync(local, { recursive: true, force: true });
      mkdirSync(dirname(local), { recursive: true });
      symlinkSync(src, local, "dir");
      log(`link ${pkg.name} → ${src} (${ext.id})`);
    } catch (e) {
      warn(`cannot link ${pkg.name} in ${ext.id}: ${e.message}`);
    }
  }
}

async function ensureExtDeps() {
  step(3, "extension runtime dependencies");
  const link = join(EXT_ROOT, "node_modules");
  if (NO_INSTALL) {
    if (!existsSync(link)) warn("extensions/node_modules is missing (--no-install) — extensions may fail to load");
    linkLocalExtShared();
    return;
  }
  if (existsSync(link)) {
    try {
      log(`extensions/node_modules → ${realpathSync(link)}`);
    } catch {
      log(`extensions/node_modules exists at ${link}`);
    }
  }
  const res = await run(
    process.execPath,
    [join(REPO, "bin", "bundled-extensions-reconcile.js")],
    { env: { ...process.env, PI_WEB_DEV_DIST: "1" } },
  );
  for (const line of res.output.split("\n").filter(Boolean)) log(line);
  if (res.code !== 0) {
    warn("extension dependency reconcile failed — retrying package-by-package");
    await installSharedDepsDegraded();
  }
  linkLocalExtShared();
}

// ── 4. extension client builds ──────────────────────────────────────────────
function listExtensions() {
  const out = [];
  for (const entry of readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(EXT_ROOT, entry.name);
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg || !existsSync(join(dir, "index.ts"))) continue;
    const raw = pkg.scripts?.["build:client"] ?? pkg.scripts?.build ?? null;
    const script =
      raw && raw.trim() !== "true" ? (pkg.scripts?.["build:client"] ? "build:client" : "build") : null;
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    const client = index.match(/client:\s*["'`]([^"'`\n]+)["'`]/)?.[1] ?? null;
    out.push({ id: entry.name, dir, pkg, script, client });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Newest mtime under `dir`, skipping node_modules and the client product itself. */
function newestMtime(dir, skip) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (skip && resolve(full) === resolve(skip)) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        /* ignore vanishing files */
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

function extensionSourceMtime(ext) {
  const paths = [join(ext.dir, "client"), join(ext.dir, "vite.config.ts"), join(ext.dir, "package.json"), join(ext.dir, "tools"), join(ext.dir, "index.ts")];
  let newest = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      newest = Math.max(newest, st.isDirectory() ? newestMtime(p, ext.product) : st.mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return newest;
}

function productPath(ext) {
  return ext.client ? join(ext.dir, ext.client) : join(ext.dir, "dist");
}

/**
 * Validate a built client product: the file must exist and every relative
 * import it contains must resolve. Catches half-copied vite split bundles
 * (entry chunk referenced but absent) that an mtime check would call fresh.
 */
function productProblem(ext) {
  const product = productPath(ext);
  if (!existsSync(product)) return "missing";
  try {
    if (statSync(product).size > 4 * 1024 * 1024) return null; // too large to scan cheaply
    const code = readFileSync(product, "utf8");
    const refs = [...code.matchAll(/(?:from\s*|import\s*\(\s*)['"](.\/[^'"]+)['"]/g)].map((m) => m[1]);
    const missing = refs.filter((ref) => !existsSync(resolve(dirname(product), ref)));
    return missing.length ? `missing ${missing[0]}` : null;
  } catch {
    return null;
  }
}

function needsBuild(ext) {
  if (!ext.script) return false;
  if (FORCE_BUILD) return true;
  const product = productPath(ext);
  if (!existsSync(product)) return true;
  const productTime = statSync(product).isDirectory() ? newestMtime(product, null) : statSync(product).mtimeMs;
  return extensionSourceMtime(ext) > productTime;
}

async function buildOne(ext) {
  const env = {
    ...process.env,
    PATH: `${join(REPO, "node_modules", ".bin")}${delimiter}${join(ext.dir, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  const res = await run(NPM, ["run", ext.script], { cwd: ext.dir, env });
  if (res.code === 0) return { id: ext.id, ok: true };
  return { id: ext.id, ok: false, output: res.output.split("\n").slice(-25).join("\n") };
}

async function buildExtClients() {
  step(4, "extension client builds");
  const all = listExtensions();
  extByProduct(all);
  const candidates = all.filter((ext) => ext.script && (ONLY.length === 0 || ONLY.includes(ext.id)));
  const missing = candidates.filter((ext) => !existsSync(productPath(ext)));
  const broken = candidates.filter((ext) => ext.script && productProblem(ext));
  const todo = candidates.filter((ext) => needsBuild(ext) || broken.includes(ext));
  const skipped = candidates.length - todo.length;
  log(`${all.length} extensions · ${candidates.length} buildable · ${todo.length} to build · ${skipped} up to date${missing.length ? ` · ${missing.length} missing products` : ""}`);
  for (const ext of broken) log(`  rebuild ${ext.id} (${productProblem(ext)})`);
  if (todo.length === 0) return true;

  const jobs = Math.max(1, Math.min(4, cpus().length || 1));
  let done = 0;
  const results = await runPool(todo, jobs, async (ext) => {
    const started = Date.now();
    const result = await buildOne(ext);
    done++;
    const label = result.ok ? "✓" : "✗";
    console.log(`[local]   ${label} ${ext.id} (${((Date.now() - started) / 1000).toFixed(1)}s) [${done}/${todo.length}]`);
    if (!result.ok) console.error(result.output);
    return result;
  });
  const failed = results.filter((r) => !r.ok);
  let remaining = failed;
  if (failed.length > 0) {
    // The first pass can fail when an extension needs a dependency that lives in
    // its own package.json (not the shared root). Install locally once and retry.
    const failedIds = new Set(failed.map((f) => f.id));
    const retry = todo.filter((ext) => failedIds.has(ext.id));
    log(`installing local deps for ${retry.length} failed extension(s), then retrying`);
    for (const ext of retry) {
      const inst = await run(NPM, ["install", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: ext.dir });
      if (inst.code !== 0) {
        warn(`${ext.id}: npm install failed (${inst.output.split("\n").filter(Boolean).slice(-1)[0] ?? "unknown"})`);
      }
    }
    const retried = await runPool(retry, jobs, async (ext) => {
      const result = await buildOne(ext);
      console.log(`[local]   ${result.ok ? "✓" : "✗"} ${ext.id} (after npm install)`);
      if (!result.ok) console.error(result.output);
      return result;
    });
    remaining = retried.filter((r) => !r.ok);
  }
  if (remaining.length > 0) {
    warn(`${remaining.length} extension build(s) failed: ${remaining.map((f) => f.id).join(", ")}`);
    warn("install that extension's local deps manually: cd extensions/<id> && npm install");
    return false;
  }
  const stillBroken = all.filter((ext) => ext.client && (ONLY.length === 0 || ONLY.includes(ext.id)) && productProblem(ext));
  if (stillBroken.length > 0) {
    warn(`client products still incomplete: ${stillBroken.map((e) => `${e.id} (${productProblem(e)})`).join(", ")}`);
    return false;
  }
  log(`all ${todo.length} builds succeeded`);
  return true;
}

/** Store the declared client product on each extension (used by mtime checks). */
function extByProduct(list) {
  for (const ext of list) ext.product = ext.client ? join(ext.dir, ext.client) : null;
}

// ── 5. start ────────────────────────────────────────────────────────────────
function childEnv() {
  const env = { ...process.env };
  for (const key of [
    "PI_WEB_DEV_DIST",
    "PI_WEB_DIST_DIR",
    "PI_WEB_BASE_PATH",
    "PI_WEB_BUILD_BASEPATH",
    "PI_WEB_EXTENSIONS_DIR",
    "PI_WEB_BUNDLED_EXTENSIONS_DIR",
    "PI_WEB_DATA_DIR",
    "PI_WEB_JITI_CACHE_DIR",
    "PI_WEB_PKG_DIR",
  ]) {
    delete env[key];
  }
  env.PI_WEB_DIST_DIR = DIST_DIR;
  env.PI_WEB_DATA_DIR = join(homedir(), ".pi", "web", "data");
  env.PORT = String(PORT);
  env.NEXT_TELEMETRY_DISABLED = "1";
  if (!PROD) env.PI_WEB_DEV_DIST = "1";
  return env;
}

function warnShadowed() {
  const layer = PROD
    ? join(homedir(), ".pi", "web", "extensions")
    : join(homedir(), ".pi", "web-dev", "extensions");
  if (!existsSync(layer)) return;
  const repoIds = new Set(
    readdirSync(EXT_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(EXT_ROOT, e.name, "index.ts")))
      .map((e) => e.name),
  );
  const shadowed = readdirSync(layer, { withFileTypes: true })
    .filter((e) => e.isDirectory() && repoIds.has(e.name))
    .map((e) => e.name);
  if (shadowed.length === 0) return;
  warn(
    `${shadowed.length} deployed extension(s) in ${layer} shadow the in-place sources ` +
      `(${shadowed.slice(0, 5).join(", ")}${shadowed.length > 5 ? ", …" : ""}). ` +
      `Move them away to load the repository sources.`,
  );
}

function nextBin() {
  const bin = join(REPO, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(bin)) fail("next is not installed — run npm install");
  return bin;
}

async function start() {
  const env = childEnv();
  warnShadowed();
  const bin = nextBin();

  if (PROD) {
    step(5, "next build");
    const build = await new Promise((resolveBuild) => {
      const child = spawn(process.execPath, [bin, "build", "--webpack"], {
        cwd: REPO,
        env,
        stdio: "inherit",
      });
      child.on("close", (code) => resolveBuild(code ?? -1));
      child.on("error", () => resolveBuild(-1));
    });
    if (build !== 0) fail("next build failed");
  }

  step(PROD ? 6 : 5, PROD ? "next start" : "next dev");
  const child = spawn(
    process.execPath,
    [bin, PROD ? "start" : "dev", "-H", "127.0.0.1", "-p", String(PORT)],
    { cwd: REPO, env, stdio: "inherit" },
  );
  child.on("error", (e) => fail(`failed to start next: ${e.message}`));
  child.on("close", (code) => process.exit(code ?? 0));
  const stop = (signal) => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  log(`open http://127.0.0.1:${PORT} (${PROD ? "prod" : "dev"}, in-place extensions)`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (RESTORE_PLUGINS) {
    restorePlugins();
    return;
  }
  console.log(`[local] repository: ${REPO}`);
  console.log(`[local] mode: ${PROD ? "prod (build + start)" : "dev"}${BUILD_ONLY ? " · build only" : ""}`);

  await ensureRootDeps();
  if (!BUILD_ONLY && !NO_PLUGINS) linkPiPlugins();
  await ensureExtDeps();
  const built = SKIP_BUILD ? true : await buildExtClients();
  if (BUILD_ONLY) {
    if (!built) process.exit(1);
    log("build-only done");
    return;
  }
  if (!built) warn("continuing to start with missing client bundles");
  await start();
}

main().catch((e) => fail(e?.stack || String(e)));
