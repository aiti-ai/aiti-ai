#!/usr/bin/env node
/**
 * @aiti-ai/aiti-desktop-widget — native binary resolver for the aiti-desktop-widget shell.
 *
 * The npm package is a tiny launcher: the platform binary lives in GitHub/Gitee
 * release assets and is downloaded on first use with justget (multi-source racing,
 * chunked, checksum-verified) and cached per version/platform.
 *
 * Env:
 *   AITI_DESKTOP_WIDGET_BIN             use this executable path (no download)
 *   AITI_DESKTOP_WIDGET_CACHE_DIR       cache root (default: OS cache dir)
 *   AITI_DESKTOP_WIDGET_RELEASE_BASE    single release base URL (tests/self-hosted mirror)
 *   AITI_DESKTOP_WIDGET_MIRRORS         extra bases, comma-separated
 *   AITI_DESKTOP_WIDGET_REPO            GitHub/Gitee repo (default aiti-ai/aiti-ai)
 *   AITI_DESKTOP_WIDGET_TAG             release tag (default aiti-desktop-widget-v<package version>)
 *   AITI_DESKTOP_WIDGET_VERBOSE=1       per-progress logging
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");
export const VERSION = pkg.version;
const REPO = String(process.env.AITI_DESKTOP_WIDGET_REPO || "aiti-ai/aiti-ai").replace(/^\/+|\/+$/g, "");
export const RELEASE_TAG = String(process.env.AITI_DESKTOP_WIDGET_TAG || `aiti-desktop-widget-v${VERSION}`).trim();

const PLATFORMS = new Map([
  ["linux-x64", "linux-x64"],
  ["linux-arm64", "linux-arm64"],
  ["darwin-x64", "darwin-x64"],
  ["darwin-arm64", "darwin-arm64"],
  ["win32-x64", "win32-x64"],
  ["win32-arm64", "win32-arm64"],
]);

export function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return PLATFORMS.get(key) || null;
}

export function assetName(platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch);
  if (!key) {
    throw new Error(
      `unsupported platform ${platform}/${arch}; supported: ${[...PLATFORMS.keys()].join(", ")}`,
    );
  }
  return `aiti-desktop-widget-${key}${platform === "win32" ? ".exe" : ""}`;
}

export function cacheRoot() {
  const override = String(process.env.AITI_DESKTOP_WIDGET_CACHE_DIR || "").trim();
  if (override) return override;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "aiti-desktop-widget", "cache");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "aiti-desktop-widget");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "aiti-desktop-widget");
}

/** Cached executable path (does not download; respects AITI_DESKTOP_WIDGET_BIN). */
export function binaryPath(platform = process.platform, arch = process.arch) {
  const override = String(process.env.AITI_DESKTOP_WIDGET_BIN || "").trim();
  if (override) return override;
  const key = platformKey(platform, arch);
  if (!key) throw new Error(`unsupported platform ${platform}/${arch}`);
  const exe = platform === "win32" ? "aiti-desktop-widget.exe" : "aiti-desktop-widget";
  return join(cacheRoot(), VERSION, key, exe);
}

function normalizeBase(base) {
  return String(base || "").trim().replace(/\/+$/, "");
}

/** Release base URLs, primary first. GitHub, Gitee, then CORS-free GitHub proxies. */
export function releaseBases() {
  const fixed = normalizeBase(process.env.AITI_DESKTOP_WIDGET_RELEASE_BASE);
  if (fixed) {
    const extra = String(process.env.AITI_DESKTOP_WIDGET_MIRRORS || "")
      .split(",")
      .map(normalizeBase)
      .filter(Boolean);
    return [fixed, ...extra];
  }
  const gh = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}`;
  const gitee = `https://gitee.com/${REPO}/releases/download/${RELEASE_TAG}`;
  const bases = [
    gh,
    gitee,
    `https://gh-proxy.com/${gh}`,
    `https://ghfast.top/${gh}`,
    `https://ghproxy.net/${gh}`,
  ];
  for (const extra of String(process.env.AITI_DESKTOP_WIDGET_MIRRORS || "").split(",")) {
    const base = normalizeBase(extra);
    if (base && !bases.includes(base)) bases.push(base);
  }
  return bases;
}

export function releaseUrls(platform = process.platform, arch = process.arch) {
  const base = normalizeBase(process.env.AITI_DESKTOP_WIDGET_RELEASE_BASE);
  const bases = releaseBases();
  const asset = assetName(platform, arch);
  return {
    tag: RELEASE_TAG,
    asset,
    checksums: bases.map((b) => `${b}/checksums.txt`),
    binary: bases.map((b) => `${b}/${asset}`),
    primary: `${bases[0]}/${asset}`,
    mirrors: bases.slice(1).map((b) => `${b}/${asset}`),
    ...(base ? { selfHosted: true } : {}),
  };
}

