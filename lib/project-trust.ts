import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  type ProjectTrustStoreEntry,
} from "@earendil-works/pi-coding-agent";
import type { ProjectTrustStatus } from "./api-types";
import { samePath } from "./paths";

/** The folder as `trust.json` keys it: resolved, then its real path when it exists. */
function trustKeyPath(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function describeDecision(
  cwd: string,
  entry: ProjectTrustStoreEntry | null,
): Pick<ProjectTrustStatus, "decision" | "decisionPath" | "inherited"> {
  if (!entry) return { decision: null, inherited: false };
  return {
    decision: entry.decision,
    decisionPath: entry.path,
    inherited: !samePath(entry.path, trustKeyPath(cwd)),
  };
}

/**
 * Whether the project at `cwd` needs trust and is trusted, and the decision
 * that answers it. The store resolves the nearest decision, exact or
 * inherited from an ancestor, so `decision` and `decisionPath` tell exact
 * trust from trust through a parent, and no decision from an explicit `false`,
 * which `trusted` alone cannot. They are read for a folder that requires no
 * trust too: a fresh folder (no decision anywhere) and one inside a trusted
 * tree both report `trusted: true`. Such a folder never failed on an
 * unreadable `trust.json` before, and callers that only need `trusted` still
 * must not, so that failure is reported in `decisionError` instead.
 */
export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  const trustStore = new ProjectTrustStore(agentDir);
  if (!requiresTrust) {
    if (!cwd) return { requiresTrust: false, trusted: true, decision: null, inherited: false };
    try {
      return { requiresTrust: false, trusted: true, ...describeDecision(cwd, trustStore.getEntry(cwd)) };
    } catch (error) {
      return {
        requiresTrust: false,
        trusted: true,
        decision: null,
        inherited: false,
        decisionError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const entry = trustStore.getEntry(cwd);
  return {
    requiresTrust: true,
    trusted: entry?.decision === true,
    ...describeDecision(cwd, entry),
  };
}

// Hot reload re-evaluates this module; globalThis keeps one warning per error per process.
const TRUST_READ_WARNINGS_KEY: symbol = Symbol.for("pi-web:project-trust-read-warnings");
const TRUST_READ_WARNINGS_MAX = 200;

/**
 * Whether the trust-gated configuration of the project at `cwd` (its
 * `.pi/mcp.json`) may be read right now: true only while the folder requires
 * trust and a decision, exact or inherited, trusts it. The folder's resources
 * and `trust.json` are read on every call, so a decision made anywhere (the
 * trust dialog, the pi CLI) and a `.pi/` resource that appeared since (`git
 * pull`, `pi mcp add -l`, the model's write tool) count at once. That is what
 * a per-wrapper `SettingsManager.isProjectTrusted()` cannot give: it is fixed
 * when the wrapper is built, `true` for a folder that needed no trust then,
 * and refreshed only on reload.
 *
 * A folder that requires no trust gets `false`, although its status reads
 * `trusted: true`. It has no `.pi/mcp.json` — that file alone makes a folder
 * require trust — so nothing is lost, while `true` would let the caller read a
 * file that landed between this check and its own read with no decision at all.
 *
 * A `trust.json` that cannot be read (unparsable, or still locked by another
 * process after the store's ~200 ms synchronous wait) counts as untrusted, with
 * one warning per distinct error.
 */
export function mayReadProjectConfigNow(cwd: string, agentDir: string): boolean {
  try {
    // Not getProjectTrustStatus(): that also reads trust.json for a folder that
    // requires no trust, which this answers false whatever its decision. Twice
    // per prompt, that would lock and read trust.json for nothing.
    if (!cwd || !hasTrustRequiringProjectResources(cwd)) return false;
    return new ProjectTrustStore(agentDir).get(cwd) === true;
  } catch (error) {
    const trustPath = join(agentDir, "trust.json");
    const message = error instanceof Error ? error.message : String(error);
    const store = globalThis as Record<symbol, Set<string> | undefined>;
    const warned = (store[TRUST_READ_WARNINGS_KEY] ??= new Set());
    const key = `${trustPath}\0${message}`;
    if (!warned.has(key)) {
      if (warned.size >= TRUST_READ_WARNINGS_MAX) warned.clear();
      warned.add(key);
      // A lock error does not name the file, so the path is always given.
      console.warn(`[pi-web] cannot read project trust from ${trustPath}; projects that need it count as untrusted meanwhile: ${message}`);
    }
    return false;
  }
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  // Built from what was just written, not read back: a second read can fail
  // (the lock held past the store's wait), and the route would then report a
  // decision already on disk as a failure and skip rebuilding the cwd's wrappers.
  return { requiresTrust: true, trusted: true, decision: true, decisionPath: trustKeyPath(cwd), inherited: false };
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true, so
 * denying trust keeps them dormant.
 *
 * Pi Web and the `pi` CLI share the same trust store. Projects with gated
 * resources default to untrusted until either client records a trust decision.
 * Returns `undefined` when the project has no trust-requiring resources,
 * leaving ordinary projects on their existing load path.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  if (!cwd || !hasTrustRequiringProjectResources(cwd)) return undefined;
  const trustStore = new ProjectTrustStore(agentDir);
  return { resolveProjectTrust: async () => trustStore.get(cwd) === true };
}
