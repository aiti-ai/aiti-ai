#!/usr/bin/env node
/**
 * check-pi-plugin-pins.mjs — calibrate `pi-plugins.manifest.json` against a registry and
 * verify that every published first-party plugin tarball actually ships its runtime files.
 *
 * Why
 * ---
 * pi-web provisions the first-party pi plugins from exact pins in the manifest, and nothing
 * writes that manifest except humans, so pins drift from the registry. Separately, a package
 * can be published with a `files` field that silently drops runtime sources (a dynamic
 * `import("../lib/x.ts")` stayed local-only while the npm build shipped `src` only) — the
 * loader degrades quietly, so npm users get less than dev users without any error anywhere.
 *
 * Checks
 * ------
 * 1. pin exists on the target registry          → ERROR (users cannot install it; ETARGET)
 * 2. pin vs registry latest / local version     → WARN  (release calibration)
 * 3. packed-import closure: every relative import inside `npm pack` output must resolve to
 *    another packed file                        → ERROR (published package is incomplete)
 *
 * Usage
 * -----
 *   node scripts/check-pi-plugin-pins.mjs [--target official|staging] [--write] [--strict] [--json]
 *     --target  registry channel (default official; staging reads ~/.aiti/release-redact.json)
 *     --write   rewrite pins to the newest installable version: the local package version when
 *               it is already published, otherwise the registry latest. Ordering matters —
 *               publish a plugin before raising its pin, or `npm install` fails with ETARGET.
 *     --strict  fail on drift warnings too (release gate)
 *     --json    machine-readable report
 *
 * Exit codes: 0 clean, 1 hard errors (or warnings with --strict).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO, "pi-plugins.manifest.json");
const PLUGIN_ROOT = join(REPO, "pi-plugins");
const DEFAULT_REGISTRIES = {
  official: "https://registry.npmjs.org/",
  // staging resolves from the private config below; the URL never lives in the repo
  staging: "",
};

// ---------------------------------------------------------------- arguments

export function parseArgs(argv) {
  const args = { target: "official", write: false, strict: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--target") args.target = argv[++i] || args.target;
    else if (a === "--write") args.write = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!["official", "staging"].includes(args.target)) throw new Error(`unknown --target: ${args.target}`);
  return args;
}

/** Registry base URL for the requested channel. Staging is private config only (never literal). */
export function resolveRegistry(target, env = process.env, home = homedir()) {
  if (target === "official") return DEFAULT_REGISTRIES.official;
  const raw = env.AITI_RELEASE_REDACT;
  let priv = null;
  if (raw) {
    try { priv = JSON.parse(raw); } catch { priv = null; }
  }
  if (!priv) {
    try { priv = JSON.parse(readFileSync(join(home, ".aiti", "release-redact.json"), "utf8")); }
    catch { priv = null; }
  }
  const url = priv?.stagingRegistry || env.AITI_STAGING_REGISTRY;
  if (!url) throw new Error("staging registry not configured (AITI_RELEASE_REDACT / AITI_STAGING_REGISTRY)");
  return url;
}

// ---------------------------------------------------------------- registry

async function fetchPackument(registry, name) {
  const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null; // package not on this registry yet
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
  return res.json();
}

/** name → { versions:Set<string>, latest:string|null, tarballs:Map<version,url> } */
export async function loadRegistryInfo(registry, names) {
  const out = new Map();
  for (const name of names) {
    let doc = null;
    try { doc = await fetchPackument(registry, name); } catch (error) {
      out.set(name, { error: error.message, versions: new Set(), latest: null, tarballs: new Map() });
      continue;
    }
    const versions = new Set(Object.keys(doc?.versions || {}));
    const latest = doc?.["dist-tags"]?.latest || null;
    const tarballs = new Map();
    for (const [v, meta] of Object.entries(doc?.versions || {})) {
      if (meta?.dist?.tarball) tarballs.set(v, meta.dist.tarball);
    }
    out.set(name, { versions, latest, tarballs });
  }
  return out;
}

