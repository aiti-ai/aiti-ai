/**
 * GitLab adapter (read-only: repos / branches / issues / comments + clone URLs).
 * Supports self-hosted instances via baseUrl (API under /api/v4).
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

export const DEFAULT_BASE_URL = "https://gitlab.com";
export const ALLOWED_HOSTS = ["gitlab.com"];

export function webBase(cfg: ProviderConfig): string {
  return (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/api\/v4$/, "");
}

export function apiBase(cfg: ProviderConfig): string {
  const base = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return /\/api\/v4$/.test(base) ? base : `${base}/api/v4`;
}

export function httpFor(cfg: ProviderConfig, fetchImpl?: typeof fetch): Http {
  return createHttp(apiBase(cfg), {
    headers: {
      // OAuth access tokens use Bearer; PATs also accept Bearer (keep PRIVATE-TOKEN for pats).
      ...(cfg.token ? (cfg.authType === "oauth" ? { authorization: `Bearer ${cfg.token}` } : { "PRIVATE-TOKEN": cfg.token }) : {}),
      "user-agent": "aiti-codehub",
    },
    fetchImpl,
  });
}

function ts(v: unknown): number | undefined {
  if (!v) return undefined;
  const n = new Date(String(v)).getTime();
  return Number.isFinite(n) ? n : undefined;
}

function pageOf<T>(items: T[], headers: Headers, page: number, pageSize: number): Page<T> {
  const total = intHeader(headers, "x-total");
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
  const u = await http.json<Record<string, unknown>>("/user");
  return {
    provider: "gitlab",
    userId: String(u.id || ""),
    username: String(u.username || ""),
    displayName: String(u.name || u.username || ""),
    avatarUrl: u.avatar_url ? String(u.avatar_url) : undefined,
  };
}

function mapRepo(raw: Record<string, unknown>): ForgeRepo {
  const path = String(raw.path_with_namespace || raw.path || raw.name || "");
  return {
    id: raw.id !== undefined ? String(raw.id) : path,
    name: String(raw.name || path.split("/").pop() || ""),
    path,
    namespace: raw.namespace && typeof raw.namespace === "object"
      ? String((raw.namespace as Record<string, unknown>).full_path || (raw.namespace as Record<string, unknown>).name || "")
      : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined,
    description: raw.description ? String(raw.description) : undefined,
    defaultBranch: raw.default_branch ? String(raw.default_branch) : undefined,
    webUrl: raw.web_url ? String(raw.web_url) : undefined,
    cloneSsh: raw.ssh_url_to_repo ? String(raw.ssh_url_to_repo) : undefined,
    cloneHttp: raw.http_url_to_repo ? String(raw.http_url_to_repo) : undefined,
    archived: raw.archived === true,
    updatedAt: ts(raw.last_activity_at),
  };
}

export async function listNamespaces(cfg: ProviderConfig, page: { page?: number; pageSize?: number } = {}, http = httpFor(cfg)): Promise<Page<ForgeNamespace>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>("/groups", { query: { membership: true, page: pageNo, per_page: perPage, order_by: "name", sort: "asc" } });
  const items = (Array.isArray(res.data) ? res.data : []).map((g) => {
    const raw = g as Record<string, unknown>;
    return {
      id: String(raw.id || raw.full_path || ""),
      name: String(raw.name || raw.full_path || ""),
      path: String(raw.full_path || raw.path || ""),
      kind: "group" as const,
    };
  });
  return pageOf(items, res.headers, pageNo, perPage);
}

export async function listRepos(
  cfg: ProviderConfig,
  namespace: string | undefined,
  page: { page?: number; pageSize?: number; q?: string } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const path = namespace ? `/groups/${encodeURIComponent(namespace)}/projects` : "/projects";
  const res = await http.req<unknown>(path, {
    query: {
      page: pageNo,
      per_page: perPage,
      order_by: "last_activity_at",
      sort: "desc",
      ...(namespace ? { include_subgroups: true } : { membership: true }),
      ...(page.q ? { search: page.q } : {}),
    },
  });
  const items = (Array.isArray(res.data) ? res.data : []).map((r) => mapRepo(r as Record<string, unknown>));
  const filtered = page.q ? items.filter((r) => `${r.path} ${r.description || ""}`.toLowerCase().includes(page.q!.toLowerCase())) : items;
  return pageOf(filtered, res.headers, pageNo, perPage);
}

export async function getRepo(cfg: ProviderConfig, id: string, http = httpFor(cfg)): Promise<ForgeRepo> {
  return mapRepo(await http.json<Record<string, unknown>>(`/projects/${encodeURIComponent(id)}`));
}

/** Repositories starred by the user. */
export async function listStarred(cfg: ProviderConfig, page: { page?: number; pageSize?: number; q?: string } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>("/projects", {
    query: {
      page: pageNo,
      per_page: perPage,
      starred: true,
      order_by: "last_activity_at",
      sort: "desc",
    },
  });
  const items = (Array.isArray(res.data) ? res.data : []).map((r) => mapRepo(r as Record<string, unknown>));
  const filtered = page.q ? items.filter((r) => `${r.path} ${r.description || ""}`.toLowerCase().includes(page.q!.toLowerCase())) : items;
  return pageOf(filtered, res.headers, pageNo, perPage);
}

