/**
 * pi-web-ext · dev-pack shared implementation (plan §3.2 / M5: extension dev-pack — src + build tooling + AGENTS.md straight into the deploy dir)
 *
 * Goal: when the user tells the AI in the AI window "help me tweak extension xxx", the AI can work
 * directly in the **deploy dir**:
 *   read AGENTS.md → edit src/ → node tools/build.mjs → curl reload → live in the browser, no round trip to the dev machine.
 *
 * Every extension's tools/deploy.mjs appends the same block at the end (see the sibling deploy.mjs files):
 *   const { packDevPack } = await import("@aiti-ai/ext-shared/dev-pack");
 *   packDevPack({ extRoot: <extension source root>, log: console.log });
 *
 * packDevPack writes into every existing deploy dir (~/.pi/web{,-dev}/extensions/<extId>):
 *   AGENTS.md        copied from the source dir if present, else generated from the template (§3.4)
 *   src/             client/src/**, root-level server sources *.ts/*.cjs/*.mjs, lib/ (vendor skipped), server/, sched/, worker-src/
 *   tools/build.mjs  on-site build entry (the extension's own copied verbatim, else the default esbuild version is generated)
 *   tools/deploy.mjs the deploy script itself (entry point for redeploying from the source repo after big changes)
 *   package.json     with the aitiConfigs declaration and the build script
 *   vite.config.ts   copied if present
 *
 * Idempotent: redeploy overwrites the whole dir. Failures allowed: any exception only logs and never
 * affects the deploy exit code (caller wraps in try/catch).
 */
"use strict";
import { homedir } from "node:os";
import { join, resolve, dirname, basename, sep as pathSep } from "node:path";
import {
  existsSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync,
} from "node:fs";

// Root-level server source files: copied into src/ (flat runtime files at the deploy root stay untouched, host loader paths unchanged)
const ROOT_SRC_EXTS = new Set([".ts", ".tsx", ".cjs", ".mjs"]);
const ROOT_SRC_SKIP = new Set(["dist", "node_modules"]);
// Source subdirs: copied whole (vendor-like large assets skipped — the deploy dir already holds the runtime copy)
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

/** Default AGENTS.md template (§3.4; not reached when the extension ships its own AGENTS.md). Reused by the CLI that batch-generates source-dir versions. */
export function agentsMdTemplate(extId) {
  return `# ${extId} extension (deploy-dir direct-edit guide)

## Layout
- Runtime files sit flat at this dir's root (index.ts / core.cjs …, loaded by the host loader via relative paths — **never hand-edit the flat runtime files**, edit src/ then build)
- \`src/\` sources (client/src + server ts/cjs) · \`dist/\` build output (never hand-edit) · \`tools/\` build/deploy scripts
- npm-package-form extensions: this dir's package.json carries version and the aitiConfigs declaration

## Small on-site changes (copy/style/small logic)
1. Edit the matching source under \`src/\`
2. \`node tools/build.mjs\` (extensions with a client build output; skip for pure server-side changes)
3. \`curl -X POST http://127.0.0.1:3001/api/extensions/reload\` (dev; prod 3002; externally via nginx with basePath: /dev, /mac, /mdev, /win, /wdev → \`/xxx/api/extensions/reload\`)
4. Refresh the browser page to verify

## Big changes go back to the source repo
- Source repo: \`extensions/${extId}/\` (git managed, deploy syncs back into this dir)
- After editing, run \`node tools/deploy.mjs\` in the source repo (or \`node scripts/deploy-all.mjs --only ${extId}\` at the repo root)

## Data dirs (data layering: config / cache)
- \`ctx.configDir\` root = config and key small state (within aiti-configs backup scope; small, precious, human-readable)
- \`ctx.cacheDir\` (= \`<configDir>/cache/\`) = disposable cache: db/venv/logs/large files; after rm -rf the extension rebuilds it automatically on next access
- \`ctx.dataDir\` removed (access throws) — forbidden in new code
- This extension's whitelist (config files never treated as cache) is in package.json \`aitiConfigs.configFiles\`

## Red lines
- No polling (setInterval fetches); to wait, use events/callbacks/SSE (bridge SSE, aiti-event-bus topics)
- Never restart production services (pi-web 3002 etc. restart requires explicit user consent)
- Never hand-edit dist/ or the flat runtime files; cross-extension communication goes through ctx.services (no globalThis.__ext shortcuts)
- Server side: SQLite always WAL + small batched transactions (setImmediate yields between batches); never execFileSync an external program that takes >1s; never read files >8MB synchronously
`;
}