// ---------------------------------------------------------------- pin planning

/** Minimal semver compare (no dependency): returns -1 / 0 / 1. Prereleases sort below releases. */
export function semverCmp(a, b) {
  const split = (v) => {
    const [core, ...pre] = String(v).split("+")[0].split("-");
    return { core: core.split(".").map((n) => Number(n) || 0), pre: pre.join("-") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.core[i] || 0) - (y.core[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre === y.pre ? 0 : x.pre > y.pre ? 1 : -1;
}

/**
 * Pure decision table: one row per manifest entry.
 * status: ok | drift | pending-release | local-stale | unpublished | unknown
 */
export function planUpdates(plugins, registryInfo, localVersions) {
  return (plugins || []).map((p) => {
    const info = registryInfo.get(p.pkg);
    const pin = String(p.version || "");
    const latest = info?.latest || null;
    const local = localVersions.get(p.pkg) || null;
    const published = info ? info.versions.has(pin) : null;
    let status = "ok";
    let nextPin = pin;
    if (info?.error) status = "unknown";
    else if (published === false) {
      status = "unpublished";
      if (latest) nextPin = latest;
    } else if (local && !info?.versions.has(local)) {
      // A local version that is not published yet is either ahead of the registry (bump in
      // flight — publish it before raising the pin) or behind it (the registry moved ahead,
      // which happens when CI auto-bumps during publish without committing the bump back).
      if (latest && semverCmp(local, latest) < 0) {
        status = "local-stale";
        nextPin = latest;
      } else {
        status = "pending-release";
        nextPin = pin;
      }
    } else if (local && local !== pin) {
      status = "drift";
      nextPin = local; // local version is published → follow it
    } else if (latest && latest !== pin) {
      status = "drift";
      nextPin = latest;
    }
    return { pkg: p.pkg, pin, latest, local, auto: p.auto !== false, status, nextPin, error: info?.error || null };
  });
}

// ---------------------------------------------------------------- pack closure

const SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/;
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", "/index.ts", "/index.js"];

const stripQuery = (s) => s.split("?")[0].split("#")[0];

/**
 * Find relative imports that leave the packed file set.
 * `files` = [{ path, text }] in npm-pack order (paths use forward slashes, package-relative).
 */
export function findBrokenImports(files) {
  const packed = new Set(files.map((f) => f.path));
  const problems = [];
  for (const file of files) {
    if (!SOURCE_RE.test(file.path) || typeof file.text !== "string") continue;
    for (const match of file.text.matchAll(SPEC_RE)) {
      const spec = match[1];
      const base = posix.normalize(posix.join(posix.dirname(file.path), spec));
      const candidates = RESOLVE_SUFFIXES.map((suffix) => base + suffix);
      if (candidates.some((c) => packed.has(c))) continue;
      problems.push({ file: file.path, spec, resolved: base });
    }
  }
  return problems;
}

/** Pack the local plugin dir in memory (npm pack --dry-run) and return packaged text files. */
export function packLocal(dir) {
  const res = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir, encoding: "utf8", timeout: 120_000,
  });
  if (res.status !== 0) throw new Error(`npm pack failed in ${dir}: ${(res.stderr || "").trim().split("\n")[0]}`);
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch { throw new Error(`npm pack returned no JSON in ${dir}`); }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = [];
  for (const f of entry?.files || []) {
    const abs = join(dir, f.path);
    let text = null;
    try { text = readFileSync(abs, "utf8"); } catch { /* binary or unreadable — closure check skips it */ }
    files.push({ path: f.path.replace(/\\/g, "/"), text });
  }
  return { name: entry?.name, version: entry?.version, files };
}

/** name → local package dir (pi-plugins/<dir>/package.json) */
export function localPackageDirs(root = PLUGIN_ROOT) {
  const out = new Map();
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    if (!existsSync(join(dir, "package.json"))) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (typeof pkg.name === "string") out.set(pkg.name, { dir, version: pkg.version });
    } catch { /* ignore unreadable package.json */ }
  }
  return out;
}

