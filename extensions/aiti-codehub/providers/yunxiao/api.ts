/**
 * Yunxiao (Aliyun DevOps) API adapter.
 *
 * Endpoints and payload shapes are ported from the original VS Code extension
 * (yunxiao-workitem-helper), minus axios / VS Code. All calls use the shared Http
 * helper so timeouts, pagination and error mapping stay uniform.
 */
import { createHttp, intHeader } from "../../server/http.ts";
import {
  emptyPage,
  type ForgeBranch,
  type ForgeComment,
  type ForgeMR,
  type ForgeNamespace,
  type ForgeProject,
  type ForgeRepo,
  type ForgeWorkItem,
  type ForgeWorkItemScope,
  type Http,
  type Page,
  type ProviderConfig,
  type WICounts,
  type WorkItemFilter,
} from "../../server/contract.ts";
import { normalizeRichContent } from "../../server/format.ts";
import { ALL_CATEGORY_IDS, categoryName, projectWebUrl, stateOf, TERMINAL_STAGES, workItemWebUrl } from "./constants.ts";

export const DEFAULT_BASE_URL = "https://openapi-rdc.aliyuncs.com";
export const ALLOWED_HOSTS = ["aliyuncs.com", "aliyun.com"];

export function apiBase(cfg: ProviderConfig): string {
  return (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function authHeaders(cfg: ProviderConfig): Record<string, string> {
  const token = cfg.token || "";
  if (!token) return {};
  // PATs and OAuth access tokens are both accepted through x-yunxiao-token; OAuth
  // tokens also travel as a bearer token for endpoints that prefer that form.
  const headers: Record<string, string> = { "x-yunxiao-token": token };
  if (cfg.authType === "oauth") headers.authorization = `Bearer ${token}`;
  return headers;
}

export function httpFor(cfg: ProviderConfig, fetchImpl?: typeof fetch): Http {
  return createHttp(apiBase(cfg), { headers: authHeaders(cfg), fetchImpl });
}

export function orgIdOf(cfg: ProviderConfig): string {
  return String(cfg.orgId || "").trim();
}

function ts(v: unknown): number | undefined {
  if (!v) return undefined;
  const n = typeof v === "number" ? v : new Date(String(v)).getTime();
  return Number.isFinite(n) ? n : undefined;
}

function asArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["result", "items", "list", "data"]) {
      if (Array.isArray(o[key])) return o[key] as T[];
    }
  }
  return [];
}

/* ───────────────────────────── account ───────────────────────────── */

export interface YunxiaoUser {
  id: string;
  username: string;
  name: string;
  nickName?: string;
  email?: string;
  lastOrganization?: string;
}

export async function getUser(cfg: ProviderConfig, http = httpFor(cfg)): Promise<YunxiaoUser> {
  const raw = await http.json<Record<string, unknown>>("/oapi/v1/platform/user");
  const lastOrg = raw.lastOrganization;
  const org = typeof lastOrg === "string"
    ? lastOrg
    : lastOrg && typeof lastOrg === "object"
      ? String((lastOrg as Record<string, unknown>).id || (lastOrg as Record<string, unknown>).identifier || "")
      : undefined;
  return {
    id: String(raw.id || ""),
    username: String(raw.username || raw.nickName || ""),
    name: String(raw.name || raw.nickName || raw.username || ""),
    nickName: raw.nickName ? String(raw.nickName) : undefined,
    email: raw.email ? String(raw.email) : undefined,
    lastOrganization: org || undefined,
  };
}

/* ───────────────────────────── projects ───────────────────────────── */

export async function listProjects(cfg: ProviderConfig, page: { page?: number; pageSize?: number; q?: string } = {}, http = httpFor(cfg)): Promise<Page<ForgeProject>> {
  const org = orgIdOf(cfg);
  const pageNo = Math.max(1, page.page || 1);
  const perPage = Math.min(100, Math.max(1, page.pageSize || 50));
  const res = await http.req<unknown>(`/oapi/v1/projex/organizations/${encodeURIComponent(org)}/projects:search`, {
    method: "POST",
    body: {
      conditions: page.q ? JSON.stringify({ conditionGroups: [[{ fieldIdentifier: "name", operator: "CONTAINS", value: [page.q], className: "string", toValue: null, format: "input" }]] }) : "",
      extraConditions: "",
      orderBy: "gmtCreate",
      page: pageNo,
      perPage,
      sort: "desc",
    },
  });
  const items = asArray<Record<string, unknown>>(res.data).map((p) => ({
    id: String(p.identifier || p.id || ""),
    name: String(p.name || ""),
    key: p.customCode ? String(p.customCode) : undefined,
    description: p.description ? String(p.description) : undefined,
    webUrl: projectWebUrl(String(p.identifier || p.id || "")) || undefined,
  }));
  const total = intHeader(res.headers, "x-total");
  const totalPages = intHeader(res.headers, "x-total-pages");
  return {
    items,
    page: pageNo,
    pageSize: perPage,
    total,
    hasMore: totalPages !== undefined ? pageNo < totalPages : items.length === perPage,
  };
}

