#!/usr/bin/env node
// materialize-shared.mjs — materialize _shared sibling copies into extension dirs.
//
// The deploy pipeline (each extension's tools/deploy.mjs) copies a handful of
// extensions/_shared/<file> helpers into the extension directory as sibling
// files (e.g. aiti-editor requires "./soffice-locate"). The GitHub Releases
// build has no deploy pipeline and npm pack excludes extensions/_shared, so a
// fresh install from the release archive misses those files and the extensions
// fail to load. This script scans each extension's sources for relative
// references ("./x") that resolve only against _shared, and copies the file in
// — generic parity with deploy.mjs, future-proof for new references.
//
// Usage: node scripts/materialize-shared.mjs [repoRoot]
// Exit 0 always (best-effort materialization; broken refs unrelated to _shared
// are logged, not fatal).

import { readdirSync, readFileSync, existsSync, copyFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || new URL("..", import.meta.url).pathname);
const extRoot = join(root, "extensions");
const sharedDir = join(extRoot, "_shared");
if (!existsSync(sharedDir)) {
  console.log("[materialize] no extensions/_shared — nothing to do");
  process.exit(0);
}
const sharedFiles = new Set(readdirSync(sharedDir).filter((f) => /\.(ts|mjs|cjs|js)$/.test(f)));

// Relative references only: require("./x"), import ... from "./x", import("./x").
// Skip "./" paths that go up or into subdirs of other packages (../x, /abs, pkg
// specifiers) — those are not _shared sibling candidates.
const REF_RE = /(?:require\(\s*|import\s*\(\s*|import\s+[^"';]*?from\s+)["']\.\/([^"']+?)["']/g;
const TRY_SUFFIXES = ["", ".ts", ".mjs", ".cjs", ".js", ".tsx"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".build-root", ".local-pkgs"]);

function listSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listSources(join(dir, e.name), out);
    } else if (/\.(ts|mjs|cjs|js|tsx)$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

let copied = 0;
const exts = readdirSync(extRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "_shared");
for (const ext of exts) {
  const extDir = join(extRoot, ext.name);
  for (const src of listSources(extDir)) {
    let text;
    try {
      text = readFileSync(src, "utf8");
    } catch {
      continue;
    }
    const srcDir = join(src, ".."); // relative refs resolve against the referencing file's dir
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(text))) {
      if (m[1].includes("?")) continue; // vite "?raw" etc. — bundled into dist at build time
      const rel = m[1];
      for (const suf of TRY_SUFFIXES) {
        const target = join(srcDir, rel + suf);
        if (existsSync(target)) break; // resolves fine already (tracked sibling / build-time asset)
        const base = rel + suf;
        if (!sharedFiles.has(base) || !existsSync(join(sharedDir, base))) continue;
        copyFileSync(join(sharedDir, base), target);
        copied++;
        console.log(`[materialize] ${ext.name}: _shared/${base} -> ${target.replace(extRoot + "/", "")}  (ref: ${src.replace(extRoot + "/", "")})`);
        break;
      }
    }
  }
}
console.log(`[materialize] done: ${copied} file(s) copied into ${exts.length} extension dirs`);
