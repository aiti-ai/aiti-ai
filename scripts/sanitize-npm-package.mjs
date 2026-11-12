#!/usr/bin/env node
// sanitize-npm-package.mjs — scrub build-machine absolute paths out of .next before npm pack/publish.
//
// Next.js bakes absolute paths (outputFileTracingRoot, NFT file lists, build trace,
// generated types, server chunks) into .next at build time. On a dev machine those paths
// leak the local username/directory layout into the published npm tarball, defeating the
// repo-level sanitization (dev home → /home/pi). Runs as part of `prepack`, so both
// release paths are covered:
//   - in-place `npm publish` at the repo root (paths: the repo tree itself)
//   - scripts/build-bundled-package.mjs (git-archive staging dir under /tmp)
// Neutral replacement target is /home/pi/workspace/aiti-ai — the same fictional path the
// docs and the fork-sync sanitization already use.
//
// Scope: text files under .next only. Build telemetry (trace/trace-build/diagnostics) is
// excluded from the package via package.json `files` and needs no rewriting here.

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const nextDir = join(root, ".next");
if (!existsSync(nextDir)) {
  console.log("[sanitize] no .next — nothing to do");
  process.exit(0);
}

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".map", ".txt", ".html", ".css"]);
// Extensionless text files in .next (build traces are NDJSON)
const TEXT_NAME = new Set(["trace", "trace-build", "BUILD_ID"]);
const MAX_BYTES = 32 * 1024 * 1024;

// Order matters: structural rules built-in (repo root / staging / generic homes), machine-specific values
// loaded from ~/.aiti/release-redact.json (CI: env AITI_RELEASE_REDACT). Missing config → structural rules only.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function loadPrivConfig() {
  const raw = process.env.AITI_RELEASE_REDACT;
  if (raw) {
    try { return JSON.parse(raw); } catch { console.error("[sanitize] AITI_RELEASE_REDACT 不是合法 JSON——忽略"); }
  }
  try { return JSON.parse(readFileSync(join(homedir(), ".aiti", "release-redact.json"), "utf8")); }
  catch { return null; }
}
const PRIV = loadPrivConfig();
if (!PRIV) console.warn("[sanitize] 未找到 ~/.aiti/release-redact.json——机器特定路径规则为空（结构性规则仍生效）");
const replacements = [
  { re: new RegExp(esc(root), "g"), to: "/home/pi/workspace/aiti-ai" },
  { re: /\/home\/runner/g, to: "/home/pi" },
  { re: /\/root\/workspace/g, to: "/home/pi/workspace" },
  { re: /\/tmp\/aiti-pack-[^"'`)\s,;:)]*/g, to: "/home/pi/workspace/aiti-ai" },
  ...(PRIV?.redact ?? []).map((r) => ({ re: new RegExp(r.find, r.flags || "g"), to: r.replace })),
];

let scanned = 0;
let rewritten = 0;
let hits = 0;

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    const dot = e.name.lastIndexOf(".");
    if (!(TEXT_NAME.has(e.name) || (dot > 0 && TEXT_EXT.has(e.name.slice(dot))))) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.size > MAX_BYTES) continue;
    scanned++;
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue; // binary or undecodable — leave untouched
    }
    let out = text;
    let n = 0;
    for (const { re, to } of replacements) {
      out = out.replace(re, () => {
        n += 1;
        return to;
      });
    }
    if (n > 0) {
      writeFileSync(p, out);
      rewritten++;
      hits += n;
    }
  }
}

walk(nextDir);
console.log(`[sanitize] .next scanned=${scanned} rewritten=${rewritten} pathRefsNeutralized=${hits}`);
