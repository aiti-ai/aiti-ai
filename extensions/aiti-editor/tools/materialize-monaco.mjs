#!/usr/bin/env node
// materialize-monaco.mjs — materialize Monaco Editor AMD assets (min/vs) into the
// extension directory so the browser can actually fetch /assets/monaco/vs/loader.js.
//
// Why: monaco-editor is a devDependency used ONLY as an asset source (its min/vs AMD
// bundle is served verbatim by the host registry); it never enters client bundles.
// tools/deploy.mjs copies it at deploy time (syncMonaco), but other distribution
// channels ship the extension tree without extension node_modules — and therefore
// without the assets:
//   - bundled inside the @aiti-ai/pi-web npm package (files excludes */node_modules)
//   - the standalone @aiti-ai/aiti-editor npm package (extman registry installs)
//   - docker build staging (rsync excludes node_modules; deploy-extensions.sh installs
//     on demand, but a silently failed install ships a broken editor)
// Without the assets the editor 404s: "Monaco loader.js fetch fail".
//
// Wired as this extension's package.json `prepack` (self-contained npm package) and
// re-invoked by the root package's tools/materialize-ext-assets.mjs (bundled tree).
//
// Usage:
//   node tools/materialize-monaco.mjs [extDir]   # default: this extension's source dir
//                                                # (pass the runtime dir to repair an
//                                                #  installed copy in place)
//
// Source resolution (first hit wins):
//   1. <extDir>/node_modules/monaco-editor/min/vs      (dev install — same version as local deploys)
//   2. node_modules/monaco-editor/min/vs walking up from <extDir> (hoisted install)
//   3. npm pack monaco-editor@<devDependencies spec> → temp dir (CI trees, bare checkouts)
//
// Idempotency mirrors deploy.mjs syncMonaco: fingerprint = md5(min/vs/editor/editor.main.js)[0:8]
// stamped at <extDir>/monaco/.version; a matching stamp (plus loader.js present) skips the
// copy, so a later deploy.mjs syncMonaco run stays a no-op. Output is gitignored and
// regenerable.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extSrc = resolve(scriptDir, "..");
const extDir = resolve(process.argv[2] || extSrc);
const MONACO_DEP = "monaco-editor";

function monacoSpec() {
  try {
    const pj = JSON.parse(readFileSync(join(extDir, "package.json"), "utf8"));
    return pj.devDependencies?.[MONACO_DEP] || pj.dependencies?.[MONACO_DEP] || "latest";
  } catch {
    return "latest";
  }
}

function findLocalVs(startDir) {
  let cur = startDir;
  for (;;) {
    const cand = join(cur, "node_modules", MONACO_DEP, "min", "vs");
    if (existsSync(join(cand, "loader.js"))) return cand;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function vsFromNpmPack(spec) {
  const tmp = join(tmpdir(), `aiti-monaco-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  // npm is npm.cmd on Windows; spawnSync without shell can't exec .cmd directly.
  // args array (no shell) keeps "^" ranges safe on every platform.
  // npm lifecycle context: flags of the parent npm command leak in as npm_config_* env
  // (e.g. `npm pack --dry-run` sets npm_config_dry_run=true, which would dry-run our
  // nested pack too — no tarball). Strip those and force the flag off explicitly.
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  delete env.npm_config_json;
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const pack = spawnSync(npmBin, ["pack", `${MONACO_DEP}@${spec}`, "--pack-destination", tmp, "--no-dry-run", "--loglevel=error"], { encoding: "utf8", env });
  if (pack.status !== 0) throw new Error(`npm pack ${MONACO_DEP}@${spec} failed: ${(pack.stderr || pack.stdout || "").slice(-300)}`);
  const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no tarball");
  const x = spawnSync("tar", ["xzf", join(tmp, tgz), "-C", tmp], { encoding: "utf8" });
  if (x.status !== 0) throw new Error(`tar extract failed: ${(x.stderr || "").slice(-200)}`);
  const vs = join(tmp, "package", "min", "vs");
  if (!existsSync(join(vs, "loader.js"))) throw new Error("monaco tarball has no min/vs/loader.js");
  return { vs, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function monacoFingerprint(vsDir) {
  const f = join(vsDir, "editor", "editor.main.js");
  if (!existsSync(f)) throw new Error("monaco min/vs incomplete (no editor/editor.main.js)");
  return createHash("md5").update(readFileSync(f)).digest("hex").slice(0, 8);
}

let cleanup = null;
try {
  let srcVs = findLocalVs(extDir);
  if (!srcVs) {
    const r = vsFromNpmPack(monacoSpec());
    srcVs = r.vs;
    cleanup = r.cleanup;
  }
  const fp = monacoFingerprint(srcVs);
  const stampFile = join(extDir, "monaco", ".version");
  const outVs = join(extDir, "monaco", "vs");
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === fp && existsSync(join(outVs, "loader.js"))) {
    console.log(`[materialize-monaco] assets up to date (${fp}) → skip`);
  } else {
    // plain rm+cp: materialization runs at pack/build time, offline from page traffic —
    // deploy.mjs's atomic-rename dance is only needed for live runtime dirs.
    rmSync(outVs, { recursive: true, force: true });
    mkdirSync(dirname(outVs), { recursive: true });
    cpSync(srcVs, outVs, { recursive: true });
    const fd = openSync(stampFile, "w");
    writeFileSync(fd, fp);
    closeSync(fd);
    console.log(`[materialize-monaco] monaco/vs → ${outVs} (${fp}${srcVs.startsWith(tmpdir()) ? " · via npm pack" : ""})`);
  }
} catch (e) {
  console.error(`[materialize-monaco] FAILED: ${String(e?.message || e)}`);
  process.exitCode = 1;
} finally {
  try { cleanup?.(); } catch { /* ignore */ }
}
