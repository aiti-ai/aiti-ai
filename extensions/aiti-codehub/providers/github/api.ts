/**
 * GitHub adapter (read-only: repos / branches / issues / comments + clone URLs).
 */
import { createHttp, intHeader, parseLinkLastPage, parseLinkNext } from "../../server/http.ts";
import {
  emptyPage,
  type ForgeAccount,
  type ForgeBranch,
  type ForgeComment,
  type ForgeNamespace,
  type ForgeProvider,
  type ForgeRepo,
  type ForgeWorkItem,
  type ForgeWorkItemScope,
  type Http,
  type Page,
  type ProviderConfig,
  type WICounts,
  type WorkItemFilter,
  DEFAULT_TEMPLATES,
} from "../../server/contract.ts";

export const DEFAULT_BASE_URL = "https://api.github.com";
export const ALLOWED_HOSTS = ["github.com", "api.github.com"];

/** GHES: a plain host gets /api/v3 appended (unless already present). */
export function apiBase(cfg: ProviderConfig): string {
  let base = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/\/api\/v3$/.test(base) && !/api\.github\.com$/.test(base)) base += "/api/v3";
  return base;
}

export function webBase(cfg: ProviderConfig): string {
  const base = apiBase(cfg);
  return base.replace(/\/api\/v3$/, "").replace(/^https:\/\/api\.github\.com$/, "https://github.com");
}