function parseChecksum(text, asset) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
    if (!match) continue;
    const name = match[2].trim().replace(/^\.\//, "");
    if (name === asset || name.endsWith(`/${asset}`)) return match[1].toLowerCase();
  }
  return null;
}

let justgetPromise;
async function loadJustget() {
  if (!justgetPromise) {
    justgetPromise = import("justget").catch((error) => {
      throw new Error(
        `justget is required to download the aiti-desktop-widget binary (${error.message}); run: npm install justget`,
      );
    });
  }
  return justgetPromise;
}

function logLine(log, message) {
  if (typeof log === "function") log(message);
}

async function downloadFile({ urls, output, checksum, verbose }) {
  const { download } = await loadJustget();
  const lastPercent = { value: -1 };
  await download({
    url: urls[0],
    mirrors: urls.slice(1),
    output,
    options: {
      // Binaries are ~10 MB: force mirror racing even though justget's default
      // size threshold is 50 MB, and fall back quickly when GitHub is slow.
      sizeThreshold: 0,
      primaryWarmupTime: 1500,
      fastPrimaryThreshold: 0,
      retries: 3,
      retryDelay: 1500,
      connectTimeout: 15000,
      timeout: 300000,
      ...(checksum ? { checksum, checksumAlgorithm: "sha256" } : {}),
      onProgress: verbose
        ? (progress) => {
            const percent = Math.floor(Number(progress.percentage) || 0);
            if (percent >= lastPercent.value + 10) {
              lastPercent.value = percent;
              process.stderr.write(`  ${percent}% ${(progress.speed / 1048576).toFixed(1)} MB/s\n`);
            }
          }
        : undefined,
    },
  });
}

async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      // Windows: an antivirus/indexer can hold the destination briefly.
      if (process.platform !== "win32") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Ensure the platform binary is present and return its path.
 * Downloads once per version/platform; AITI_DESKTOP_WIDGET_BIN bypasses the cache.
 */
export async function ensureBinary({ force = false, log = (message) => process.stderr.write(`${message}\n`) } = {}) {
  const override = String(process.env.AITI_DESKTOP_WIDGET_BIN || "").trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`AITI_DESKTOP_WIDGET_BIN does not exist: ${override}`);
    return override;
  }

  const target = binaryPath();
  if (!force && existsSync(target) && statSync(target).size > 0) {
    if (process.platform !== "win32") {
      try {
        chmodSync(target, 0o755);
      } catch {
        /* best-effort */
      }
    }
    return target;
  }

  const urls = releaseUrls();
  const key = platformKey();
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const verbose = String(process.env.AITI_DESKTOP_WIDGET_VERBOSE || "") === "1";
  log(`aiti-desktop-widget: downloading ${RELEASE_TAG} (${key}) — GitHub/Gitee racing via justget`);

  const checksumsPath = join(dir, "checksums.txt");
  if (!existsSync(checksumsPath)) {
    const tempChecksums = `${checksumsPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await downloadFile({ urls: urls.checksums, output: tempChecksums, verbose });
      await renameWithRetry(tempChecksums, checksumsPath);
    } catch (error) {
      rmSync(tempChecksums, { force: true });
      throw new Error(
        `cannot download checksums.txt for ${RELEASE_TAG}: ${error.message}\n  tried: ${urls.checksums.join("\n         ")}`,
      );
    }
  }
  const checksum = parseChecksum(readFileSync(checksumsPath, "utf8"), urls.asset);
  if (!checksum) {
    throw new Error(`checksums.txt has no sha256 entry for ${urls.asset} (${checksumsPath})`);
  }

  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await downloadFile({ urls: urls.binary, output: temp, checksum, verbose });
    if (!existsSync(temp) || statSync(temp).size === 0) throw new Error("downloaded binary is empty");
    if (process.platform !== "win32") chmodSync(temp, 0o755);
    await renameWithRetry(temp, target);
    log(`aiti-desktop-widget: saved ${target}`);
    return target;
  } catch (error) {
    rmSync(temp, { force: true });
    throw new Error(
      `cannot download ${urls.asset} for ${RELEASE_TAG}: ${error.message}\n  tried: ${urls.binary.join("\n         ")}`,
    );
  }
}

export { parseChecksum };
