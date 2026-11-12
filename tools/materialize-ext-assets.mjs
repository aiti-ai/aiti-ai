#!/usr/bin/env node
// materialize-ext-assets.mjs — materialize deploy-time copies into extensions/ so the
// npm package (@aiti-ai/pi-web) is self-contained.
//
// The source-repo deploy.mjs scripts do three kinds of "deploy-time materialization" that
// the git-mirrored extensions/ tree lacks (deploy materializes INTO the runtime dir,
// while the repo tree stays lean):
//   1. per-extension icons — copyIcons(dest/"icons", [names]) from _shared/icons/*.svg
//      (the host loader embeds these server-side: icon: "icons/<name>.svg" in item meta)
//   2. _shared single-file copies, e.g. _shared/soffice-locate.ts → aiti-editor/,
//      _shared/ext-protocol.mjs → aiti-extman/ (index.ts imports them relatively)
// This script re-runs both materializations over the mirrored tree, derived from each
// extension's own tools/deploy.mjs (no hardcoded per-extension table).
//
// Wired as the root package.json `prepack` — every npm pack/publish gets a complete
// tree. Idempotent; untracked output (gitignored).
import { readdirSync, readFileSync, existsSync, mkdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extRoot = join(root, "extensions");
const shared = join(extRoot, "_shared");

let copied = 0, missing = [];

// 1. icons: parse `copyIcons(..., ["a", "b"], ...)` from each extension's deploy.mjs
for (const name of readdirSync(extRoot)) {
  const deploy = join(extRoot, name, "tools", "deploy.mjs");
  if (!existsSync(deploy)) continue;
  const text = readFileSync(deploy, "utf8");
  // icon list = the array literal in the copyIcons call (first arg varies:
  // resolve(dir,"icons") / join(dest,"icons") / resolve(t,"icons") — non-greedy to the
  // first [ ... ] pair; names may carry or omit the .svg suffix)
  for (const m of text.matchAll(/copyIcons\([\s\S]*?\[([^\]]*)\]/g)) {
    const icons = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1].replace(/\.svg$/, ""));
    if (!icons.length) continue;
    const dstDir = join(extRoot, name, "icons");
    mkdirSync(dstDir, { recursive: true });
    for (const icon of icons) {
      const src = join(shared, "icons", `${icon}.svg`);
      if (!existsSync(src)) { missing.push(`${name}: icons/${icon}.svg`); continue; }
      copyFileSync(src, join(dstDir, `${icon}.svg`));
      copied++;
    }
  }
  // 2. _shared single-file copies — both spellings:
  //    resolve(root, "..", "_shared", "<file>") | resolve(root, '../_shared/<file>')
  for (const m of text.matchAll(/_shared["'],\s*["']([^"']+)["']|_shared\/([a-zA-Z0-9._-]+)/g)) {
    const file = m[1] || m[2];
    if (!file || file.includes("..") || !file.includes(".")) continue; // "icons" etc. are dir copies, not files
    const src = join(shared, file);
    if (!existsSync(src) || !statSync(src).isFile()) { missing.push(`${name}: _shared/${file}`); continue; }
    copyFileSync(src, join(extRoot, name, file));
    copied++;
  }
  // 3. intra-extension copies: resolve(extSrc, ..., "<file>") → resolve(extDir, "<name>")
  //    (e.g. aiti-devtools resolve(extSrc, 'server', 'pair-fed.ts') → pair-fed.ts;
  //    index.ts imports it as "./pair-fed.js" and jiti resolves the .ts)
  for (const m of text.matchAll(/resolve\(extSrc,([^)]*)\),\s*resolve\(extDir,\s*["']([^"']+)["']\)/g)) {
    const segs = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    if (!segs.length) continue;
    const rel = segs[segs.length - 1];
    const src = join(extRoot, name, ...segs);
    if (!existsSync(src) || !statSync(src).isFile()) { missing.push(`${name}: ${segs.join("/")}`); continue; }
    copyFileSync(src, join(extRoot, name, rel));
    copied++;
  }
}

// 4. strip extension package-lock.json files — they pin private-registry resolutions
//    (@aiti-ti/ddns etc. via lockfile-only references) that 404 on the official registry
//    and break the runtime dependency reconcile; the runtime installs from the
//    package.json ranges alone
let locks = 0;
for (const name of readdirSync(extRoot)) {
  const lock = join(extRoot, name, "package-lock.json");
  if (existsSync(lock)) { rmSync(lock); locks++; }
}

console.log(`[materialize] ${copied} files materialized, ${locks} package-lock.json stripped from extensions/` +
  (missing.length ? ` — MISSING: ${missing.join(", ")}` : ""));
if (missing.length) process.exitCode = 1;
