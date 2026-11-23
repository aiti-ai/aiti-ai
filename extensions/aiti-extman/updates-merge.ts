/**
 * Dual-source update verdict (pure functions, no I/O, no deps).
 *
 * npm latest × aiti.pw registry version (× git HEAD/remote) → one state machine used by
 * the extman server. Kept standalone so the matrix can be unit-tested without spawning
 * npm/git or loading the extension entry.
 */

export type UpdateState =
  | "update-available"
  | "up-to-date"
  | "local-ahead"
  | "unpublished"
  | "unsupported"
  | "error"
  | "unknown";

export interface UpdateEntry {
  id: string;
  pkg: string | null;
  installed: string | null;
  npm: { latest: string; hasUpdate: boolean } | null;
  registry: { version: string; hasUpdate: boolean; docsUrl: string | null } | null;
  git: { head: string; remote: string | null; hasUpdate: boolean } | null;
  /** Newest known version (semver) or short git sha when only git advanced. */
  latest: string;
  source: "npm" | "registry" | "both" | "git" | "none";
  state: UpdateState;
  hasUpdate: boolean;
  localAhead: boolean;
  /** Install source for the update action (`npm:<pkg>` / `git:<url>`); null = hint only. */
  installable: string | null;
  message?: string;
}

export interface UpdateMergeInput {
  id: string;
  /** npm package name declared by the installed extension (null when absent/invalid). */
  pkg: string | null;
  installed: string | null;
  npmLatest?: string | null;
  npmError?: string | null;
  registryVersion?: string | null;
  registryDocsUrl?: string | null;
  /** npm name declared by the registry entry (fallback when the install has none). */
  registryNpm?: string | null;
  git?: { head: string; remote: string | null } | null;
  /** Install source of a git-installed extension (git url); null for non-git installs. */
  gitSource?: string | null;
  offline?: boolean;
  /** Registry-only phase: npm/git were not queried, so "up-to-date" cannot be claimed. */
  partial?: boolean;
}

/**
 * Lightweight semver greater-than (x.y.z[-pre]; prerelease compared segment-wise).
 * Non-semver inputs are never "greater" — callers treat them as unavailable.
 */
export function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
  if (pa.pre && pb.pre) {
    const xa = pa.pre.split(".");
    const xb = pb.pre.split(".");
    for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
      const x = xa[i];
      const y = xb[i];
      if (x === undefined) return false;
      if (y === undefined) return true;
      if (/^\d+$/.test(x) && /^\d+$/.test(y)) { const d = Number(x) - Number(y); if (d) return d > 0; }
      else if (x !== y) return x > y;
    }
    return false;
  }
  if (pa.pre) return false; // 1.0.0-alpha < 1.0.0
  if (pb.pre) return true; // 1.0.0 > 1.0.0-alpha
  return false;
}

/** True when the value is a semver version (leading `v` / build metadata tolerated). */
export function isSemver(v: string | null | undefined): v is string {
  return typeof v === "string" && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+.*)?$/.test(v.trim());
}

/**
 * Merge npm × registry (× git) facts into one update verdict.
 *
 * Never switches install sources silently: a git install reports `git:<url>`,
 * an npm install reports `npm:<pkg>`, and a registry-only advance reports
 * `unpublished` with no installable source (npm would install the older version).
 */
export function mergeUpdateSources(input: UpdateMergeInput): UpdateEntry {
  const installed = isSemver(input.installed) ? input.installed : null;
  const npmV = isSemver(input.npmLatest) ? input.npmLatest : null;
  const regV = isSemver(input.registryVersion) ? input.registryVersion : null;
  const git = input.git && input.git.head
    ? { head: input.git.head, remote: input.git.remote ?? null, hasUpdate: !!input.git.remote && input.git.remote !== input.git.head }
    : null;

  const entry: UpdateEntry = {
    id: input.id,
    pkg: input.pkg ?? null,
    installed,
    npm: npmV ? { latest: npmV, hasUpdate: !!installed && semverGt(npmV, installed) } : null,
    registry: regV
      ? { version: regV, hasUpdate: !!installed && semverGt(regV, installed), docsUrl: input.registryDocsUrl ?? null }
      : null,
    git,
    latest: "",
    source: "none",
    state: "unknown",
    hasUpdate: false,
    localAhead: false,
    installable: null,
  };

  if (input.offline) {
    entry.state = "error";
    entry.message = "Update checks are disabled while PI_OFFLINE is set.";
    return entry;
  }
  if (!installed) {
    entry.state = "unsupported";
    entry.message = "Installed version is unavailable.";
    return entry;
  }
  if (!npmV && !regV && !git) {
    entry.state = input.npmError ? "error" : "unsupported";
    entry.message = input.npmError
      ? `npm lookup failed: ${input.npmError}`
      : "No npm package name and no git source metadata; cannot check this install.";
    return entry;
  }

  const npmUp = !!npmV && semverGt(npmV, installed);
  const regUp = !!regV && semverGt(regV, installed);
  const gitUp = !!git?.hasUpdate;
  let newest: string | null = npmV;
  if (regV && (!newest || semverGt(regV, newest))) newest = regV;

  if (npmV && regV) entry.source = npmV === regV ? "both" : semverGt(npmV, regV) ? "npm" : "registry";
  else if (npmV) entry.source = "npm";
  else if (regV) entry.source = "registry";
  else entry.source = "git";

  entry.hasUpdate = npmUp || regUp || gitUp;
  // A partial verdict must not claim "local ahead" either: npm may still be newer.
  entry.localAhead = !input.partial && !entry.hasUpdate && !!newest && semverGt(installed, newest);
  if (newest) entry.latest = newest;
  else if (git) entry.latest = git.head.slice(0, 7);

  if (entry.hasUpdate) {
    entry.state = "update-available";
    const registryLeadsNpm = regUp && (!npmV || semverGt(regV, npmV));
    const gitSource = input.gitSource ?? null;
    // Git installs stay on git and npm installs stay on npm: never switch sources silently.
    if (gitSource) entry.installable = gitSource.startsWith("git:") ? gitSource : `git:${gitSource}`;
    else if (npmUp && !registryLeadsNpm) {
      const npmSource = input.pkg ?? input.registryNpm ?? null;
      if (npmSource) entry.installable = `npm:${npmSource}`;
    }
    if (!entry.installable && registryLeadsNpm && !input.partial) {
      entry.state = "unpublished";
      entry.message = `aiti.pw lists v${regV}${npmV ? ` while npm serves v${npmV}` : " while npm has no release"}; no installable source for the newer version yet.`;
    }
  } else if (entry.localAhead) {
    entry.state = "local-ahead";
  } else if (input.partial) {
    entry.state = "unknown";
  } else {
    entry.state = "up-to-date";
  }
  return entry;
}
