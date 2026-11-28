/**
 * Gitee adapter (read-only: repos / branches / issues / comments + clone URLs).
 * Auth is passed as the `access_token` query parameter (Gitee v5 convention).
 */
import { createHttp, intHeader, parseLinkNext } from "../../server/http.ts";
import {
  type ForgeAccount,
  type ForgeBranch,
  type ForgeComment,
  type ForgeNamespace,
  type ForgeRepo,
  type ForgeWorkItem,
  type ForgeWorkItemScope,
  type Http,
  type Page,
  type ProviderConfig,
  type WICounts,
  type WorkItemFilter,
} from "../../server/contract.ts";

export const DEFAULT_BASE_URL = "https://gitee.com/api/v5";
export const ALLOWED_HOSTS = ["gitee.com"];

export function apiBase(cfg: ProviderConfig): string {
  return (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function httpFor(cfg: ProviderConfig, fetchImpl?: typeof fetch): Http {
  return createHttp(apiBase(cfg), {
    headers: { "user-agent": "aiti-codehub" },
    fetchImpl,
  });
}

function tokenQuery(cfg: ProviderConfig, query: Record<string, string | number | boolean | undefined> = {}): Record<string, string | number | boolean | undefined> {
  return { ...query, ...(cfg.token ? { access_token: cfg.token } : {}) };
}

function ts(v: unknown): number | undefined {
  if (!v) return undefined;
  const n = new Date(String(v)).getTime();
  return Number.isFinite(n) ? n : undefined;
}

function pageOf<T>(items: T[], headers: Headers, page: number, pageSize: number): Page<T> {
  const total = intHeader(headers, "total_count", "x-total");
  const totalPages = intHeader(headers, "x-total-pages");
  return {
    items,
    page,
    pageSize,
    total,
    hasMore: totalPages !== undefined ? page < totalPages : !!parseLinkNext(headers.get("link")),
  };
}

export async function getUser(cfg: ProviderConfig, http = httpFor(cfg)): Promise<ForgeAccount> {
  const u = await http.json<Record<string, unknown>>("/user", { query: tokenQuery(cfg) });
  return {
    provider: "gitee",
    userId: String(u.id || ""),
    username: String(u.login || ""),
    displayName: String(u.name || u.login || ""),
    avatarUrl: u.avatar_url ? String(u.avatar_url) : undefined,
  };
}

function mapRepo(raw: Record<string, unknown>): ForgeRepo {
  const full = String(raw.full_name || raw.path || raw.name || "");
  const html = raw.html_url ? String(raw.html_url) : full ? `https://gitee.com/${full}` : undefined;
  return {
    id: full,
    name: String(raw.name || full.split("/").pop() || ""),
    path: full,
    namespace: raw.namespace && typeof raw.namespace === "object"
      ? String((raw.namespace as Record<string, unknown>).path || "")
      : full.includes("/") ? full.split("/")[0] : undefined,
    description: raw.description ? String(raw.description) : undefined,
    defaultBranch: raw.default_branch ? String(raw.default_branch) : undefined,
    webUrl: html,
    cloneSsh: raw.ssh_url ? String(raw.ssh_url) : full ? `git@gitee.com:${full}.git` : undefined,
    cloneHttp: raw.clone_url ? String(raw.clone_url) : html ? `${html}.git` : undefined,
    archived: raw.archived === true,
    updatedAt: ts(raw.updated_at || raw.pushed_at),
  };
}

export async function listNamespaces(cfg: ProviderConfig, page: { page?: number; pageSize?: number } = {}, http = httpFor(cfg)): Promise<Page<ForgeNamespace>> {
  const pageNo = page.page || 1;
  const perPage = page.pageSize || 50;
  const orgs = await http.json<unknown>("/user/orgs", { query: tokenQuery(cfg, { page: pageNo, per_page: perPage }) }).catch(() => []);
  const items: ForgeNamespace[] = [];
  try {
    const me = await http.json<Record<string, unknown>>("/user", { query: tokenQuery(cfg) });
    if (me.login) items.push({ id: String(me.login), name: String(me.login), path: String(me.login), kind: "org" });
  } catch {
    /* not logged in: no personal namespace */
  }
  for (const o of Array.isArray(orgs) ? (orgs as Array<Record<string, unknown>>) : []) {
    items.push({ id: String(o.login || o.id), name: String(o.name || o.login || ""), path: String(o.login || ""), kind: "org" });
  }
  return { items, page: pageNo, pageSize: perPage, hasMore: items.length === perPage };
}

export async function listRepos(
  cfg: ProviderConfig,
  namespace: string | undefined,
  page: { page?: number; pageSize?: number; q?: string } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  if (!namespace) {
    const res = await http.req<unknown>("/user/repos", {
      query: tokenQuery(cfg, { page: pageNo, per_page: perPage, sort: "updated", direction: "desc" }),
    });
    return toRepoPage(res, page, pageNo, perPage);
  }
  try {
    const res = await http.req<unknown>(`/orgs/${encodeURIComponent(namespace)}/repos`, {
      query: tokenQuery(cfg, { page: pageNo, per_page: perPage, sort: "updated", direction: "desc" }),
    });
    return toRepoPage(res, page, pageNo, perPage);
  } catch (e) {
    // a personal login is not an org: Gitee answers 404 — fall back to that user's repos
    if ((e as { code?: string })?.code !== "not_found") throw e;
  }
  const res = await http.req<unknown>(`/users/${encodeURIComponent(namespace)}/repos`, {
    query: tokenQuery(cfg, { page: pageNo, per_page: perPage, sort: "updated", direction: "desc" }),
  });
  return toRepoPage(res, page, pageNo, perPage);
}

function toRepoPage(
  res: { data: unknown; headers: Headers },
  page: { q?: string },
  pageNo: number,
  perPage: number,
): Page<ForgeRepo> {
  const items = (Array.isArray(res.data) ? res.data : []).map((r) => mapRepo(r as Record<string, unknown>));
  const filtered = page.q ? items.filter((r) => `${r.path} ${r.description || ""}`.toLowerCase().includes(page.q!.toLowerCase())) : items;
  return pageOf(filtered, res.headers, pageNo, perPage);
}

export async function getRepo(cfg: ProviderConfig, id: string, http = httpFor(cfg)): Promise<ForgeRepo> {
  return mapRepo(await http.json<Record<string, unknown>>(`/repos/${id}`, { query: tokenQuery(cfg) }));
}

/** Repositories starred by the user. */
export async function listStarred(cfg: ProviderConfig, page: { page?: number; pageSize?: number; q?: string } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>("/user/starred", {
    query: tokenQuery(cfg, { page: pageNo, per_page: perPage, sort: "updated", direction: "desc" }),
  });
  const items = (Array.isArray(res.data) ? res.data : []).map((r) => mapRepo(r as Record<string, unknown>));
  const filtered = page.q ? items.filter((r) => `${r.path} ${r.description || ""}`.toLowerCase().includes(page.q!.toLowerCase())) : items;
  return pageOf(filtered, res.headers, pageNo, perPage);
}

/** User's forked repositories (their own repos with fork: true). */
export async function listForks(cfg: ProviderConfig, page: { page?: number; pageSize?: number; q?: string } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown[]>("/user/repos", {
    query: tokenQuery(cfg, { page: pageNo, per_page: perPage, sort: "updated", direction: "desc" }),
  });
  const items = (Array.isArray(res.data) ? res.data : [])
    .filter((r) => (r as Record<string, unknown>).fork === true)
    .map((r) => mapRepo(r as Record<string, unknown>));
  const filtered = page.q ? items.filter((r) => `${r.path} ${r.description || ""}`.toLowerCase().includes(page.q!.toLowerCase())) : items;
  return pageOf(filtered, res.headers, pageNo, perPage);
}

/** Remote repository search across all namespaces (public repos included). */
export async function searchRepos(cfg: ProviderConfig, q: string, page: { page?: number; pageSize?: number } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(50, page.pageSize || 30);
  const res = await http.req<unknown[]>(`/search/repositories`, {
    query: tokenQuery(cfg, { q: q.trim(), page: pageNo, per_page: perPage }),
  });
  const total = intHeader(res.headers, "total_count", "x-total");
  const items = (Array.isArray(res.data) ? res.data : []).map((r) => mapRepo(r as Record<string, unknown>));
  return { items, page: pageNo, pageSize: perPage, total, hasMore: total !== undefined ? pageNo * perPage < total : items.length === perPage };
}

export async function listBranches(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  page: { page?: number; pageSize?: number; q?: string } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeBranch>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>(`/repos/${repo.path}/branches`, {
    query: tokenQuery(cfg, { page: pageNo, per_page: perPage }),
  });
  let items = (Array.isArray(res.data) ? res.data : []).map((b) => {
    const raw = b as Record<string, unknown>;
    const commit = (raw.commit || {}) as Record<string, unknown>;
    return {
      name: String(raw.name || ""),
      default: String(raw.name || "") === String(repo.defaultBranch || ""),
      protected: raw.protected === true,
      commit: commit.sha
        ? { id: String(commit.sha), shortId: String(commit.sha).slice(0, 7), title: commit.message ? String(commit.message).split("\n")[0] : undefined }
        : undefined,
    } satisfies ForgeBranch;
  });
  if (page.q) {
    const q = page.q.toLowerCase();
    items = items.filter((b) => b.name.toLowerCase().includes(q));
  }
  return pageOf(items, res.headers, pageNo, perPage);
}

function splitRepo(path: string): { owner: string; repo: string } {
  const [owner, repo] = String(path || "").split("/");
  return { owner: owner || "", repo: repo || "" };
}

function mapIssue(raw: Record<string, unknown>, scope: ForgeWorkItemScope): ForgeWorkItem {
  const stateRaw = String(raw.state || "open");
  const state = stateRaw === "closed" || stateRaw === "rejected" ? "closed" : "open";
  const user = (raw.user || raw.creator || {}) as Record<string, unknown>;
  const assignee = (raw.assignee || {}) as Record<string, unknown>;
  const labels = Array.isArray(raw.labels) ? (raw.labels as Array<Record<string, unknown>>) : [];
  /* Gitee issue "number" is a string code (e.g. "I1Z9AB"), not an integer — the
   * get/comments endpoints key on it, so it is the id AND the display key. The
   * numeric `number` field is only set when the code parses as a number. */
  const rawNum = raw.number != null && String(raw.number).trim() !== "" ? String(raw.number)
    : raw.iid != null ? String(raw.iid) : "";
  const numVal = Number(rawNum);
  const numeric = rawNum !== "" && Number.isFinite(numVal) && numVal > 0 ? numVal : undefined;
  return {
    id: rawNum || String(raw.id || ""),
    key: rawNum || String(raw.id || ""),
    number: numeric,
    title: String(raw.title || ""),
    type: "Issue",
    status: stateRaw,
    state,
    assignee: assignee.login ? String(assignee.login) : assignee.name ? String(assignee.name) : undefined,
    creator: user.login ? String(user.login) : undefined,
    tags: labels.map((l) => String(l.name || "")).filter(Boolean),
    description: raw.body ? String(raw.body) : undefined,
    descriptionFormat: "markdown" as const,
    createdAt: ts(raw.created_at),
    updatedAt: ts(raw.updated_at),
    webUrl: raw.html_url ? String(raw.html_url) : undefined,
    scope,
  };
}

export async function listWorkItems(
  cfg: ProviderConfig,
  scope: ForgeWorkItemScope,
  filter: WorkItemFilter,
  page: { page?: number; pageSize?: number } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeWorkItem>> {
  const { owner, repo } = splitRepo(scope.id);
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const state = filter.states?.[0] || (filter.excludeTerminal ? "open" : "all");
  const res = await http.req<unknown>(`/repos/${owner}/${repo}/issues`, {
    query: tokenQuery(cfg, {
      page: pageNo,
      per_page: perPage,
      state,
      ...(filter.labels?.length ? { labels: filter.labels.join(",") } : {}),
      ...(filter.assignee ? { assignee: filter.assignee } : {}),
    }),
  });
  let items = (Array.isArray(res.data) ? res.data : []).map((i) => mapIssue(i as Record<string, unknown>, scope));
  if (filter.keyword?.trim()) {
    const q = filter.keyword.trim().toLowerCase();
    items = items.filter((i) => `${i.key} ${i.title}`.toLowerCase().includes(q));
  }
  return pageOf(items, res.headers, pageNo, perPage);
}

export async function getWorkItem(cfg: ProviderConfig, scope: ForgeWorkItemScope, id: string, http = httpFor(cfg)): Promise<ForgeWorkItem> {
  const { owner, repo } = splitRepo(scope.id);
  const raw = await http.json<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${encodeURIComponent(id)}`, { query: tokenQuery(cfg) });
  return mapIssue(raw, scope);
}

const COUNTS_MAX_PAGES = 10;
const COUNTS_CAP = 999;

/** Paged open-count + local updated_at>seenAt filter (Gitee has no server-side date filter). */
async function countPath(
  cfg: ProviderConfig,
  http: Http,
  path: string,
  query: Record<string, string | number>,
  seenAt: number | undefined,
): Promise<{ open: number; changed: number; capped: boolean }> {
  let open = 0;
  let changed = 0;
  let capped = false;
  for (let page = 1; page <= COUNTS_MAX_PAGES; page++) {
    if (open >= COUNTS_CAP) { capped = true; break; }
    const res = await http.req<unknown[]>(path, { query: tokenQuery(cfg, { ...query, page, per_page: 100 }) });
    const items = Array.isArray(res.data) ? res.data as Record<string, unknown>[] : [];
    for (const i of items) {
      open++;
      if (seenAt !== undefined && (ts(i.updated_at) ?? 0) > seenAt) changed++;
    }
    if (items.length < 100) break;
    if (page === COUNTS_MAX_PAGES || open >= COUNTS_CAP) capped = true;
  }
  return { open: Math.min(open, COUNTS_CAP), changed: Math.min(changed, COUNTS_CAP), capped };
}

function addCount(a: { open: number; changed: number; capped: boolean }, b: { open: number; changed: number; capped: boolean }): { open: number; changed: number; capped: boolean } {
  const open = Math.min(a.open + b.open, COUNTS_CAP);
  const changed = Math.min(a.changed + b.changed, COUNTS_CAP);
  return { open, changed, capped: a.capped || b.capped || a.open + b.open > COUNTS_CAP || a.changed + b.changed > COUNTS_CAP };
}

/** Open count (paged, capped); changes = open items with updated_at after the seen mark. Includes issues and PRs (closed items not counted — Gitee has no since filter). */
export async function counts(
  cfg: ProviderConfig,
  scope: ForgeWorkItemScope,
  seenAt: number | undefined,
  http = httpFor(cfg),
): Promise<WICounts> {
  const { owner, repo } = splitRepo(scope.id);
  const issues = await countPath(cfg, http, `/repos/${owner}/${repo}/issues`, { state: "open" }, seenAt);
  let prs = { open: 0, changed: 0, capped: false };
  try {
    prs = await countPath(cfg, http, `/repos/${owner}/${repo}/pulls`, { state: "open" }, seenAt);
  } catch (e) {
    if ((e as { code?: string })?.code !== "not_found") throw e;
  }
  const sum = addCount(issues, prs);
  return {
    open: sum.open,
    changed: seenAt !== undefined ? sum.changed : sum.open,
    openCapped: sum.capped,
  };
}

export async function listComments(cfg: ProviderConfig, item: ForgeWorkItem, http = httpFor(cfg)): Promise<ForgeComment[]> {
  const { owner, repo } = splitRepo(item.scope.id);
  const raw = await http.json<unknown>(`/repos/${owner}/${repo}/issues/${encodeURIComponent(item.key)}/comments`, {
    query: tokenQuery(cfg, { per_page: 100 }),
  });
  return (Array.isArray(raw) ? raw : []).map((c) => {
    const o = c as Record<string, unknown>;
    const user = (o.user || {}) as Record<string, unknown>;
    return {
      id: String(o.id || ""),
      author: user.login ? String(user.login) : user.name ? String(user.name) : undefined,
      body: String(o.body || ""),
      createdAt: ts(o.created_at),
      updatedAt: ts(o.updated_at),
    } satisfies ForgeComment;
  });
}

/* ───────────────────────────── read-only browsing ───────────────────────────── */

function encPath(path: string): string {
  return String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export async function listTree(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path?: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeTreeEntry[]> {
  const p = encPath(q.path || "");
  const data = await http.json<unknown>(`/repos/${repo.path}/contents${p ? "/" + p : ""}`, {
    query: tokenQuery(cfg, q.ref ? { ref: q.ref } : {}),
  });
  const arr = Array.isArray(data) ? data : [data];
  return (arr as Array<Record<string, unknown>>).map((x) => ({
    name: String(x.name || ""),
    path: String(x.path || ""),
    type: x.type === "dir" ? "dir" : "file",
    size: x.size !== undefined ? Number(x.size) || undefined : undefined,
    sha: x.sha ? String(x.sha) : undefined,
  }));
}

export async function getFile(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeFileContent> {
  const data = await http.json<Record<string, unknown>>(`/repos/${repo.path}/contents/${encPath(q.path)}`, {
    query: tokenQuery(cfg, q.ref ? { ref: q.ref } : {}),
  });
  return {
    content: String(data.content || "").replace(/\n/g, ""),
    encoding: String(data.encoding || "base64") === "base64" ? "base64" : "utf8",
    size: Number(data.size) || 0,
  };
}

export async function listCommits(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path?: string; page?: number; pageSize?: number },
  http = httpFor(cfg),
): Promise<Page<import("../../server/contract.ts").ForgeCommit>> {
  const page = Math.max(1, q.page || 1);
  const perPage = Math.min(100, Math.max(1, q.pageSize || 30));
  const raw = await http.json<unknown>(`/repos/${repo.path}/commits`, {
    query: tokenQuery(cfg, {
      page,
      per_page: perPage,
      ...(q.ref ? { sha: q.ref } : {}),
      ...(q.path ? { path: q.path } : {}),
    }),
  });
  const items = (Array.isArray(raw) ? raw : []).map((x) => {
    const o = x as Record<string, unknown>;
    const c = (o.commit || {}) as Record<string, unknown>;
    const a = (c.author || o.author || {}) as Record<string, unknown>;
    const sha = String(o.sha || o.id || "");
    const message = String(c.message || o.message || "");
    return {
      sha,
      shortSha: sha.slice(0, 7),
      title: message.split("\n")[0] || "",
      message,
      author: a.name ? String(a.name) : undefined,
      date: a.date ? String(a.date) : undefined,
      parents: Array.isArray(o.parents) ? (o.parents as Array<Record<string, unknown>>).map((p) => String(p.sha || p.id || "")) : undefined,
    } satisfies import("../../server/contract.ts").ForgeCommit;
  });
  return { items, page, pageSize: perPage, hasMore: items.length === perPage };
}

export async function getCommit(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { sha: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeCommitDetail> {
  const raw = await http.json<Record<string, unknown>>(`/repos/${repo.path}/commits/${encodeURIComponent(q.sha)}`, { query: tokenQuery(cfg) });
  const c = (raw.commit || raw) as Record<string, unknown>;
  const a = (c.author || {}) as Record<string, unknown>;
  const sha = String(raw.sha || c.sha || q.sha);
  const message = String(c.message || raw.message || "");
  const filesRaw = Array.isArray(raw.files) ? (raw.files as Array<Record<string, unknown>>) : [];
  const files = filesRaw.slice(0, 300).map((f) => {
    const patch = String(f.patch || "");
    return {
      path: String(f.filename || f.new_path || f.path || ""),
      oldPath: f.previous_filename ? String(f.previous_filename) : f.old_path ? String(f.old_path) : undefined,
      status: (String(f.status || "modified") as import("../../server/contract.ts").ForgeCommitFile["status"]),
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
      patch: patch ? (patch.length > 1_000_000 ? patch.slice(0, 1_000_000) + "\n… (truncated)" : patch) : undefined,
    } satisfies import("../../server/contract.ts").ForgeCommitFile;
  });
  return {
    sha,
    shortSha: sha.slice(0, 7),
    title: message.split("\n")[0] || "",
    message,
    author: a.name ? String(a.name) : undefined,
    date: a.date ? String(a.date) : undefined,
    stats: raw.stats && typeof raw.stats === "object"
      ? {
          additions: Number((raw.stats as Record<string, unknown>).additions) || 0,
          deletions: Number((raw.stats as Record<string, unknown>).deletions) || 0,
          total: Number((raw.stats as Record<string, unknown>).total) || 0,
        }
      : undefined,
    files,
  };
}