/* ───────────────────────────── work items ───────────────────────────── */

export interface Condition {
  fieldIdentifier: string;
  operator: string;
  value?: string[];
  className?: string;
  toValue?: string | null;
  format?: string;
}

/** Build the conditionGroups JSON for workitems:search (OR between groups, AND inside). */
export function buildConditions(filter: WorkItemFilter): { conditions: string; category: string } {
  const groups: Condition[][] = [];
  const extra: Condition[] = [];

  const kw = (filter.keyword || "").trim();
  if (kw) {
    // Only the full serial ("CEXP-6909") is accepted by Yunxiao's serialNumber
    // field — EQUAL with a bare number or CONTAINS on a partial serial both
    // 400 ("编号搜索不合法"). Bare numbers fall back to a title/body search.
    const ident = /^#?([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(kw);
    if (ident) {
      groups.push([{ fieldIdentifier: "serialNumber", operator: "EQUAL", value: [ident[1]], className: "string", toValue: null, format: "input" }]);
    } else {
      groups.push([{ fieldIdentifier: "subject", operator: "CONTAINS", value: [kw], className: "string", toValue: null, format: "input" }]);
      groups.push([{ fieldIdentifier: "description", operator: "CONTAINS", value: [kw], className: "string", toValue: null, format: "input" }]);
    }
  }

  if (filter.statuses?.length) {
    extra.push({ fieldIdentifier: "status", operator: "CONTAINS", value: filter.statuses, className: "status", format: "list" });
  }
  if (filter.excludeTerminal) {
    extra.push({
      fieldIdentifier: "statusStage",
      operator: "NOT_CONTAINS",
      value: TERMINAL_STAGES,
      className: "statusStage",
      toValue: null,
      format: "list",
    });
  }
  if (filter.assignee) {
    extra.push({ fieldIdentifier: "assignedTo", operator: "EQUAL", value: [filter.assignee], className: "assignedTo", format: "user" });
  }

  if (extra.length && groups.length) {
    for (const g of groups) g.push(...extra);
  } else if (extra.length) {
    groups.push(extra);
  }

  const category = filter.types?.length ? filter.types.join(",") : ALL_CATEGORY_IDS.join(",");
  const conditions = groups.length ? JSON.stringify({ conditionGroups: groups }) : "";
  return { conditions, category };
}

