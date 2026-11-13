import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import type { AppInstallInfo, AppUpdateResponse } from "@/lib/api-types";
import { buildInstallInfo, getPiWebUpdateGuideUrl, isNewerStableVersion } from "@/lib/app-update";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const NPM_LATEST_URL = "https://registry.npmjs.org/@aiti-ai%2Fpi-web/latest";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1";
const DEFAULT_RELEASE_REPO = "aiti-ai/aiti-ai";

// RELEASE.txt is only written into release-archive installs (install.sh /
// install.ps1 channel); npm installs never ship it. Same channel marker as
// bin/pi-web-update.js.
const IS_ARCHIVE_INSTALL = existsSync(join(process.cwd(), "RELEASE.txt"));

// App dir as the launcher sees it: startServer injects PI_WEB_PKG_DIR; direct
// `next dev` runs (systemd etc.) fall back to cwd.
const PKG_DIR = process.env.PI_WEB_PKG_DIR || process.cwd();

// bin/pi-web-update.js is plain CJS and holds the npm-kind detection we reuse
// (findNpmInvocation / getInstallKind). Loaded once per process via
// createRequire so the Next bundler never tries to trace it.
interface BinUpdateModule {
  findNpmInvocation: (args: string[]) => { command: string; args: string[] } | null;
  getInstallKind: (options: { pkgDir: string; npmRoot: string | null }) => "global" | "npx" | "other";
}

let binUpdateModule: BinUpdateModule | null | undefined;
function loadBinUpdateModule(): BinUpdateModule | null {
  if (binUpdateModule !== undefined) return binUpdateModule;
  try {
    binUpdateModule = createRequire(join(PKG_DIR, "package.json"))("./bin/pi-web-update.js") as BinUpdateModule;
  } catch {
    binUpdateModule = null; // non-standard layouts just fall through to "other"
  }
  return binUpdateModule;
}

const execFileAsync = promisify(execFile);

// `npm root -g` costs a process spawn; resolve once per server process.
let npmRootPromise: Promise<string | null> | undefined;
function getNpmRootAsync(): Promise<string | null> {
  npmRootPromise ??= (async () => {
    const invocation = loadBinUpdateModule()?.findNpmInvocation(["root", "-g"]);
    if (!invocation) return null;
    try {
      const { stdout } = await execFileAsync(invocation.command, invocation.args, { timeout: 30_000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  })();
  return npmRootPromise;
}

async function detectInstallInfo(): Promise<AppInstallInfo> {
  const hasReleaseTxt = existsSync(join(PKG_DIR, "RELEASE.txt"));
  const hasDockerEnv = existsSync("/.dockerenv");
  const hasGitDir = existsSync(join(PKG_DIR, ".git"));
  let npmKind: "global" | "npx" | "other" = "other";
  if (!hasReleaseTxt && !hasDockerEnv && !hasGitDir) {
    const npmRoot = await getNpmRootAsync();
    npmKind = loadBinUpdateModule()?.getInstallKind({ pkgDir: PKG_DIR, npmRoot }) ?? "other";
  }
  return buildInstallInfo({ hasReleaseTxt, hasDockerEnv, hasGitDir, npmKind });
}

interface AppUpdateCache {
  value?: AppUpdateResponse;
  expiresAt: number;
  inFlight?: Promise<AppUpdateResponse>;
}

declare global {
  var __piWebAppUpdateCache: AppUpdateCache | undefined;
}

function getCache(): AppUpdateCache {
  return globalThis.__piWebAppUpdateCache ??= { expiresAt: 0 };
}

async function fetchJson(url: string): Promise<{ tag_name?: unknown; assets?: unknown }> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`release source returned HTTP ${response.status}`);
  return response.json();
}

// Release-archive channel: GitHub releases primary, Gitee mirror fallback
// (same source chain as the installers and `pi-web update`).
async function fetchArchiveLatestRelease() {
  const ghRepo = process.env.AITI_RELEASE_REPO || DEFAULT_RELEASE_REPO;
  const geRepo = process.env.AITI_GITEE_REPO || DEFAULT_RELEASE_REPO;
  const mirror = (process.env.AITI_MIRROR || "auto").toLowerCase();
  const sources =
    mirror === "github"
      ? [`https://api.github.com/repos/${ghRepo}/releases/latest`]
      : mirror === "gitee"
        ? [`https://gitee.com/api/v5/repos/${geRepo}/releases/latest`]
        : [
            `https://api.github.com/repos/${ghRepo}/releases/latest`,
            `https://gitee.com/api/v5/repos/${geRepo}/releases/latest`,
          ];
  let lastError: unknown;
  for (const url of sources) {
    try {
      const release = await fetchJson(url);
      const tag = typeof release.tag_name === "string" ? release.tag_name : "";
      if (!tag.startsWith("v")) throw new Error("release payload missing tag_name");
      return tag;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no release source configured");
}

async function fetchLatestVersion(): Promise<AppUpdateResponse> {
  if (IS_ARCHIVE_INSTALL) {
    const tag = await fetchArchiveLatestRelease();
    const latestVersion = tag.slice(1);
    return {
      currentVersion: CURRENT_VERSION,
      latestVersion,
      updateAvailable: isNewerStableVersion(latestVersion, CURRENT_VERSION),
      releaseUrl: getPiWebUpdateGuideUrl(latestVersion) ?? "",
    };
  }

  const response = await fetch(NPM_LATEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

  const body = await response.json() as { version?: unknown };
  const latestVersion = typeof body.version === "string" ? body.version : "";
  const releaseUrl = getPiWebUpdateGuideUrl(latestVersion);
  if (!releaseUrl) throw new Error("npm registry returned an invalid version");

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerStableVersion(latestVersion, CURRENT_VERSION),
    releaseUrl,
  };
}

async function loadUpdateStatus(): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchLatestVersion().then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.value) return cache.value;
    throw error;
  }
}

export async function GET() {
  const install = await detectInstallInfo();
  if (SKIP_VERSION_CHECK) {
    return NextResponse.json({
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      updateAvailable: false,
      releaseUrl: "",
      install,
    } satisfies AppUpdateResponse);
  }
  try {
    return NextResponse.json({ ...(await loadUpdateStatus()), install });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