// ---------------------------------------------------------------- reporting

const ICON = { ok: "=", drift: "~", unpublished: "!", "pending-release": "^", "local-stale": ">", unknown: "?" };
const LABEL = {
  ok: "up to date",
  drift: "drift (pin != newest installable)",
  unpublished: "pin is NOT on the registry",
  "pending-release": "local version ahead of the registry — publish first",
  "local-stale": "repo version behind the registry (CI auto-bump not committed)",
  unknown: "registry lookup failed",
};

export function formatReport(rows, packProblems) {
  const lines = [];
  for (const r of rows) {
    const detail = [
      `pin ${r.pin}`,
      `latest ${r.latest ?? "-"}`,
      `local ${r.local ?? "-"}`,
      r.auto ? "" : "manual",
    ].filter(Boolean).join(" · ");
    lines.push(`${ICON[r.status] || "?"} ${r.pkg.padEnd(30)} ${LABEL[r.status] || r.status} — ${detail}`);
  }
  for (const p of packProblems) {
    lines.push(`! ${p.pkg}: packed import escapes the tarball — ${p.file} → "${p.spec}" (missing ${p.resolved})`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/check-pi-plugin-pins.mjs [--target official|staging] [--write] [--strict] [--json]");
    return 0;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  const registry = resolveRegistry(args.target);
  const registryInfo = await loadRegistryInfo(registry, plugins.map((p) => p.pkg));
  const local = localPackageDirs();
  const localVersions = new Map([...local].map(([name, info]) => [name, info.version]));
  const rows = planUpdates(plugins, registryInfo, localVersions);

  // Packed-import closure for every plugin that lives in this repo.
  const packProblems = [];
  for (const r of rows) {
    const info = local.get(r.pkg);
    if (!info) continue;
    let packed;
    try { packed = packLocal(info.dir); } catch (error) {
      packProblems.push({ pkg: r.pkg, file: "(pack)", spec: error.message, resolved: "" });
      continue;
    }
    for (const p of findBrokenImports(packed.files)) packProblems.push({ pkg: r.pkg, ...p });
  }

  const hardErrors = rows.filter((r) => r.status === "unpublished")
    .concat(rows.filter((r) => r.status === "unknown"));
  const warnings = rows.filter((r) => r.status === "drift" || r.status === "pending-release" || r.status === "local-stale");
  const failed = hardErrors.length > 0 || packProblems.length > 0 || (args.strict && warnings.length > 0);

  if (args.write) {
    let changed = 0;
    for (const row of rows) {
      const entry = plugins.find((p) => p.pkg === row.pkg);
      if (!entry || row.nextPin === row.pin) continue;
      if (typeof entry.note === "string") entry.note = entry.note.split(row.pin).join(row.nextPin);
      entry.version = row.nextPin;
      changed += 1;
    }
    if (changed > 0) {
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
      if (!args.json) console.log(`[pins] rewrote ${changed} pin(s) in pi-plugins.manifest.json`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ registry, target: args.target, rows, packProblems, failed }, null, 2));
  } else {
    console.log(`registry: ${registry}`);
    console.log(formatReport(rows, packProblems));
    const pending = rows.filter((r) => r.status === "pending-release");
    const stale = rows.filter((r) => r.status === "local-stale");
    if (pending.length) console.log(`\nnote: ${pending.map((r) => r.pkg).join(", ")} — publish the local version first, then rerun with --write.`);
    if (stale.length) console.log(`note: ${stale.map((r) => r.pkg).join(", ")} — committed version lags the registry; --write follows the published version.`);
    console.log(failed ? `\nFAILED (${hardErrors.length} pin error(s), ${packProblems.length} pack error(s))` : "\nOK");
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[pins] ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}
