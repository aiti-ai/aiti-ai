"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync, spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const NPM_LATEST_URL = "https://registry.npmjs.org/@aiti-ai%2Fpi-web/latest";
const FETCH_TIMEOUT_MS = 10_000;
const MANUAL_COMMAND = "npm install -g @aiti-ai/pi-web@latest";

// Port of lib/app-update.ts (bin cannot import TypeScript).
// Fork build suffix support (aiti-ai npm dist-tags "X.Y.Z-aiti.N", Debian/Ubuntu style).
// dpkg-style ordering: the X.Y.Z core dominates; the suffix only breaks ties against the
// bare version ("0.16.0-aiti.1" > "0.16.0").
const APP_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-aiti\.(\d+))?$/;

function parseAppVersion(version) {
  const match = APP_VERSION_PATTERN.exec(version);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  const forkRaw = match[4];
  const fork = forkRaw === undefined ? 0 : Number(forkRaw);
  return Number.isSafeInteger(fork) ? { parts, fork } : null;
}

function parseStableVersion(version) {
  return parseAppVersion(version);
}

function isNewerStableVersion(candidate, current) {
  const candidateParsed = parseAppVersion(candidate);
  const currentParsed = parseAppVersion(current);
  if (!candidateParsed || !currentParsed) return false;
  for (let index = 0; index < candidateParsed.parts.length; index += 1) {
    if (candidateParsed.parts[index] !== currentParsed.parts[index]) {
      return candidateParsed.parts[index] > currentParsed.parts[index];
    }
  }
  return candidateParsed.fork > currentParsed.fork;
}

async function fetchLatestVersion() {
  const response = await fetch(NPM_LATEST_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const { version } = await response.json();
  if (typeof version !== "string" || !parseStableVersion(version)) {
    throw new Error("npm registry returned an invalid version");
  }
  return version;
}

// npm's own CLI script run through this node, so no shell is needed on
// Windows (same lookup as lib/node-cli.ts). null: no way to run npm safely.
function findNpmInvocation(args, nodeDir = path.dirname(process.execPath), platform = process.platform, exists = fs.existsSync) {
  for (const script of [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (exists(script)) return { command: process.execPath, args: [script, ...args] };
  }
  return platform === "win32" ? null : { command: "npm", args };
}

function realpathOrSelf(target, realpath = fs.realpathSync) {
  try {
    return realpath(target);
  } catch {
    return path.resolve(target);
  }
}

// "global": pkgDir is <npm root -g>/@aiti-ai/pi-web; "npx": an npx cache; else "other".
function getInstallKind({ pkgDir, npmRoot, realpath = fs.realpathSync }) {
  const realPkgDir = realpathOrSelf(pkgDir, realpath);
  if (realPkgDir.split(/[\\/]/).includes("_npx")) return "npx";
  if (!npmRoot) return "other";
  const inGlobalRoot =
    path.basename(realPkgDir) === "pi-web" &&
    path.basename(path.dirname(realPkgDir)) === "@aiti-ai" &&
    realpathOrSelf(path.dirname(path.dirname(realPkgDir)), realpath) === realpathOrSelf(npmRoot, realpath);
  return inGlobalRoot ? "global" : "other";
}

function getGlobalNpmRoot() {
  const invocation = findNpmInvocation(["root", "-g"]);
  if (!invocation) return null;
  try {
    return execFileSync(invocation.command, invocation.args, { encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

function runNpmInstall(version) {
  const invocation = findNpmInvocation(["install", "-g", `@aiti-ai/pi-web@${version}`]);
  if (!invocation) return null;
  const result = spawnSync(invocation.command, invocation.args, { stdio: "inherit" });
  return result.status ?? 1;
}

async function runUpdate({
  check,
  currentVersion,
  pkgDir,
  listRecords,
  formatRecord,
  fetchLatest = fetchLatestVersion,
  getNpmRoot = getGlobalNpmRoot,
  install = runNpmInstall,
  realpath = fs.realpathSync,
  log = console.log,
  error = console.error,
}) {
  let latest;
  try {
    latest = await fetchLatest();
  } catch (fetchError) {
    error(`Could not check for updates: ${fetchError.message}`);
    return 1;
  }
  if (!isNewerStableVersion(latest, currentVersion)) {
    log(`pi-web ${currentVersion} is up to date.`);
    return 0;
  }
  log(`pi-web ${latest} is available (installed: ${currentVersion}).`);
  if (check) return 0;

  // A running `next start` has .next/ open; never replace it underneath.
  const running = await listRecords();
  if (running.length > 0) {
    error(`pi-web is running:\n${running.map(formatRecord).join("\n")}\nRun \`pi-web stop\` first, then update.`);
    return 1;
  }

  const kind = getInstallKind({ pkgDir, npmRoot: getNpmRoot(), realpath });
  if (kind === "npx") {
    error("This pi-web runs from the npx cache. Run `npx @aiti-ai/pi-web@latest` instead.");
    return 1;
  }
  if (kind !== "global") {
    error(`This pi-web is not a global npm install. Update it yourself, for example: ${MANUAL_COMMAND}`);
    return 1;
  }

  const code = install(latest);
  if (code === null) {
    error(`Could not find npm. Run: ${MANUAL_COMMAND}`);
    return 1;
  }
  return code;
}

module.exports = { findNpmInvocation, getInstallKind, isNewerStableVersion, runUpdate };
