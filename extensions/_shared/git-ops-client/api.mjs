/**
 * git-ops-client · REST 封装（方案 docs/aiti-git-ops-shared-plan.md §2）。
 *
 * 两扩展（session-manager / aiti-folder）bundle 源引共享（构建期内联，ext-float-dock 范式）。
 * apiUrl 由消费方注入（host-shim 透出，basePath 感知）；全部 POST + JSON body（cwd 不落 URL）。
 * 返回统一 { status, data }，网络失败 → { status: 0, data: { ok:false, error } }——不 throw。
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
    log: (cwd, cursor) => call("/log", { cwd, cursor: cursor || 0 }),
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

/** 引擎在位探测（挂载门控）：任一调 404 = aiti-git-ops 缺席/禁用。 */
export async function probeGitOps(apiUrl, fetchImpl) {
  const api = createGitOpsApi({ apiUrl, fetchImpl });
  const r = await api.refs("");
  return r.status !== 404;
}
