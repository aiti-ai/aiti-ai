#!/usr/bin/env node
/**
 * Keep `capabilities/widget-page-control.json` in sync with the permissions Tauri
 * actually ships.
 *
 * The loopback page-control capability is meant to grant every non-destructive core
 * command (window, webview, app, event, image, menu, path, resources, tray) plus the
 * native dialog open/save/ask/confirm/message commands. Tauri upgrades add or rename
 * permissions silently — a missing entry only shows up at runtime as "command not
 * allowed". This script diffs the capability against the ACL manifest Tauri generates
 * during `cargo build`/`cargo test` (target/<profile>/build/*!/out/acl-manifests.json).
 *
 *   node scripts/check-capabilities.mjs            # verify (default --check)
 *   node scripts/check-capabilities.mjs --fix      # rewrite the permission list
 *   node scripts/check-capabilities.mjs --manifest <path/to/acl-manifests.json>
 *
 * Exit codes: 0 in sync, 1 drift, 2 usage/manifest error.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const capabilityPath = join(root, "capabilities", "widget-page-control.json");

/** Core plugins a trusted loopback widget page may drive. */
const CORE_GROUPS = ["app", "event", "image", "menu", "path", "resources", "tray", "webview", "window"];
const PLUGIN_GROUPS = ["dialog"];

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/check-capabilities.mjs [--check|--fix] [--manifest <file>] [--quiet]");
  process.exit(2);
}

const args = process.argv.slice(2);
let mode = "check";
let manifestArg = "";
let quiet = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--check") mode = "check";
  else if (arg === "--fix") mode = "fix";
  else if (arg === "--quiet") quiet = true;
  else if (arg === "--manifest") manifestArg = args[++index] || "";
  else if (arg === "-h" || arg === "--help") usage();
  else usage(`unknown argument: ${arg}`);
}

/** Newest Tauri ACL manifest under target/ (debug and release builds both qualify). */
function findManifest() {
  const candidates = [];
  const targetDir = join(root, "target");
  let profiles;
  try {
    profiles = readdirSync(targetDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return "";
  }
  for (const profile of profiles) {
    const buildDir = join(targetDir, profile.name, "build");
    let builds;
    try {
      builds = readdirSync(buildDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const build of builds) {
      const manifest = join(buildDir, build.name, "out", "acl-manifests.json");
      try {
        candidates.push({ manifest, mtime: statSync(manifest).mtimeMs });
      } catch {
        /* not a Tauri build unit */
      }
    }
  }
  candidates.sort((left, right) => right.mtime - left.mtime);
  return candidates[0]?.manifest || "";
}

const manifestPath = manifestArg ? resolve(manifestArg) : findManifest();
if (!manifestPath) {
  usage("no ACL manifest found — run `cargo build` or `cargo test` first, or pass --manifest");
}

let manifests;
try {
  manifests = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  usage(`cannot read ${manifestPath}: ${error.message}`);
}

const groups = new Set([...CORE_GROUPS.map((group) => `core:${group}`), ...PLUGIN_GROUPS]);
const expected = new Set();
for (const [group, manifest] of Object.entries(manifests)) {
  if (!groups.has(group)) continue;
  for (const name of Object.keys(manifest.permissions || {})) {
    // `allow-*` only: `deny-*` entries would shadow the grants and are never needed here.
    if (!name.startsWith("allow-")) continue;
    expected.add(name.includes(":") ? name : `${group}:${name}`);
  }
}
if (expected.size === 0) usage(`manifest ${manifestPath} lists no permissions for ${[...groups].join(", ")}`);

const capability = JSON.parse(readFileSync(capabilityPath, "utf8"));
const granted = new Set(capability.permissions || []);
const missing = [...expected].filter((permission) => !granted.has(permission)).sort();
const unknown = [...granted].filter((permission) => !expected.has(permission)).sort();

if (mode === "fix") {
  capability.permissions = [...expected].sort();
  writeFileSync(capabilityPath, `${JSON.stringify(capability, null, 2)}\n`);
  if (!quiet) console.log(`[capabilities] wrote ${capability.permissions.length} permissions to capabilities/widget-page-control.json`);
  process.exit(0);
}

if (missing.length === 0 && unknown.length === 0) {
  if (!quiet) console.log(`[capabilities] ✓ ${granted.size} permissions match ${manifestPath.replace(root + "/", "")}`);
  process.exit(0);
}

if (missing.length) console.error(`missing permissions (${missing.length}):\n  ${missing.join("\n  ")}`);
if (unknown.length) console.error(`unknown permissions (${unknown.length}):\n  ${unknown.join("\n  ")}`);
console.error("run `node scripts/check-capabilities.mjs --fix` to rewrite the allow-list");
process.exit(1);
