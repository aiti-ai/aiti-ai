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

export function getPiWebReleaseUrl(version: string): string | null {
  if (!parseAppVersion(version)) return null;
  return `https://github.com/aiti-ai/aiti-ai/releases/tag/v${version}`;
}
