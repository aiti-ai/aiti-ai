import type { AppInstallInfo, AppInstallMode } from "./api-types";

// App update version helpers.
//
// Version scheme (fork convention, Debian/Ubuntu style):
//   plain upstream version  — "0.15.7"            (legacy releases)
//   fork build suffix       — "0.16.0-aiti.1"     (fork release based on upstream 0.16.0;
//                                                  rebuilds of the same base: -aiti.2, -aiti.3 …)
// Git release tags are `v<version>` and npm dist-tags the same string as `latest`.
//
// Ordering follows dpkg semantics, NOT strict semver: the upstream X.Y.Z core dominates;
// a fork suffix only breaks ties against the bare same version, so "0.16.0-aiti.1" > "0.16.0"
// (strict semver would call the suffix a prerelease and sort it the other way — we own every
// consumer of this comparison, and the dpkg reading is the one that matches release reality).

export const APP_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-aiti\.(\d+))?$/;

interface ParsedAppVersion {
  parts: [number, number, number];
  fork: number; // 0 = bare upstream version, N = fork build number
}

export function parseAppVersion(version: string): ParsedAppVersion | null {
  const match = APP_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1, 4).map(Number) as [number, number, number];
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  const forkRaw = match[4];
  const fork = forkRaw === undefined ? 0 : Number(forkRaw);
  if (!Number.isSafeInteger(fork)) return null;
  return { parts, fork };
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = parseAppVersion(candidate);
  const currentParts = parseAppVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.parts.length; index += 1) {
    if (candidateParts.parts[index] !== currentParts.parts[index]) {
      return candidateParts.parts[index] > currentParts.parts[index];
    }
  }
  // Same upstream core — fork build suffix decides ("0.16.0-aiti.2" > "0.16.0-aiti.1" > "0.16.0").
  return candidateParts.fork > currentParts.fork;
}

// Update-notice links point at the public update guide (version scheme +
// per-install-shape steps) on the docs site. The version argument is still
// validated so callers can keep using a null return as a format check; the
// page itself covers every version. Changelogs remain on GitHub Releases and
// are linked from the guide.
export const PI_WEB_UPDATE_GUIDE_URL = "https://aiti.pw/guide/update.html";

export function getPiWebUpdateGuideUrl(version: string): string | null {
  if (!parseAppVersion(version)) return null;
  return PI_WEB_UPDATE_GUIDE_URL;
}

// ---- Install-shape detection (pure decision part; the IO lives in
// app/api/app-update/route.ts and reuses bin/pi-web-update.js for npm kinds).

export interface AppInstallShape {
  hasReleaseTxt: boolean; // RELEASE.txt in pkgDir — written by release-archive installs only
  hasDockerEnv: boolean; // /.dockerenv present — running inside a container
  hasGitDir: boolean; // pkgDir/.git present — source checkout deployment
  npmKind: "global" | "npx" | "other"; // bin/pi-web-update.js getInstallKind() result
}

export function resolveInstallMode(shape: AppInstallShape): AppInstallMode {
  if (shape.hasReleaseTxt) return "archive";
  if (shape.hasDockerEnv) return "docker";
  if (shape.hasGitDir) return "git";
  if (shape.npmKind === "global") return "npm-global";
  if (shape.npmKind === "npx") return "npx";
  return "other";
}

// Modes `pi-web update` can upgrade in place; the rest get manual guidance.
export function isSelfUpdatableMode(mode: AppInstallMode): boolean {
  return mode === "archive" || mode === "npm-global";
}

export function buildInstallInfo(shape: AppInstallShape): AppInstallInfo {
  const mode = resolveInstallMode(shape);
  return { supported: isSelfUpdatableMode(mode), mode };
}