/** Default tools/build.mjs (esbuild single bundle, zero config; not reached when the extension ships its own tools/build.mjs). */
function buildMjsTemplate(extId, extRoot, clientOut, entryRel) {
  // No hardcoded checkout path: candidates are resolved at run time (see the template below).
  return `/**
 * ${extId} · on-site build entry (dev-pack default template, esbuild single bundle, zero config)
 * Usage: node tools/build.mjs
 * Generated by dev-pack; for complex builds (multi-entry/plugin chains) rewrite this file per src/vite.config.ts, or build from the source repo.
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

// esbuild resolution: deploy dir node_modules → source repo node_modules (local dev setup) → esbuild on PATH → fresh npm exec.
// Note: node_modules/esbuild/bin/esbuild is a native binary (ELF/Mach-O) and must be executed directly (cannot be run as JS).
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
    try { accessSync(c, fsConstants.X_OK); return [c]; } catch (e) { /* no exec bit → next source */ }
  }
  const r = spawnSync("esbuild", ["--version"], { encoding: "utf8" });
  if (r.status === 0) return ["esbuild"];
  return ["npm", "exec", "--yes", "esbuild", "--"];
}

function pickEntry() {
  if (entryRel) return entryRel;
  const srcDir = join(extRoot, "src", "client", "src");
  if (!existsSync(srcDir)) throw new Error("client source dir src/client/src not found");
  for (const name of ["entry.tsx", "entry.ts", "entry.jsx", "entry.js", "index.tsx", "index.ts"]) {
    if (existsSync(join(srcDir, name))) return "client/src/" + name;
  }
  const first = readdirSync(srcDir).find((f) => /\\.(tsx?|jsx?)$/.test(f));
  if (!first) throw new Error("no buildable entry under client/src");
  return "client/src/" + first;
}

// Server source sync: src/ root-level files (index.ts/core.cjs/package.json/vite.config.ts etc.) → deploy root
// (server side has no build output — jiti loads the deploy root files directly; without sync, "edit src → reload" never takes effect)
import { readdirSync as _rd, copyFileSync as _cp, statSync as _st } from "node:fs";
const srcRoot = join(extRoot, "src");
if (existsSync(srcRoot)) {
  for (const f of _rd(srcRoot)) {
    const fp = join(srcRoot, f);
    if (!_st(fp).isFile()) continue;
    _cp(fp, join(extRoot, f));
  }
  console.log("[build] server sources synced from src/ to the deploy root");
}

const entry = pickEntry();
const args = [join(extRoot, "src", entry), "--bundle", "--format=esm",
  "--outfile=" + join(extRoot, clientOut), "--jsx=automatic"];
// pi-web host-shim delegation (react → local shim; same for jsx-runtime) — same pattern as the extensions' vite.config
const shim = join(extRoot, "src", "client", "src", "host-shim.ts");
const jsxRuntime = ["jsx-runtime.ts", "jsx-runtime.tsx", "jsx-dev-runtime.ts"].map((f) => join(extRoot, "src", "client", "src", f)).find(existsSync);
if (existsSync(shim)) args.push("--alias:react=" + shim);
if (jsxRuntime) args.push("--alias:react/jsx-runtime=" + jsxRuntime);
args.push("--log-level=info");

const [cmd, ...pre] = findEsbuild();
console.log("[build] esbuild:", cmd, ...pre);
const r = spawnSync(cmd, [...pre, ...args], { stdio: "inherit", cwd: extRoot });
if (r.status !== 0) { console.error("[build] failed — adjust this file per src/vite.config.ts and retry, or build from the source repo"); process.exit(r.status ?? 1); }
console.log("[build] ✓ " + clientOut + " (effective in the browser after reload)");
`;
}

/**
 * Main entry: write the dev-pack into the existing deploy dirs.
 * @param {object} opts
 * @param {string} opts.extRoot   extension source root (pi-web-ext/<extId>)
 * @param {string[]} [opts.targets] explicit deploy dirs; default = ~/.pi/web{,-dev}/extensions/<extId> (existing ones only)
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

  // 1) Pack the sources into a staging area → cpSync per target (no repeated scans across multiple deploy dirs)
  const stage = join(extRoot, "dist", ".dev-pack-staging");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    // src/: root-level source files + source subdirs
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
    // tools/build.mjs: the extension's own copied verbatim, else the default esbuild version is generated
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
        // Fallback: the client output name is usually declared in the entry as client: "dist/<id>-client.mjs" (index.ts) — resolve from the staged src
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

    // 1.5) shared deps: sources now import @aiti-ai/ext-shared (bare specifier);
    // the on-site build resolves it through <webRoot>/node_modules (reconcile),
    // same as any other extension dependency — no _shared copy is staged.

    // 2) Placement (staging → deploy dir; package.json/vite.config.ts written twice: root level per the §3.2 layout, inside src for on-site reading)
    for (const t of targets) {
      cpSync(stage, t, { recursive: true });
      for (const f of ["package.json", "vite.config.ts"]) {
        if (existsSync(join(stage, f))) cpSync(join(stage, f), join(t, f));
      }
    }
    log(`dev-pack → ${targets.map((t) => t.replace(homedir(), "~")).join(", ")} (AGENTS.md + src/ + tools/)`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