/** User's forked repositories (server-side forked=true filter). */
export async function listForks(cfg: ProviderConfig, page: { page?: number; pageSize?: number; q?: string } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>("/projects", {
    query: {
      page: pageNo,
      per_page: perPage,
      membership: true,
      forked: true,
      order_by: "last_activity_at",
      sort: "desc",
    },
  });
  const items = (Array.isArray(res.data) ? res.data : []).map((r) => mapRepo(r as Record<string, unknown>));
  const filtered = page.q ? items.filter((r) => `${r.path} ${r.description || ""}`.toLowerCase().includes(page.q!.toLowerCase())) : items;
  return pageOf(filtered, res.headers, pageNo, perPage);
}

/** Remote repository search across all namespaces (public repos included). */
export async function searchRepos(cfg: ProviderConfig, q: string, page: { page?: number; pageSize?: number } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(50, page.pageSize || 30);
  const res = await http.req<unknown>("/projects", {
    query: {
      page: pageNo,
      per_page: perPage,
      search: q.trim(),
      membership: false,
      order_by: "last_activity_at",
      sort: "desc",
    },
  });
  const total = intHeader(res.headers, "x-total");
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
  const res = await http.req<unknown>(`/projects/${encodeURIComponent(repo.id)}/repository/branches`, {
    query: { page: pageNo, per_page: perPage, ...(page.q ? { search: page.q } : {}) },
  });
  const items = (Array.isArray(res.data) ? res.data : []).map((b) => {
    const raw = b as Record<string, unknown>;
    const commit = (raw.commit || {}) as Record<string, unknown>;
    return {
      name: String(raw.name || ""),
      default: raw.default === true || String(raw.name || "") === String(repo.defaultBranch || ""),
      protected: raw.protected === true,
      commit: commit.id
        ? {
            id: String(commit.id),
            shortId: commit.short_id ? String(commit.short_id) : String(commit.id).slice(0, 8),
            title: commit.title ? String(commit.title) : undefined,
            author: commit.author_name ? String(commit.author_name) : undefined,
            date: commit.committed_date ? String(commit.committed_date) : undefined,
          }
        : undefined,
    } satisfies ForgeBranch;
  });
  return pageOf(items, res.headers, pageNo, perPage);
}

