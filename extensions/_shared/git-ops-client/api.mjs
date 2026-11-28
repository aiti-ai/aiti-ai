/**
 * git-ops-client · REST wrapper (plan docs/aiti-git-ops-shared-plan.md §2).
 *
 * Shared via bundle-source inlining by the two extensions (session-manager / aiti-folder; built at
 * build time, ext-float-dock pattern).
 * apiUrl is injected by the consumer (exposed via host-shim, basePath-aware); everything is POST +
 * JSON body (cwd never lands in a URL).
 * Returns a uniform { status, data }; network failure → { status: 0, data: { ok:false, error } } — never throws.
 */
const BASE = "/api/extensions/aiti-git-ops/git";

export function createGitOpsApi({ apiUrl = (p) => p, fetchImpl = (...a) => fetch(...a) } = {}) {
  const call = async (path, body) => {
    try {
      const res = await fetchImpl(apiUrl(BASE + path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
      return { status: res.status, data };
    } catch (e) {
      return { status: 0, data: { ok: false, error: e instanceof Error ? e.message : String(e) } };
    }
  };
  return {
    refs: (cwd) => call("/refs", { cwd }),
    log: (cwd, cursor, opts) => call("/log", { cwd, cursor: cursor || 0, ...(opts && typeof opts === "object" ? opts : {}) }),
    tags: (cwd) => call("/tags", { cwd }),
    checkout: (cwd, ref, mode) => call("/checkout", { cwd, ref, mode }),
    branchCreate: (cwd, name, from, checkout = true) => call("/branch-create", { cwd, name, from, checkout }),
    branchDelete: (cwd, name) => call("/branch-delete", { cwd, name }),
    tagCreate: (cwd, name, ref, opts) => call("/tag-create", { cwd, name, ref, ...opts }),
    commitShow: (cwd, sha) => call("/commit-show", { cwd, sha }),
    commitDiff: (cwd, sha, paths) => call("/commit-diff", { cwd, sha, paths }),
    cherryPick: (cwd, sha, opts) => call("/cherry-pick", { cwd, sha, ...opts }),
    stage: (cwd, paths) => call("/stage", { cwd, paths }),
    unstage: (cwd, paths) => call("/unstage", { cwd, paths }),
    discard: (cwd, paths) => call("/discard", { cwd, paths }),
    ignoreAdd: (cwd, paths) => call("/ignore-add", { cwd, paths }),
    commit: (cwd, message, amend) => call("/commit", { cwd, message, amend }),
    planExecute: (cwd, groups) => call("/plan/execute", { cwd, groups }),
    planRollback: (cwd, baseHEAD) => call("/plan/rollback", { cwd, baseHEAD }),
    stashList: (cwd) => call("/stash/list", { cwd }),
    stashFiles: (cwd, index) => call("/stash/files", { cwd, index }),
    stashPush: (cwd, opts) => call("/stash/push", { cwd, ...opts }),
    stashApply: (cwd, index, opts) => call("/stash/apply", { cwd, index, ...opts }),
    stashDrop: (cwd, index) => call("/stash/drop", { cwd, index }),
    stashBranch: (cwd, index, name) => call("/stash/branch", { cwd, index, name }),
    push: (cwd, opts) => call("/push", { cwd, ...opts }),
    pull: (cwd, mode) => call("/pull", { cwd, mode }),
  };
}

/** Engine presence probe (mount gate): any call returning 404 = aiti-git-ops absent/disabled. */
export async function probeGitOps(apiUrl, fetchImpl) {
  const api = createGitOpsApi({ apiUrl, fetchImpl });
  const r = await api.refs("");
  return r.status !== 404;
}