function mapWorkItem(raw: Record<string, unknown>, scope: ForgeWorkItemScope): ForgeWorkItem {
  const status = (raw.status || {}) as Record<string, unknown>;
  const statusName = String(status.displayName || status.name || "");
  const stage = raw.statusStageId !== undefined && raw.statusStageId !== null ? String(raw.statusStageId) : undefined;
  const category = String(raw.categoryId || raw.category || "");
  const serial = String(raw.serialNumber || raw.id || "");
  const labels = Array.isArray(raw.labels) ? (raw.labels as Array<Record<string, unknown>>) : [];
  return {
    id: String(raw.id || serial),
    key: serial,
    title: String(raw.subject || ""),
    type: categoryName(category),
    status: statusName,
    state: stateOf(stage, statusName),
    statusStage: stage,
    assignee: raw.assignedTo && typeof raw.assignedTo === "object" ? String((raw.assignedTo as Record<string, unknown>).name || "") : undefined,
    creator: raw.creator && typeof raw.creator === "object" ? String((raw.creator as Record<string, unknown>).name || "") : undefined,
    priority: raw.priority !== undefined && raw.priority !== null ? String(raw.priority) : undefined,
    tags: labels.map((l) => String(l.name || "")).filter(Boolean),
    createdAt: ts(raw.gmtCreate),
    updatedAt: ts(raw.gmtModified),
    webUrl: workItemWebUrl(serial, category, String(raw.subject || "")) || undefined,
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
  const org = orgIdOf(cfg);
  const pageNo = Math.max(1, page.page || 1);
  const perPage = Math.min(100, Math.max(1, page.pageSize || 50));
  const { conditions, category } = buildConditions(filter);
  const res = await http.req<unknown>(`/oapi/v1/projex/organizations/${encodeURIComponent(org)}/workitems:search`, {
    method: "POST",
    body: {
      spaceId: scope.id,
      category,
      conditions,
      orderBy: "gmtCreate",
      page: pageNo,
      perPage,
      sort: "desc",
    },
  });
  const items = asArray<Record<string, unknown>>(res.data).map((raw) => mapWorkItem(raw, scope));
  const total = intHeader(res.headers, "x-total");
  const totalPages = intHeader(res.headers, "x-total-pages");
  return {
    items,
    page: pageNo,
    pageSize: perPage,
    total,
    hasMore: totalPages !== undefined ? pageNo < totalPages : items.length === perPage,
  };
}

export async function getWorkItem(cfg: ProviderConfig, scope: ForgeWorkItemScope, id: string, http = httpFor(cfg)): Promise<ForgeWorkItem> {
  const org = orgIdOf(cfg);
  const raw = await http.json<Record<string, unknown>>(`/oapi/v1/projex/organizations/${encodeURIComponent(org)}/workitems/${encodeURIComponent(id)}`);
  const item = mapWorkItem(raw, scope);
  const norm = normalizeRichContent(raw.description, String(raw.formatType || ""));
  item.description = norm.text;
  item.descriptionFormat = norm.format;
  if (norm.html) item.descriptionHtml = norm.html;
  item.images = norm.images;
  const extra: Array<{ label: string; value: string }> = [];
  if (raw.sprint && typeof raw.sprint === "object") {
    const s = raw.sprint as Record<string, unknown>;
    if (s.name) extra.push({ label: "Sprint", value: String(s.name) });
  }
  if (Array.isArray(raw.participants) && raw.participants.length) {
    extra.push({
      label: "参与人",
      value: (raw.participants as Array<Record<string, unknown>>).map((p) => String(p.name || "")).filter(Boolean).join(", "),
    });
  }
  if (Array.isArray(raw.customFieldValues)) {
    for (const f of raw.customFieldValues as Array<Record<string, unknown>>) {
      const label = String(f.fieldName || f.name || f.fieldIdentifier || "");
      const value = f.value !== undefined ? f.value : f.displayValue;
      if (label && value !== undefined && value !== null && String(value).trim()) {
        extra.push({ label, value: typeof value === "object" ? JSON.stringify(value) : String(value) });
      }
    }
  }
  if (extra.length) item.extraFields = extra;
  try {
    const org = orgIdOf(cfg);
    const rawAtt = await http.json<unknown>(`/oapi/v1/projex/organizations/${encodeURIComponent(org)}/workitems/${encodeURIComponent(id)}/attachments`);
    const list = asArray<Record<string, unknown>>(rawAtt)
      .map((a) => ({
        id: String(a.fileId || a.id || ""),
        name: String(a.fileName || a.name || ""),
        size: Number(a.size) || undefined,
        suffix: a.suffix ? String(a.suffix) : undefined,
      }))
      .filter((a) => a.id && a.name);
    if (list.length) item.attachments = list;
  } catch {
    /* attachments are optional / may be forbidden */
  }
  return item;
}

const COUNTS_MAX_PAGES = 10;
const COUNTS_CAP = 999;

/** Open (non-terminal) count, paged; changes = fetched items with gmtModified after the seen mark (Yunxiao has no server-side date filter). */
export async function counts(
  cfg: ProviderConfig,
  scope: ForgeWorkItemScope,
  seenAt: number | undefined,
  http = httpFor(cfg),
): Promise<WICounts> {
  const org = orgIdOf(cfg);
  const { conditions, category } = buildConditions({ excludeTerminal: true });
  let open = 0;
  let changed = 0;
  let capped = false;
  for (let page = 1; page <= COUNTS_MAX_PAGES; page++) {
    if (open >= COUNTS_CAP) { capped = true; break; }
    const res = await http.req<unknown>(`/oapi/v1/projex/organizations/${encodeURIComponent(org)}/workitems:search`, {
      method: "POST",
      body: { spaceId: scope.id, category, conditions, orderBy: "gmtModified", page, perPage: 100, sort: "desc" },
    });
    const items = asArray<Record<string, unknown>>(res.data);
    for (const raw of items) {
      open++;
      if (seenAt !== undefined && (ts(raw.gmtModified) ?? 0) > seenAt) changed++;
    }
    if (items.length < 100) break;
    if (page === COUNTS_MAX_PAGES || open >= COUNTS_CAP) capped = true;
  }
  return { open: Math.min(open, COUNTS_CAP), changed: Math.min(seenAt !== undefined ? changed : open, COUNTS_CAP), openCapped: capped };
}

export async function listComments(cfg: ProviderConfig, item: ForgeWorkItem, http = httpFor(cfg)): Promise<ForgeComment[]> {
  const org = orgIdOf(cfg);
  const raw = await http.json<unknown>(`/oapi/v1/projex/organizations/${encodeURIComponent(org)}/workitems/${encodeURIComponent(item.id)}/comments`);
  return asArray<Record<string, unknown>>(raw).map((c) => {
    const norm = normalizeRichContent(c.content);
    const user = (c.user || {}) as Record<string, unknown>;
    return {
      id: String(c.id || ""),
      author: user.name ? String(user.name) : undefined,
      body: norm.text,
      bodyFormat: norm.format,
      ...(norm.html ? { bodyHtml: norm.html } : {}),
      createdAt: ts(c.gmtCreate),
      updatedAt: ts(c.gmtModified),
      top: c.top === true,
    };
  });
}

/* ───────────────────────────── code ───────────────────────────── */

export async function listNamespaces(
  cfg: ProviderConfig,
  parentId: string | undefined,
  page: { page?: number; pageSize?: number; q?: string } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeNamespace>> {
  const org = orgIdOf(cfg);
  const pageNo = Math.max(1, page.page || 1);
  const perPage = Math.min(100, Math.max(1, page.pageSize || 50));
  const res = await http.req<unknown>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/namespaces`, {
    query: {
      ...(parentId ? { parentId } : {}),
      page: pageNo,
      perPage,
      ...(page.q ? { search: page.q } : {}),
      orderBy: "updated_at",
      sort: "desc",
    },
  });
  const items = asArray<Record<string, unknown>>(res.data).map((n) => ({
    id: String(n.id || ""),
    name: String(n.name || ""),
    path: n.pathWithNamespace ? String(n.pathWithNamespace) : n.path ? String(n.path) : undefined,
    kind: "group" as const,
  }));
  const totalPages = intHeader(res.headers, "x-total-pages");
  return {
    items,
    page: pageNo,
    pageSize: perPage,
    total: intHeader(res.headers, "x-total"),
    hasMore: totalPages !== undefined ? pageNo < totalPages : items.length === perPage,
  };
}

function mapRepo(raw: Record<string, unknown>, orgId?: string): ForgeRepo {
  const path = String(raw.pathWithNamespace || raw.path || raw.name || "");
  // Yunxiao pathWithNamespace is "<orgId>/<group>/<repo>"; the org id is noise in the UI.
  const displayPath = orgId && path.startsWith(orgId + "/") ? path.slice(orgId.length + 1) : path;
  return {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    path,
    displayPath,
    namespace: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined,
    description: raw.description ? String(raw.description) : undefined,
    defaultBranch: raw.defaultBranch ? String(raw.defaultBranch) : undefined,
    webUrl: raw.webUrl ? String(raw.webUrl) : undefined,
    cloneSsh: raw.sshUrlToRepo ? String(raw.sshUrlToRepo) : undefined,
    cloneHttp: raw.httpUrlToRepo ? String(raw.httpUrlToRepo) : undefined,
    archived: raw.archived === true,
    updatedAt: ts(raw.updatedAt || raw.lastActivityAt),
  };
}

export async function listRepos(
  cfg: ProviderConfig,
  namespace: string | undefined,
  page: { page?: number; pageSize?: number; q?: string } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeRepo>> {
  const org = orgIdOf(cfg);
  const pageNo = Math.max(1, page.page || 1);
  const perPage = Math.min(100, Math.max(1, page.pageSize || 50));
  const path = namespace
    ? `/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/groups/${encodeURIComponent(namespace)}/repositories`
    : `/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories`;
  const res = await http.req<unknown>(path, {
    query: {
      page: pageNo,
      perPage,
      ...(page.q ? { search: page.q } : {}),
      orderBy: "created_at",
      sort: "desc",
    },
  });
  const items = asArray<Record<string, unknown>>(res.data).map((r) => mapRepo(r, org));
  const totalPages = intHeader(res.headers, "x-total-pages");
  return {
    items,
    page: pageNo,
    pageSize: perPage,
    total: intHeader(res.headers, "x-total"),
    hasMore: totalPages !== undefined ? pageNo < totalPages : items.length === perPage,
  };
}

export async function getRepo(cfg: ProviderConfig, id: string, http = httpFor(cfg)): Promise<ForgeRepo> {
  const org = orgIdOf(cfg);
  const raw = await http.json<Record<string, unknown>>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(id)}`);
  return mapRepo(raw, orgIdOf(cfg));
}

export async function listBranches(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  page: { page?: number; pageSize?: number; q?: string } = {},
  http = httpFor(cfg),
): Promise<Page<ForgeBranch>> {
  const org = orgIdOf(cfg);
  const pageNo = Math.max(1, page.page || 1);
  const perPage = Math.min(100, Math.max(1, page.pageSize || 50));
  const res = await http.req<unknown>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(repo.id)}/branches`, {
    query: {
      page: pageNo,
      perPage,
      ...(page.q ? { search: page.q } : {}),
      sort: "updated_desc",
    },
  });
  const items = asArray<Record<string, unknown>>(res.data).map((b) => {
    const commit = (b.commit || {}) as Record<string, unknown>;
    return {
      name: String(b.name || ""),
      default: b.defaultBranch === true,
      protected: b.protected === true,
      commit: commit.id
        ? {
            id: String(commit.id),
            shortId: commit.shortId ? String(commit.shortId) : undefined,
            title: commit.title ? String(commit.title) : undefined,
            author: commit.authorName ? String(commit.authorName) : undefined,
            date: commit.committedDate ? String(commit.committedDate) : undefined,
          }
        : undefined,
    };
  });
  const totalPages = intHeader(res.headers, "x-total-pages");
  return {
    items,
    page: pageNo,
    pageSize: perPage,
    total: intHeader(res.headers, "x-total"),
    hasMore: totalPages !== undefined ? pageNo < totalPages : items.length === perPage,
  };
}

export async function createMR(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  input: { sourceBranch: string; targetBranch: string; title: string; description?: string; workItemIds?: string[] },
  http = httpFor(cfg),
): Promise<ForgeMR> {
  const org = orgIdOf(cfg);
  const repoId = Number(repo.id);
  const body = {
    sourceBranch: input.sourceBranch,
    sourceProjectId: repoId,
    targetBranch: input.targetBranch,
    targetProjectId: repoId,
    title: input.title.slice(0, 256),
    description: (input.description || "").slice(0, 10_000),
    reviewerUserIds: [],
    workItemIds: input.workItemIds || [],
    triggerAIReviewRun: false,
  };
  const raw = await http.json<Record<string, unknown>>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(repo.id)}/changeRequests`, {
    method: "POST",
    body,
  });
  const localId = raw.localId !== undefined ? String(raw.localId) : "";
  let webUrl = raw.detailUrl && String(raw.detailUrl) !== '""' ? String(raw.detailUrl) : raw.webUrl ? String(raw.webUrl) : undefined;
  if (!webUrl && localId && repo.path) webUrl = `https://codeup.aliyun.com/${repo.path}/change/${localId}`;
  return {
    id: String(raw.id || localId || ""),
    title: String(raw.title || input.title),
    sourceBranch: String(raw.sourceBranch || input.sourceBranch),
    targetBranch: String(raw.targetBranch || input.targetBranch),
    webUrl,
    state: raw.state ? String(raw.state) : undefined,
  };
}