function mapIssue(raw: Record<string, unknown>, scope: ForgeWorkItemScope): ForgeWorkItem {
  const stateRaw = String(raw.state || "opened");
  const state = stateRaw === "closed" ? "closed" : "open";
  const author = (raw.author || {}) as Record<string, unknown>;
  const assignee = (raw.assignee || {}) as Record<string, unknown>;
  const labels = Array.isArray(raw.labels) ? (raw.labels as unknown[]) : [];
  const iid = Number(raw.iid || 0);
  return {
    /* get/comments key on the iid, not the internal id — use it as id too. */
    id: String(iid || raw.id || ""),
    key: String(iid),
    number: iid,
    title: String(raw.title || ""),
    type: "Issue",
    status: stateRaw,
    state,
    assignee: assignee.username ? String(assignee.username) : assignee.name ? String(assignee.name) : undefined,
    creator: author.username ? String(author.username) : undefined,
    tags: labels.map((l) => String(l)).filter(Boolean),
    description: raw.description ? String(raw.description) : undefined,
    createdAt: ts(raw.created_at),
    updatedAt: ts(raw.updated_at),
    webUrl: raw.web_url ? String(raw.web_url) : undefined,
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
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const state = filter.states?.[0] || (filter.excludeTerminal ? "opened" : "all");
  const res = await http.req<unknown>(`/projects/${encodeURIComponent(scope.id)}/issues`, {
    query: {
      page: pageNo,
      per_page: perPage,
      state,
      order_by: "updated_at",
      sort: "desc",
      ...(filter.labels?.length ? { labels: filter.labels.join(",") } : {}),
      ...(filter.assignee ? { assignee_username: filter.assignee } : {}),
      ...(filter.keyword?.trim() ? { search: filter.keyword.trim() } : {}),
    },
  });
  const items = (Array.isArray(res.data) ? res.data : []).map((i) => mapIssue(i as Record<string, unknown>, scope));
  return pageOf(items, res.headers, pageNo, perPage);
}

export async function getWorkItem(cfg: ProviderConfig, scope: ForgeWorkItemScope, id: string, http = httpFor(cfg)): Promise<ForgeWorkItem> {
  const raw = await http.json<Record<string, unknown>>(`/projects/${encodeURIComponent(scope.id)}/issues/${encodeURIComponent(id)}`);
  return mapIssue(raw, scope);
}

interface GlTotal {
  total: number;
  changed: number;
  capped: boolean;
}

/** One-request count via x-total (+local changed when the header is missing). */
async function glTotal(
  http: Http,
  path: string,
  query: Record<string, string | number>,
  seenAt: number | undefined,
): Promise<GlTotal> {
  const res = await http.req<unknown[]>(path, {
    query: { page: 1, per_page: 100, order_by: "updated_at", sort: "desc", ...query },
  });
  const items = Array.isArray(res.data) ? res.data as Record<string, unknown>[] : [];
  const total = intHeader(res.headers, "x-total");
  let changed = 0;
  if (seenAt !== undefined) {
    const ch = await http.req<unknown[]>(path, {
      query: { page: 1, per_page: 100, updated_after: new Date(seenAt).toISOString(), order_by: "updated_at", sort: "desc", ...query },
    });
    const chItems = Array.isArray(ch.data) ? ch.data : [];
    const chTotal = intHeader(ch.headers, "x-total");
    changed = chTotal !== undefined ? chTotal : chItems.length;
  }
  return {
    total: total !== undefined ? total : items.length,
    changed,
    capped: total === undefined && items.length >= 100,
  };
}

function addTotals(a: GlTotal, b: GlTotal): GlTotal {
  return {
    total: a.total + b.total,
    changed: a.changed + b.changed,
    capped: a.capped || b.capped,
  };
}

/** Open count + changes since the seen mark; includes issues and merge requests (closed covered by updated_after). */
export async function counts(
  cfg: ProviderConfig,
  scope: ForgeWorkItemScope,
  seenAt: number | undefined,
  http = httpFor(cfg),
): Promise<WICounts> {
  const proj = encodeURIComponent(scope.id);
  const issues = await glTotal(http, `/projects/${proj}/issues`, { state: "opened" }, seenAt);
  let mrs: GlTotal = { total: 0, changed: 0, capped: false };
  try {
    mrs = await glTotal(http, `/projects/${proj}/merge_requests`, { state: "opened" }, seenAt);
  } catch (e) {
    if ((e as { code?: string })?.code !== "not_found") throw e;
  }
  const sum = addTotals(issues, mrs);
  return {
    open: Math.min(sum.total, 999),
    changed: Math.min(sum.changed, 999),
    openCapped: sum.capped || sum.total > 999,
    changedCapped: sum.capped || sum.changed > 999,
  };
}

export async function listComments(cfg: ProviderConfig, item: ForgeWorkItem, http = httpFor(cfg)): Promise<ForgeComment[]> {
  const raw = await http.json<unknown>(`/projects/${encodeURIComponent(item.scope.id)}/issues/${encodeURIComponent(item.key)}/notes`, {
    query: { per_page: 100, sort: "asc", order_by: "created_at" },
  });
  return (Array.isArray(raw) ? raw : []).map((n) => {
    const o = n as Record<string, unknown>;
    const author = (o.author || {}) as Record<string, unknown>;
    return {
      id: String(o.id || ""),
      author: author.username ? String(author.username) : author.name ? String(author.name) : undefined,
      body: String(o.body || ""),
      createdAt: ts(o.created_at),
      updatedAt: ts(o.updated_at),
      top: o.system === true ? false : undefined,
    } satisfies ForgeComment;
  });
}

/* ───────────────────────────── read-only browsing ───────────────────────────── */

export async function listTree(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path?: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeTreeEntry[]> {
  const raw = await http.json<unknown>(`/projects/${encodeURIComponent(repo.id)}/repository/tree`, {
    query: {
      per_page: 100,
      ...(q.ref ? { ref: q.ref } : {}),
      ...(q.path ? { path: q.path } : {}),
    },
  });
  return (Array.isArray(raw) ? raw : []).map((x) => {
    const o = x as Record<string, unknown>;
    return {
      name: String(o.name || ""),
      path: String(o.path || ""),
      type: o.type === "tree" ? "dir" : "file",
      sha: o.id ? String(o.id) : undefined,
    } satisfies import("../../server/contract.ts").ForgeTreeEntry;
  });
}

export async function getFile(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeFileContent> {
  const data = await http.json<Record<string, unknown>>(`/projects/${encodeURIComponent(repo.id)}/repository/files/${encodeURIComponent(q.path)}`, {
    query: q.ref ? { ref: q.ref } : {},
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
  const raw = await http.json<unknown>(`/projects/${encodeURIComponent(repo.id)}/repository/commits`, {
    query: {
      page,
      per_page: perPage,
      ...(q.ref ? { ref_name: q.ref } : {}),
      ...(q.path ? { path: q.path } : {}),
    },
  });
  const items = (Array.isArray(raw) ? raw : []).map((x) => {
    const o = x as Record<string, unknown>;
    const sha = String(o.id || "");
    const message = String(o.message || "");
    return {
      sha,
      shortSha: String(o.short_id || sha.slice(0, 8)),
      title: String(o.title || message.split("\n")[0] || ""),
      message,
      author: o.author_name ? String(o.author_name) : undefined,
      date: o.authored_date ? String(o.authored_date) : undefined,
      parents: Array.isArray(o.parent_ids) ? o.parent_ids.map(String) : undefined,
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
  const base = `/projects/${encodeURIComponent(repo.id)}/repository/commits/${encodeURIComponent(q.sha)}`;
  const meta = await http.json<Record<string, unknown>>(base);
  const sha = String(meta.id || q.sha);
  const message = String(meta.message || "");
  let files: import("../../server/contract.ts").ForgeCommitFile[] = [];
  try {
    const diffs = await http.json<unknown>(`${base}/diff`);
    files = (Array.isArray(diffs) ? diffs : []).slice(0, 300).map((x) => {
      const d = x as Record<string, unknown>;
      const patch = String(d.diff || "");
      const additions = (patch.match(/^\+(?!\+\+)/gm) || []).length;
      const deletions = (patch.match(/^-(?!--)/gm) || []).length;
      const status = d.new_file ? "added" : d.deleted_file ? "deleted" : d.renamed_file ? "renamed" : "modified";
      return {
        path: String(d.new_path || d.old_path || ""),
        oldPath: d.old_path && d.old_path !== d.new_path ? String(d.old_path) : undefined,
        status: status as import("../../server/contract.ts").ForgeCommitFile["status"],
        additions,
        deletions,
        patch: patch ? (patch.length > 1_000_000 ? patch.slice(0, 1_000_000) + "\n… (truncated)" : patch) : undefined,
      } satisfies import("../../server/contract.ts").ForgeCommitFile;
    });
  } catch {
    /* diff unavailable */
  }
  return {
    sha,
    shortSha: String(meta.short_id || sha.slice(0, 8)),
    title: String(meta.title || message.split("\n")[0] || ""),
    message,
    author: meta.author_name ? String(meta.author_name) : undefined,
    date: meta.authored_date ? String(meta.authored_date) : undefined,
    stats: meta.stats && typeof meta.stats === "object"
      ? {
          additions: Number((meta.stats as Record<string, unknown>).additions) || 0,
          deletions: Number((meta.stats as Record<string, unknown>).deletions) || 0,
          total: Number((meta.stats as Record<string, unknown>).total) || 0,
        }
      : undefined,
    files,
  };
}
