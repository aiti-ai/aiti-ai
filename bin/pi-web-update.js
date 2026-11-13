"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync, spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const NPM_LATEST_URL = "https://registry.npmjs.org/@aiti-ai%2Fpi-web/latest";
const FETCH_TIMEOUT_MS = 10_000;
// npm ≥11.16 gates install scripts behind an allowScripts approval; without the
// `--allow-scripts` flag, esbuild/node-pty platform binaries and pi-web's own
// postinstall (patch-package) silently don't run. Older npm ignores the flag.
const MANUAL_COMMAND = "npm install -g @aiti-ai/pi-web@latest --allow-scripts";
const DEFAULT_RELEASE_REPO = "aiti-ai/aiti-ai";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // archives are ~170-200 MB

// Port of lib/app-update.ts (bin cannot import TypeScript).
// Fork version scheme (Debian/Ubuntu style): "0.15.7" (legacy) / "0.16.0-aiti.1" (fork build
// of upstream 0.16.0, rebuilds -aiti.2 …). Tags/npm share the same string as `v<version>`.
// Ordering is dpkg-style: the X.Y.Z core dominates; the suffix only breaks ties against the
// bare version ("0.16.0-aiti.1" > "0.16.0" — NOT semver prerelease ordering; we own every consumer).
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

// Kept as parseStableVersion for the exported name stability; accepts bare and fork-suffixed.
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
  // Same upstream core — fork build suffix decides ("-aiti.2" > "-aiti.1" > bare).
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
  const invocation = findNpmInvocation(["install", "-g", "--allow-scripts", `@aiti-ai/pi-web@${version}`]);
  if (!invocation) return null;
  const result = spawnSync(invocation.command, invocation.args, { stdio: "inherit" });
  return result.status ?? 1;
}

// ---- install channels ----------------------------------------------------
//
// npm global installs and release-archive installs (install.sh / install.ps1
// into ~/.aiti or %LOCALAPPDATA%\aiti) both provide `pi-web update`. RELEASE.txt
// is written by scripts/build-release-archive.mjs into the archive app dir and
// never shipped in the npm package, so its presence marks the archive channel.

function isArchiveInstall(pkgDir, exists = fs.existsSync) {
  return exists(path.join(pkgDir, "RELEASE.txt"));
}

function readReleasePlatform(pkgDir) {
  try {
    const line = fs.readFileSync(path.join(pkgDir, "RELEASE.txt"), "utf8").split(/\r?\n/).find((l) => l.startsWith("platform="));
    return line ? line.slice("platform=".length).trim() : null;
  } catch {
    return null;
  }
}

// ---- archive channel: release sources (GitHub primary, Gitee fallback) ----