export { emptyPage };

/* ───────────────────────────── read-only browsing ───────────────────────────── */

function mapTreeEntry(raw: Record<string, unknown>): import("../../server/contract.ts").ForgeTreeEntry {
  const t = String(raw.type || "");
  return {
    name: String(raw.name || ""),
    path: String(raw.path || ""),
    type: t === "tree" ? "dir" : t === "commit" ? "submodule" : "file",
    size: raw.size !== undefined ? Number(raw.size) || undefined : undefined,
    sha: raw.id ? String(raw.id) : undefined,
  };
}

export async function listTree(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path?: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeTreeEntry[]> {
  const org = orgIdOf(cfg);
  const raw = await http.json<unknown>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(repo.id)}/files/tree`, {
    query: {
      ...(q.ref ? { ref: q.ref } : {}),
      ...(q.path ? { path: q.path } : {}),
      type: "DIRECT",
    },
  });
  return asArray<Record<string, unknown>>(raw).map(mapTreeEntry);
}

export async function getFile(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeFileContent> {
  const org = orgIdOf(cfg);
  const raw = await http.json<Record<string, unknown>>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(repo.id)}/files/${encodeURIComponent(q.path)}`, {
    query: q.ref ? { ref: q.ref } : {},
  });
  return {
    content: String(raw.content || ""),
    encoding: "base64",
    size: Number(raw.size) || 0,
    contentType: raw.fileName ? String(raw.fileName).split(".").pop() : undefined,
  };
}

