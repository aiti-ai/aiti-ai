// App update version helpers.
//
// Version scheme (fork convention, Debian/Ubuntu style — shared with aiti-ai releases):
//   plain upstream version  — "0.15.7"            (legacy)
//   fork build suffix       — "0.16.0-aiti.1"     (fork build of upstream 0.16.0; rebuilds -aiti.2 …)
// The @aiti-ai/pi-web npm dist-tag `latest` carries the same string.
//
// Ordering follows dpkg semantics, NOT strict semver: the upstream X.Y.Z core dominates;
// the fork suffix only breaks ties against the bare same version ("0.16.0-aiti.1" > "0.16.0").

const APP_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-aiti\.(\d+))?$/;

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
  const candidateParsed = parseAppVersion(candidate);
  const currentParsed = parseAppVersion(current);
  if (!candidateParsed || !currentParsed) return false;

  for (let index = 0; index < candidateParsed.parts.length; index += 1) {
    if (candidateParsed.parts[index] !== currentParsed.parts[index]) {
      return candidateParsed.parts[index] > currentParsed.parts[index];
    }
  }
  // Same upstream core — fork build suffix decides ("0.16.0-aiti.2" > "0.16.0-aiti.1" > "0.16.0").
  return candidateParsed.fork > currentParsed.fork;
}

// Release link points at the fork's own npm release page (aiti-ai has no GitHub releases);
// the full version is kept as-is so fork builds (0.16.0-aiti.1) link to their actual release.
export function getPiWebReleaseUrl(version: string): string | null {
  if (!parseAppVersion(version)) return null;
  return `https://www.npmjs.com/package/@aiti-ai/pi-web/v/${version}`;
}