export function httpFor(cfg: ProviderConfig, fetchImpl?: typeof fetch): Http {
  return createHttp(apiBase(cfg), {
    headers: {
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      "x-github-api-version": "2022-11-28",
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
  const next = parseLinkNext(headers.get("link"));
  return { items, page, pageSize, total, hasMore: !!next };
}

export async function getUser(cfg: ProviderConfig, http = httpFor(cfg)): Promise<ForgeAccount> {
  const u = await http.json<Record<string, unknown>>("/user");
  return {
    provider: "github",
    userId: String(u.id || ""),
    username: String(u.login || ""),
    displayName: String(u.name || u.login || ""),
    avatarUrl: u.avatar_url ? String(u.avatar_url) : undefined,
  };
}

function mapRepo(raw: Record<string, unknown>): ForgeRepo {
  return {
    id: String(raw.full_name || raw.name || ""),
    name: String(raw.name || ""),
    path: String(raw.full_name || ""),
    namespace: raw.owner && typeof raw.owner === "object" ? String((raw.owner as Record<string, unknown>).login || "") : undefined,
    description: raw.description ? String(raw.description) : undefined,
    defaultBranch: raw.default_branch ? String(raw.default_branch) : undefined,
    webUrl: raw.html_url ? String(raw.html_url) : undefined,
    cloneSsh: raw.ssh_url ? String(raw.ssh_url) : undefined,
    cloneHttp: raw.clone_url ? String(raw.clone_url) : undefined,
    archived: raw.archived === true,
    updatedAt: ts(raw.updated_at),
  };
}

export async function listNamespaces(cfg: ProviderConfig, page: { page?: number; pageSize?: number } = {}, http = httpFor(cfg)): Promise<Page<ForgeNamespace>> {
  const pageNo = page.page || 1;
  const perPage = page.pageSize || 50;
  const [me, orgs] = await Promise.all([
    http.json<Record<string, unknown>>("/user").catch(() => null),
    http.json<unknown>("/user/orgs", { query: { page: pageNo, per_page: perPage } }).catch(() => []),
  ]);
  const items: ForgeNamespace[] = [];
  if (me && me.login) items.push({ id: String(me.login), name: String(me.login), path: String(me.login), kind: "org" });
  for (const o of Array.isArray(orgs) ? (orgs as Array<Record<string, unknown>>) : []) {
    items.push({ id: String(o.login || o.id), name: String(o.login || ""), path: String(o.login || ""), kind: "org" });
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
      query: { page: pageNo, per_page: perPage, sort: "updated", affiliation: "owner,collaborator,organization_member" },
    });
    return toRepoPage(res, page, pageNo, perPage);
  }
  try {
    const res = await http.req<unknown>(`/orgs/${encodeURIComponent(namespace)}/repos`, {
      query: { page: pageNo, per_page: perPage, sort: "updated", type: "all" },
    });
    return toRepoPage(res, page, pageNo, perPage);
  } catch (e) {
    // a personal login is not an org: GitHub answers 404 — fall back to that user's repos
    if ((e as { code?: string })?.code !== "not_found") throw e;
  }
  const res = await http.req<unknown>(`/users/${encodeURIComponent(namespace)}/repos`, {
    query: { page: pageNo, per_page: perPage, sort: "updated", type: "owner" },
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
  return mapRepo(await http.json<Record<string, unknown>>(`/repos/${id}`));
}

function asList(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}

/** Repositories starred by the user. */
export async function listStarred(cfg: ProviderConfig, page: { page?: number; pageSize?: number; q?: string } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>("/user/starred", {
    query: { page: pageNo, per_page: perPage, sort: "updated" },
  });
  return toRepoPage(res, page, pageNo, perPage);
}

/** User's forked repositories (their own repos with fork: true). */
export async function listForks(cfg: ProviderConfig, page: { page?: number; pageSize?: number; q?: string } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>("/user/repos", {
    query: { page: pageNo, per_page: perPage, sort: "updated", affiliation: "owner" },
  });
  const items = asList(res.data).filter((r) => r.fork === true).map((r) => mapRepo(r));
  const filtered = page.q ? items.filter((r) => `${r.path} ${r.description || ""}`.toLowerCase().includes(page.q!.toLowerCase())) : items;
  return pageOf(filtered, res.headers, pageNo, perPage);
}

/** Remote repository search across all namespaces (public repos included). */
export async function searchRepos(cfg: ProviderConfig, q: string, page: { page?: number; pageSize?: number } = {}, http = httpFor(cfg)): Promise<Page<ForgeRepo>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(50, page.pageSize || 30);
  const res = await http.req<Record<string, unknown>>("/search/repositories", {
    query: { q: q.trim(), page: pageNo, per_page: perPage, sort: "updated" },
  });
  const data = res.data || {};
  const items = (Array.isArray(data.items) ? data.items : []).map((r) => mapRepo(r as Record<string, unknown>));
  const total = Number(data.total_count || 0);
  return { items, page: pageNo, pageSize: perPage, total, hasMore: pageNo * perPage < total };
}

export async function listBranches(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  page: { page?: number; pageSize?: number; q?: string } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeBranch>> {
  const pageNo = page.page || 1;
  const perPage = Math.min(100, page.pageSize || 50);
  const res = await http.req<unknown>(`/repos/${repo.path}/branches`, { query: { page: pageNo, per_page: perPage } });
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
  const state = String(raw.state || "open");
  const user = (raw.user || {}) as Record<string, unknown>;
  const assignee = (raw.assignee || {}) as Record<string, unknown>;
  const labels = Array.isArray(raw.labels) ? (raw.labels as Array<Record<string, unknown>>) : [];
  /* get/comments key on the issue number, not the internal id — use it as id too. */
  const number = Number(raw.number || 0);
  return {
    id: String(number || raw.id || ""),
    key: String(number),
    number,
    title: String(raw.title || ""),
    type: "Issue",
    status: state,
    state: state === "closed" ? "closed" : "open",
    assignee: assignee.login ? String(assignee.login) : undefined,
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
  const query: Record<string, string | number> = { page: pageNo, per_page: perPage, state };
  if (filter.labels?.length) query.labels = filter.labels.join(",");
  if (filter.assignee) query.assignee = filter.assignee;

  if (filter.keyword?.trim()) {
    const q = `repo:${owner}/${repo} ${filter.keyword.trim()}`;
    const res = await http.req<unknown>("/search/issues", { query: { q, page: pageNo, per_page: perPage } });
    const data = (res.data || {}) as Record<string, unknown>;
    const items = (Array.isArray(data.items) ? data.items : [])
      .filter((i) => !(i as Record<string, unknown>).pull_request)
      .map((i) => mapIssue(i as Record<string, unknown>, scope));
    return { items, page: pageNo, pageSize: perPage, total: Number(data.total_count || 0), hasMore: items.length === perPage };
  }

  const res = await http.req<unknown>(`/repos/${owner}/${repo}/issues`, { query });
  const items = (Array.isArray(res.data) ? res.data : [])
    .filter((i) => !(i as Record<string, unknown>).pull_request)
    .map((i) => mapIssue(i as Record<string, unknown>, scope));
  return pageOf(items, res.headers, pageNo, perPage);
}

export async function getWorkItem(cfg: ProviderConfig, scope: ForgeWorkItemScope, id: string, http = httpFor(cfg)): Promise<ForgeWorkItem> {
  const { owner, repo } = splitRepo(scope.id);
  const raw = await http.json<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${encodeURIComponent(id)}`);
  return mapIssue(raw, scope);
}

const COUNTS_MAX_PAGES = 10;
const COUNTS_CAP = 999;
const DISCUSSIONS_MAX_PAGES = 3;

interface PageSum {
  total: number;
  changed: number;
  capped: boolean;
}

/** Sum records over pages; stop on a short *raw* page (lists mix in PRs, so filtered length is not a page-end signal). */
async function sumPages(
  http: Http,
  path: string,
  query: Record<string, string | number>,
  seenAt: number | undefined,
  maxPages = COUNTS_MAX_PAGES,
): Promise<PageSum> {
  let total = 0;
  let changed = 0;
  let capped = false;
  for (let page = 1; page <= maxPages; page++) {
    const res = await http.req<unknown[]>(path, { query: { ...query, page, per_page: 100 } });
    const raw = Array.isArray(res.data) ? res.data as Record<string, unknown>[] : [];
    for (const item of raw) {
      total++;
      if (seenAt !== undefined && (ts(item.updated_at) ?? 0) > seenAt) changed++;
    }
    if (total >= COUNTS_CAP) { capped = true; break; }
    if (raw.length < 100) break;
    if (page === maxPages) capped = true;
  }
  return { total: Math.min(total, COUNTS_CAP), changed: Math.min(changed, COUNTS_CAP), capped };
}

/** GitHub Discussions via REST (issues/PR endpoint does not include them). 404 on old hosts → treated as none. */
async function discussionsSum(
  http: Http,
  owner: string,
  repo: string,
  seenAt: number | undefined,
): Promise<PageSum> {
  const empty: PageSum = { total: 0, changed: 0, capped: false };
  let total = 0;
  let changed = 0;
  let capped = false;
  for (let page = 1; page <= DISCUSSIONS_MAX_PAGES; page++) {
    let res;
    try {
      res = await http.req<unknown[]>(`/repos/${owner}/${repo}/discussions`, {
        query: { page, per_page: 100, state: "open" },
      });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      /* discussions disabled (410) / endpoint missing (404) / bad params → treat as none;
         auth / network / rate-limit / server errors still surface for retry */
      if (code && code !== "auth" && code !== "network" && code !== "rate_limited" && code !== "server") return empty;
      throw e;
    }
    const raw = Array.isArray(res.data) ? res.data as Record<string, unknown>[] : [];
    for (const item of raw) {
      total++;
      if (seenAt !== undefined && (ts(item.updated_at) ?? 0) > seenAt) changed++;
    }
    if (total >= COUNTS_CAP) { capped = true; break; }
    if (raw.length < 100) break;
    if (page === DISCUSSIONS_MAX_PAGES) capped = true;
  }
  return { total, changed, capped };
}

function add(a: PageSum, b: PageSum): PageSum {
  const total = Math.min(a.total + b.total, COUNTS_CAP);
  const changed = Math.min(a.changed + b.changed, COUNTS_CAP);
  return { total, changed, capped: a.capped || b.capped || a.total + b.total > COUNTS_CAP || a.changed + b.changed > COUNTS_CAP };
}

/** Open count + changes since the seen mark; includes issues, PRs and discussions (closed covered by `since` on issues/PRs). */
export async function counts(
  cfg: ProviderConfig,
  scope: ForgeWorkItemScope,
  seenAt: number | undefined,
  http = httpFor(cfg),
): Promise<WICounts> {
  const { owner, repo } = splitRepo(scope.id);
  const base = `/repos/${owner}/${repo}/issues`;
  const issuePrOpen = await sumPages(http, base, { state: "open" }, undefined);
  const issuePrChanged = seenAt !== undefined
    ? await sumPages(http, base, { state: "all", since: new Date(seenAt).toISOString() }, seenAt)
    : null;
  const disc = await discussionsSum(http, owner, repo, seenAt);
  const open = add(issuePrOpen, disc);
  const changed = issuePrChanged
    ? add(issuePrChanged, disc)
    : { total: open.total, changed: open.total, capped: open.capped };
  return {
    open: open.total,
    changed: changed.total,
    openCapped: open.capped,
    changedCapped: changed.capped,
  };
}

export async function listComments(cfg: ProviderConfig, item: ForgeWorkItem, http = httpFor(cfg)): Promise<ForgeComment[]> {
  const { owner, repo } = splitRepo(item.scope.id);
  const raw = await http.json<unknown>(`/repos/${owner}/${repo}/issues/${encodeURIComponent(item.key)}/comments`, {
    query: { per_page: 100 },
  });
  return (Array.isArray(raw) ? raw : []).map((c) => {
    const o = c as Record<string, unknown>;
    const user = (o.user || {}) as Record<string, unknown>;
    return {
      id: String(o.id || ""),
      author: user.login ? String(user.login) : undefined,
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
    query: q.ref ? { ref: q.ref } : {},
  });
  const arr = Array.isArray(data) ? data : [data];
  return (arr as Array<Record<string, unknown>>).map((x) => ({
    name: String(x.name || ""),
    path: String(x.path || ""),
    type: x.type === "dir" ? "dir" : x.type === "submodule" ? "submodule" : "file",
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
    query: q.ref ? { ref: q.ref } : {},
  });
  const content = String(data.content || "").replace(/\n/g, "");
  const size = Number(data.size) || 0;
  if (!content && size > 0) throw new Error("File too large (GitHub contents API 1MB limit) — download or clone the repo to view");
  return { content, encoding: "base64", size };
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
    query: {
      page,
      per_page: perPage,
      ...(q.ref ? { sha: q.ref } : {}),
      ...(q.path ? { path: q.path } : {}),
    },
  });
  const items = (Array.isArray(raw) ? raw : []).map((x) => {
    const c = (x as Record<string, unknown>).commit as Record<string, unknown> | undefined;
    const a = c && (c.author as Record<string, unknown> | undefined);
    const sha = String((x as Record<string, unknown>).sha || "");
    const message = String(c?.message || "");
    return {
      sha,
      shortSha: sha.slice(0, 7),
      title: message.split("\n")[0] || "",
      message,
      author: a?.name ? String(a.name) : undefined,
      date: a?.date ? String(a.date) : undefined,
      parents: Array.isArray((x as Record<string, unknown>).parents) ? ((x as Record<string, unknown>).parents as Array<Record<string, unknown>>).map((p) => String(p.sha || "")) : undefined,
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
  const raw = await http.json<Record<string, unknown>>(`/repos/${repo.path}/commits/${encodeURIComponent(q.sha)}`);
  const c = (raw.commit || {}) as Record<string, unknown>;
  const a = (c.author || {}) as Record<string, unknown>;
  const sha = String(raw.sha || q.sha);
  const message = String(c.message || "");
  const files = (Array.isArray(raw.files) ? (raw.files as Array<Record<string, unknown>>) : []).slice(0, 300).map((f) => {
    const patch = String(f.patch || "");
    return {
      path: String(f.filename || ""),
      oldPath: f.previous_filename ? String(f.previous_filename) : undefined,
      status: (String(f.status || "modified") as import("../../server/contract.ts").ForgeCommitFile["status"]),
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
      patch: patch ? (patch.length > 1_000_000 ? patch.slice(0, 1_000_000) + "\n… (truncated)" : patch) : undefined,
      binary: !patch && Number(f.additions) === 0 && Number(f.deletions) === 0 ? undefined : undefined,
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