function mapCommit(raw: Record<string, unknown>): import("../../server/contract.ts").ForgeCommit {
  const message = String(raw.message || raw.title || "");
  return {
    sha: String(raw.id || ""),
    shortSha: String(raw.shortId || raw.id || "").slice(0, 8),
    title: String(raw.title || message.split("\n")[0] || ""),
    message,
    author: raw.authorName ? String(raw.authorName) : undefined,
    date: raw.authoredDate ? String(raw.authoredDate) : undefined,
    parents: Array.isArray(raw.parentIds) ? raw.parentIds.map(String) : undefined,
    stats: raw.stats && typeof raw.stats === "object"
      ? {
          additions: Number((raw.stats as Record<string, unknown>).additions) || 0,
          deletions: Number((raw.stats as Record<string, unknown>).deletions) || 0,
          total: Number((raw.stats as Record<string, unknown>).total) || 0,
        }
      : undefined,
  };
}

export async function listCommits(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { ref?: string; path?: string; page?: number; pageSize?: number },
  http = httpFor(cfg),
): Promise<Page<import("../../server/contract.ts").ForgeCommit>> {
  const org = orgIdOf(cfg);
  const page = Math.max(1, q.page || 1);
  const perPage = Math.min(100, Math.max(1, q.pageSize || 30));
  const res = await http.req<unknown>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(repo.id)}/commits`, {
    query: {
      refName: q.ref || "master",
      page,
      perPage,
      ...(q.path ? { path: q.path } : {}),
    },
  });
  const items = asArray<Record<string, unknown>>(res.data).map(mapCommit);
  return { items, page, pageSize: perPage, hasMore: items.length === perPage };
}

export async function getCommit(
  cfg: ProviderConfig,
  repo: ForgeRepo,
  q: { sha: string },
  http = httpFor(cfg),
): Promise<import("../../server/contract.ts").ForgeCommitDetail> {
  const org = orgIdOf(cfg);
  const raw = await http.json<Record<string, unknown>>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(repo.id)}/commits/${encodeURIComponent(q.sha)}`);
  const commit = mapCommit(raw) as import("../../server/contract.ts").ForgeCommitDetail;
  commit.files = [];
  const parent = Array.isArray(raw.parentIds) && raw.parentIds.length ? String(raw.parentIds[0]) : "";
  if (parent) {
    try {
      const cmp = await http.json<Record<string, unknown>>(`/oapi/v1/codeup/organizations/${encodeURIComponent(org)}/repositories/${encodeURIComponent(repo.id)}/compares`, {
        query: { from: parent, to: q.sha },
      });
      const diffs = Array.isArray(cmp.diffs) ? (cmp.diffs as Array<Record<string, unknown>>) : [];
      commit.files = diffs.map((d) => {
        const patch = String(d.diff || "");
        const additions = (patch.match(/^\+(?!\+\+)/gm) || []).length;
        const deletions = (patch.match(/^-(?!--)/gm) || []).length;
        const status = d.newFile ? "added" : d.deletedFile ? "deleted" : d.renamedFile ? "renamed" : "modified";
        return {
          path: String(d.newPath || d.oldPath || ""),
          oldPath: d.oldPath && d.oldPath !== d.newPath ? String(d.oldPath) : undefined,
          status: status as import("../../server/contract.ts").ForgeCommitFile["status"],
          additions,
          deletions,
          patch: patch.length > 1_000_000 ? patch.slice(0, 1_000_000) + "\n… (truncated)" : patch,
          binary: d.isBinary === true,
        };
      });
    } catch {
      /* diff unavailable: keep the commit metadata */
    }
  }
  return commit;
}
