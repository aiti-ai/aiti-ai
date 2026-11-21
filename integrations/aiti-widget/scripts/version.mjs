#!/usr/bin/env node
/**
 * Keep the aiti-widget version in sync across Cargo.toml, Cargo.lock,
 * tauri.conf.json, Info.plist and the npm launcher.
 *
 *   node scripts/version.mjs --print
 *   node scripts/version.mjs --check [--tag aiti-widget-v0.2.0]
 *   node scripts/version.mjs --set 0.3.0
 *   node scripts/version.mjs --bump patch|minor|major
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  cargo: join(root, "Cargo.toml"),
  lock: join(root, "Cargo.lock"),
  tauri: join(root, "tauri.conf.json"),
  plist: join(root, "Info.plist"),
  npm: join(root, "npm", "package.json"),
};

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const opt = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};

function fail(message) {
  console.error(`aiti-widget version: ${message}`);
  process.exit(1);
}

function cargoVersion() {
  const text = readFileSync(files.cargo, "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) fail("Cargo.toml has no package version");
  return match[1];
}

function jsonVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function plistVersion() {
  const text = readFileSync(files.plist, "utf8");
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
  if (!match) fail("Info.plist has no CFBundleShortVersionString");
  return match[1];
}

function versions() {
  return {
    cargo: cargoVersion(),
    tauri: jsonVersion(files.tauri),
    plist: plistVersion(),
    npm: jsonVersion(files.npm),
  };
}

function check(tag) {
  const current = versions();
  const unique = new Set(Object.values(current));
  if (unique.size !== 1) {
    fail(`version drift: ${Object.entries(current).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  const version = current.cargo;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`version ${version} is not plain X.Y.Z`);
  if (tag && tag !== `aiti-widget-v${version}`) {
    fail(`tag ${tag} != aiti-widget-v${version}`);
  }
  console.log(`ok: aiti-widget ${version}${tag ? ` (tag ${tag})` : ""}`);
  return version;
}

function writeIfChanged(path, next) {
  const old = readFileSync(path, "utf8");
  if (old === next) return false;
  writeFileSync(path, next);
  return true;
}

function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`--set expects X.Y.Z, got ${version}`);
  // Cargo.toml — first package version only.
  const cargo = readFileSync(files.cargo, "utf8");
  writeIfChanged(files.cargo, cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`));

  // Cargo.lock — package entry (cargo would rewrite it on the next build anyway).
  if (existsSync(files.lock)) {
    const lock = readFileSync(files.lock, "utf8");
    const next = lock.replace(
      /(name = "aiti-widget"\r?\nversion = ")[^"]+(")/,
      `$1${version}$2`,
    );
    writeIfChanged(files.lock, next);
  }

  for (const path of [files.tauri, files.npm]) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.version = version;
    writeIfChanged(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  // Keep the npm lockfile's root metadata in sync (npm ci reads it).
  const lockPath = join(root, "npm", "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeIfChanged(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }

  const plist = readFileSync(files.plist, "utf8");
  const nextPlist = plist
    .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${version}$2`)
    .replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
      `$1${version}$2`,
    );
  writeIfChanged(files.plist, nextPlist);

  console.log(`aiti-widget version -> ${version}`);
  console.log(`next: git add integrations/aiti-widget && git commit -m "release(widget): v${version}"`);
  console.log(`      git tag aiti-widget-v${version} && git push origin main --tags`);
}

function bump(kind) {
  const [major, minor, patch] = cargoVersion().split(".").map(Number);
  if (kind === "major") setVersion(`${major + 1}.0.0`);
  else if (kind === "minor") setVersion(`${major}.${minor + 1}.0`);
  else if (kind === "patch") setVersion(`${major}.${minor}.${patch + 1}`);
  else fail("--bump expects patch|minor|major");
}

if (has("--check")) check(opt("--tag"));
else if (has("--set")) setVersion(opt("--set"));
else if (has("--bump")) bump(opt("--bump"));
else if (has("--print")) console.log(cargoVersion());
else {
  console.log(`aiti-widget ${cargoVersion()} (cargo/tauri/plist/npm: ${JSON.stringify(versions())})`);
  console.log("usage: --print | --check [--tag TAG] | --set X.Y.Z | --bump patch|minor|major");
}
