#!/usr/bin/env node
/**
 * check-external-deps — verify that external @aiti-ai/* dependencies (packages
 * living OUTSIDE this monorepo, e.g. @aiti-ai/content-share in its own repo)
 * have a version on the target registry satisfying every floor declared by the
 * tree (extensions / pi-plugins / packages / integrations / root package.json).
 *
 * Release SOP: run before pushing (staging) and before dispatching the official
 * CI chain (official). Unsatisfiable floors = the consumer would 404 on install.
 *
 * Usage: node scripts/check-external-deps.mjs [--target staging|official] [--dispatch] [--json]
 *   --target staging   → https://npm.alot.pw (default)
 *   --target official  → https://registry.npmjs.org
 *   --dispatch         → `gh workflow run` the owning repo's publish workflow for
 *                        each missing dependency (default: print the command only)
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = { staging: "https://npm.alot.pw", official: "https://registry.npmjs.org" };
const args = process.argv.slice(2);
const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : "staging";
const dispatch = args.includes("--dispatch");
if (!REGISTRY[target]) {
  console.error(`unknown --target: ${target} (staging | official)`);
  process.exit(2);
}
const registry = REGISTRY[target];

const root = dirname(dirname(fileURLToPath(import.meta.url))); // repo root, independent of cwd
const scope = "@aiti-ai/";

/** In-tree package names (anything declared here is NOT external). */
const inTree = new Set();
const dirsToScan = [];
for (const group of ["extensions", "pi-plugins", "packages", "integrations"]) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "_shared") continue;
    const pkgPath = join(dir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    dirsToScan.push(pkgPath);
    // _shared-style nested packages (e.g. extensions/<x>/_shared) are rare; one level deep is enough here.
  }
}
const nestedShared = join(root, "extensions", "_shared", "package.json");
if (existsSync(nestedShared)) dirsToScan.push(nestedShared);
dirsToScan.push(join(root, "package.json"));

for (const pkgPath of dirsToScan) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name) inTree.add(pkg.name);
  } catch { /* skip unreadable */ }
}

/** name → [{ spec, consumer }] for every @aiti-ai/* dependency outside the tree. */
const external = new Map();
for (const pkgPath of dirsToScan) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { continue; }
  const deps = { ...(pkg.dependencies || {}) };
  const rel = pkgPath.slice(root.length + 1);
  for (const [name, spec] of Object.entries(deps)) {
    if (!name.startsWith(scope) || inTree.has(name)) continue;
    if (!external.has(name)) external.set(name, []);
    external.get(name).push({ spec: String(spec), consumer: rel });
  }
}

if (!external.size) {
  console.log("[check-external-deps] no external @aiti-ai/* dependencies declared — nothing to check");
  process.exit(0);
}

/** Minimal semver floor check for the range styles this repo uses (^, >=, exact). */
function satisfies(range, version) {
  const m = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(String(range).trim());
  if (!m) return true; // unknown range styles (tags/*) — let npm decide
  const [, maj, min, pat] = m.map(Number);
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!v) return false;
  const [vm, vi, vp] = v.slice(1).map(Number);
  if (String(range).trim().startsWith("^")) return vm === maj && (vi > min || (vi === min && vp >= pat));
  return vm === maj && vi === min && vp >= pat;
}

function versionsOnRegistry(name) {
  const out = execFileSync("npm", ["view", name, "versions", "--json", "--registry", registry], {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const missing = [];
const lines = [];
for (const [name, consumers] of [...external.entries()].sort()) {
  const floors = [...new Set(consumers.map((c) => c.spec))];
  let versions = [];
  try {
    versions = versionsOnRegistry(name);
  } catch (err) {
    lines.push(`✗ ${name} — not on ${registry} (${(err.stderr || err.message || "").toString().trim().slice(0, 80)})`);
    missing.push({ name, consumers, hint: true });
    continue;
  }
  const unsatisfied = floors.filter((spec) => !versions.some((v) => satisfies(spec, v)));
  if (!unsatisfied.length) {
    lines.push(`✓ ${name} ${floors.join(", ")} — satisfied on ${registry} (latest ${versions[versions.length - 1]})`);
  } else {
    lines.push(`✗ ${name} — floor ${unsatisfied.join(", ")} NOT satisfiable on ${registry} (latest ${versions[versions.length - 1]})`);
    missing.push({ name, consumers, floors: unsatisfied, hint: true });
  }
}

for (const line of lines) console.log(line);

if (missing.length) {
  console.error(`\n[check-external-deps] ${missing.length} external dependency floor(s) not on ${registry}`);
  for (const m of missing) {
    const repo = m.name.slice(scope.length);
    const run = `gh workflow run publish-npm.yml --ref main -R aiti-ai/${repo} -f dry_run=false`;
    const local = `cd ../${repo} && npm publish --registry ${registry}`;
    console.error(`  ${m.name} (${m.floors?.join(", ") || "absent"}) — consumers: ${[...new Set(m.consumers.map((c) => c.consumer))].join(", ")}`);
    console.error(`    publish via CI: ${run}`);
    console.error(`    or locally:     ${local}`);
    if (dispatch) {
      try {
        execFileSync("gh", ["workflow", "run", "publish-npm.yml", "--ref", "main", "-R", `aiti-ai/${repo}`, "-f", "dry_run=false"], { stdio: "inherit" });
        console.error(`  dispatched publish for ${repo} — re-run this check once it lands`);
      } catch (err) {
        console.error(`  dispatch failed: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
  if (!dispatch) console.error(`\n(re-run with --dispatch to trigger the owning repos' publish workflows)`);
  process.exit(1);
}
console.log(`\n[check-external-deps] all external floors satisfied on ${registry}`);