function releaseSources(env = process.env) {
  const ghRepo = env.AITI_RELEASE_REPO || DEFAULT_RELEASE_REPO;
  const geRepo = env.AITI_GITEE_REPO || DEFAULT_RELEASE_REPO;
  const mirror = (env.AITI_MIRROR || "auto").toLowerCase();
  const github = { id: `GitHub (${ghRepo})`, url: `https://api.github.com/repos/${ghRepo}/releases/latest` };
  const gitee = { id: `Gitee (${geRepo})`, url: `https://gitee.com/api/v5/repos/${geRepo}/releases/latest` };
  if (mirror === "github") return [github];
  if (mirror === "gitee") return [gitee];
  return [github, gitee];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "pi-web-update" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function defaultFetchBuffer(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "pi-web-update" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchLatestArchiveRelease({ fetchJson: fetchJsonDep = fetchJson, env = process.env } = {}) {
  let lastError;
  for (const source of releaseSources(env)) {
    try {
      const release = await fetchJsonDep(source.url);
      const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
      if (!tag.startsWith("v") || !Array.isArray(release.assets)) {
        throw new Error("release payload missing tag_name/assets");
      }
      return { source: source.id, tag, assets: release.assets };
    } catch (fetchError) {
      lastError = fetchError;
    }
  }
  throw lastError ?? new Error("no release source configured");
}

// Asset naming must match scripts/build-release-archive.mjs: process.platform's
// win32 is published as "win" (linux/darwin keep their names).
function releasePlatform(platform = process.platform) {
  return platform === "win32" ? "win" : platform;
}

function archiveAssetName(tag, { platform = process.platform, arch = process.arch } = {}) {
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return `aiti-web-${tag}-${releasePlatform(platform)}-${arch}.${ext}`;
}

function findAsset(assets, name) {
  return assets.find((asset) => asset?.name === name && typeof asset.browser_download_url === "string") ?? null;
}

// Mirrors the installers: hosts with per-file caps (Gitee: 100 MB) publish
// <name>.part-1..N plus a tiny <name>.split manifest holding the part count.
async function downloadArchiveAsset(assets, name, dest, { fetchBuffer: fetch = defaultFetchBuffer } = {}) {
  const splitAsset = findAsset(assets, `${name}.split`);
  if (splitAsset) {
    const manifest = (await fetch(splitAsset.browser_download_url)).toString("utf8");
    const parts = Number.parseInt(manifest.replace(/\D/g, ""), 10);
    if (!parts || parts < 1) throw new Error(`invalid split manifest for ${name}`);
    const chunks = [];
    for (let index = 1; index <= parts; index += 1) {
      const part = findAsset(assets, `${name}.part-${index}`);
      if (!part) throw new Error(`split part ${index}/${parts} of ${name} is missing`);
      chunks.push(await fetch(part.browser_download_url));
    }
    fs.writeFileSync(dest, Buffer.concat(chunks));
    return { split: parts };
  }
  const asset = findAsset(assets, name);
  if (!asset) throw new Error(`asset ${name} not found in the release`);
  fs.writeFileSync(dest, await fetch(asset.browser_download_url));
  return { split: 0 };
}

// sha256sum on Linux; shasum ships with macOS; certutil ships with Windows.
function sha256File(file, { platform = process.platform, spawnSync: spawn = spawnSync } = {}) {
  const attempts =
    platform === "win32"
      ? [["certutil", ["-hashfile", file, "SHA256"]]]
      : [["sha256sum", [file]], ["shasum", ["-a", "256", file]]];
  for (const [command, args] of attempts) {
    const result = spawn(command, args, { encoding: "utf8" });
    if (result.status !== 0) continue;
    if (command === "certutil") {
      const hex = (result.stdout || "").replace(/\s/g, "");
      const match = /[0-9a-f]{64}/i.exec(hex);
      if (match) return match[0].toLowerCase();
      continue;
    }
    const hash = (result.stdout || "").split(/\s+/)[0].toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  throw new Error("no usable sha256 tool found (sha256sum/shasum/certutil)");
}

function extractArchive(archivePath, destDir, { platform = process.platform, env = process.env, spawnSync: spawn = spawnSync } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar (System32 tar on Windows, /usr/bin/tar on macOS) auto-detects the
  // format from the bytes, so -xf handles both tar.gz and zip. GNU tar on
  // Linux auto-detects compression with -xf as well.
  const tar =
    platform === "win32"
      ? path.join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const result = spawn(tar, ["-xf", archivePath, "-C", destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`extract failed: ${(result.stderr || result.stdout || `tar exited ${result.status}`).trim().slice(-300)}`);
  }
}

// Keep the launcher entry (PATH symlink / .cmd shim) pointing at the new dir.
// POSIX candidates are only repointed when they currently launch THIS install
// (their symlink resolves to the old entry) — a machine may host several
// installs and an unrelated launcher must not be hijacked.
function repointLauncher(newAppDir, {
  platform = process.platform,
  argv1 = process.argv[1],
  env = process.env,
  homedir = os.homedir(),
  oldEntry,
  realpath = fs.realpathSync,
  lstat = fs.lstatSync,
  readlink = fs.readlinkSync,
  unlink = fs.unlinkSync,
  symlink = fs.symlinkSync,
  writeFileSync: writeFile = fs.writeFileSync,
  log = console.log,
} = {}) {
  const entry = path.join(newAppDir, "bin", "pi-web.js");
  if (platform !== "win32") {
    const oldTarget = oldEntry ? realpathOrSelf(oldEntry, realpath) : null;
    const candidates = new Set();
    if (argv1) candidates.add(path.resolve(argv1));
    candidates.add(path.join(env.AITI_BIN_DIR || path.join(homedir, ".local", "bin"), "pi-web"));
    for (const link of candidates) {
      try {
        if (!lstat(link).isSymbolicLink()) continue;
        const linkTarget = readlink(link);
        const resolved = realpathOrSelf(
          path.isAbsolute(linkTarget) ? linkTarget : path.join(path.dirname(link), linkTarget),
          realpath,
        );
        if (oldTarget && resolved !== oldTarget) continue; // launches a different install
        unlink(link);
        symlink(entry, link);
        log(`Launcher updated: ${link} -> ${entry}`);
        return;
      } catch {
        // not a symlink, unreadable or not writable — try the next candidate
      }
    }
    log(`Add a launcher if needed:  ln -sfn ${entry} ~/.local/bin/pi-web`);
    return;
  }
  const shimDir = path.join(env.LOCALAPPDATA || path.join(homedir, "AppData", "Local"), "Microsoft", "WindowsApps");
  const shim = path.join(shimDir, "pi-web.cmd");
  const content = `@node "${entry}" %*\r\n`;
  if (/[^\x00-\x7F]/.test(content)) {
    // cmd reads the shim in the OEM codepage; a non-ASCII install path would
    // corrupt there. The installer has the same limitation (Default encoding).
    writeFile(shim, content, "utf8");
    log(`Shim updated: ${shim} (path contains non-ASCII characters — verify it runs)`);
    return;
  }
  try {
    fs.mkdirSync(shimDir, { recursive: true });
    writeFile(shim, content, "utf8");
    log(`Shim updated: ${shim}`);
  } catch (writeError) {
    log(`Could not update the shim automatically (${writeError.message}). Run with: node "${entry}"`);
  }
}

async function runArchiveUpdate({
  check,
  currentVersion,
  pkgDir,
  listRecords,
  formatRecord,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  argv1 = process.argv[1],
  homedir = os.homedir(),
  fetchLatestRelease = fetchLatestArchiveRelease,
  fetchBuffer = defaultFetchBuffer,
  spawnSync: spawn = spawnSync,
  exists = fs.existsSync,
  rm = fs.rmSync,
  realpath = fs.realpathSync,
  log = console.log,
  error = console.error,
}) {
  let release;
  try {
    release = await fetchLatestRelease({ env });
  } catch (fetchError) {
    error(`Could not check for updates: ${fetchError.message}`);
    return 1;
  }
  const latest = release.tag.replace(/^v/, "");
  if (!isNewerStableVersion(latest, currentVersion)) {
    log(`pi-web ${currentVersion} is up to date  (${release.source}, release ${release.tag}).`);
    return 0;
  }
  log(`pi-web ${latest} is available  (${release.source}, release ${release.tag}; installed: ${currentVersion}).`);
  if (check) return 0;

  // A running `next start` has .next/ open; never replace it underneath.
  const running = await listRecords();
  if (running.length > 0) {
    error(`pi-web is running:\n${running.map(formatRecord).join("\n")}\nRun \`pi-web stop\` first, then update.`);
    return 1;
  }

  const builtPlatform = readReleasePlatform(pkgDir);
  const wantedPlatform = `${releasePlatform(platform)}-${arch}`;
  if (builtPlatform && builtPlatform !== wantedPlatform) {
    log(`Note: this install was built for ${builtPlatform}; downloading ${wantedPlatform} for the current machine.`);
  }

  const assetName = archiveAssetName(release.tag, { platform, arch });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-update-"));
  try {
    log(`Downloading ${assetName} ...`);
    const archivePath = path.join(workDir, assetName);
    const { split } = await downloadArchiveAsset(release.assets, assetName, archivePath, { fetchBuffer });
    if (split) log(`  reassembled from ${split} part(s)`);

    const checksumAsset = findAsset(release.assets, "checksums.txt");
    if (checksumAsset) {
      const checksums = (await fetchBuffer(checksumAsset.browser_download_url)).toString("utf8");
      const want = checksums.split(/\r?\n/).find((line) => line.trimEnd().endsWith(assetName));
      const got = sha256File(archivePath, { platform, spawnSync: spawn });
      if (want && want.split(/\s+/)[0].toLowerCase() !== got) {
        throw new Error(`sha256 mismatch (want ${want.split(/\s+/)[0]}, got ${got})`);
      }
      log("sha256 verified");
    } else {
      log("checksums.txt not published for this release — skipping verification");
    }

    const extractDir = path.join(workDir, "extract");
    extractArchive(archivePath, extractDir, { platform, env, spawnSync: spawn });
    const newAppDir = path.join(extractDir, "aiti-web");
    if (!exists(path.join(newAppDir, "bin", "pi-web.js"))) {
      throw new Error("archive layout unexpected: aiti-web/bin/pi-web.js missing after extract");
    }

    const realPkgDir = realpathOrSelf(pkgDir, realpath);
    const installRoot = path.dirname(realPkgDir);
    const targetDir = path.join(installRoot, `aiti-web-${release.tag}`);
    if (exists(targetDir)) rm(targetDir, { recursive: true, force: true });
    try {
      fs.renameSync(newAppDir, targetDir);
    } catch (renameError) {
      if (renameError.code !== "EXDEV") throw renameError;
      fs.cpSync(newAppDir, targetDir, { recursive: true });
      rm(newAppDir, { recursive: true, force: true });
    }
    repointLauncher(targetDir, { platform, argv1, env, homedir, oldEntry: path.join(realPkgDir, "bin", "pi-web.js"), log });
    try {
      rm(realPkgDir, { recursive: true, force: true });
    } catch {
      log(`Could not remove the previous install at ${realPkgDir} (delete it manually to free ~800 MB).`);
    }
    log(`pi-web updated to ${latest}. Start it with: pi-web`);
    return 0;
  } catch (updateError) {
    error(`Update failed: ${updateError.message}`);
    return 1;
  } finally {
    rm(workDir, { recursive: true, force: true });
  }
}

async function runUpdate(options) {
  if (isArchiveInstall(options.pkgDir, options.exists)) {
    return runArchiveUpdate(options);
  }
  return runNpmUpdate(options);
}

async function runNpmUpdate({
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

module.exports = {
  archiveAssetName,
  findNpmInvocation,
  fetchLatestArchiveRelease,
  getInstallKind,
  isArchiveInstall,
  isNewerStableVersion,
  releasePlatform,
  runUpdate,
  sha256File,
};
