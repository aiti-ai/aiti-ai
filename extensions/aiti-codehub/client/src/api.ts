/**
 * Client-side API wrapper for /api/extensions/aiti-codehub/*.
 */
import { apiUrl } from "./host-shim";

export interface ApiError extends Error {
  status?: number;
  code?: string;
  retryAt?: number;
}

function qs(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) u.set(k, v.join(","));
    } else if (typeof v === "boolean") {
      u.set(k, v ? "1" : "0");
    } else {
      u.set(k, String(v));
    }
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(apiUrl(`/api/extensions/aiti-codehub${path}`), {
    method: opts.method || "GET",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || data?.ok === false) {
    const err = new Error(data?.error || `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.code = data?.code;
    err.retryAt = data?.retryAt;
    throw err;
  }
  return data as T;
}

/* ── config / providers ── */

export interface PatField {
  key: string;
  label: string;
  kind: "text" | "password" | "url";
  required?: boolean;
  placeholder?: string;
  helpUrl?: string;
  helpText?: string;
}

/** One account instance (the server merges the platform descriptor into it). */
export interface ProviderInfo {
  /** Instance id: "github" (default account) or "github~work". */
  id: string;
  /** Platform id (adapter). */
  platform?: string;
  /** Platform display label (e.g. Yunxiao) — use it for group headers. */
  platformLabel?: string;
  /** User-facing account name (alias) — use it for rows/selected values. */
  alias?: string;
  isDefault?: boolean;
  /** Not configured yet: the platform has no account file; saving the form creates it. */
  virtual?: boolean;
  label: string;
  icon?: string;
  contract: number;
  capabilities: any;
  auth: {
    pat?: { fields: PatField[] };
    oauth?: { mode: "dcr-pkce" | "device-code" | "client-credentials"; scope?: string; clientFields?: PatField[]; defaultClientId?: string; refresh?: boolean };
    gh?: { label?: string; helpUrl?: string };
  };
  defaultBaseUrl?: string;
  defaults: { branch: string; paste: string; ai: string };
  status: {
    authType: "pat" | "oauth" | "gh";
    configured: boolean;
    hasToken: boolean;
    hasClientSecret: boolean;
    needsLogin: boolean;
    account: { username?: string; displayName?: string; extra?: Record<string, string> } | null;
    accountError?: string;
    orgId: string;
    baseUrl: string;
    clientId: string;
    ghHost?: string;
    ghUser?: string;
    expiry?: number;
  };
  redirectUris: { default?: string; page?: string };
}

export interface GlobalConfigView {
  defaultProvider?: string;
  pageSize: number;
  excludeClosed: boolean;
  callbackMode: "page" | "loopback";
  oauthCallbackBase: string;
  localRoots: string[];
  templates: { paste: string; ai: string; branch: string };
}

export interface ConfigPayload {
  ok: boolean;
  global: GlobalConfigView;
  /** Redacted per-instance config map (server-side merge view). */
  settings: Record<string, Record<string, unknown>>;
  /** Platform catalogue (one entry per platform, its default account view). */
  providers: ProviderInfo[];
  /** Configured accounts; unconfigured platforms appear as a virtual default. */
  instances: ProviderInfo[];
}

export async function getConfig(): Promise<ConfigPayload> {
  return request(`/config`);
}

export async function saveConfig(body: { global?: Partial<GlobalConfigView>; provider?: string; account?: string; config?: Record<string, unknown> }): Promise<ConfigPayload> {
  return request(`/config`, { method: "POST", body });
}

/* ── account instances (multi-account) ── */

export async function createInstance(input: { platform: string; alias: string; baseUrl?: string; authType?: "pat" | "oauth" | "gh" }): Promise<ConfigPayload & { created: { id: string; platform: string; alias: string } }> {
  return request(`/instances/create`, { method: "POST", body: input });
}

export async function renameInstance(instance: string, alias: string): Promise<ConfigPayload & { renamed: { id: string; alias: string } }> {
  return request(`/instances/rename`, { method: "POST", body: { instance, alias } });
}

export async function deleteInstance(instance: string): Promise<ConfigPayload & { removed: boolean }> {
  return request(`/instances/delete`, { method: "POST", body: { instance } });
}

export async function testAuth(provider: string, account?: string): Promise<{ ok: boolean; account: any; orgId?: string; alias?: string }> {
  return request(`/auth/test`, { method: "POST", body: { provider, ...(account ? { account } : {}) } });
}

export async function logout(provider: string): Promise<void> {
  await request(`/auth/logout`, { method: "POST", body: { provider } });
}

export interface GhAccountInfo {
  host: string;
  login: string;
  active: boolean;
  state: string;
  scopes: string;
  tokenSource?: string;
}

export interface GhStatusResult {
  ok: boolean;
  host: string;
  available: boolean;
  version?: string;
  error?: string;
  accounts: GhAccountInfo[];
}

/** Detect gh and list its logged-in accounts (tokens never reach the browser). */
export async function ghStatus(provider: string, host?: string): Promise<GhStatusResult> {
  return request(`/gh/status`, { method: "POST", body: { provider, ...(host ? { host } : {}) } });
}

/** Drop the in-memory gh token cache (e.g. after `gh auth login`). */
export async function ghRefresh(): Promise<void> {
  await request(`/gh/refresh`, { method: "POST", body: {} });
}

export type OAuthStartResult =
  | { mode: "dcr-pkce" | "client-credentials"; url: string; redirectUri: string; callbackMode: string }
  | { mode: "device-code"; device: { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number; interval: number } };

export async function startOAuth(provider: string, input: { callbackMode?: "default" | "page" | "custom"; customBase?: string } = {}): Promise<OAuthStartResult> {
  return request(`/oauth/${encodeURIComponent(provider)}/start`, { method: "POST", body: input });
}

export async function cancelDevice(provider: string): Promise<void> {
  await request(`/oauth/${encodeURIComponent(provider)}/device`, { method: "POST", body: { action: "cancel" } });
}

export async function deviceStatus(provider: string): Promise<any> {
  return request(`/oauth/${encodeURIComponent(provider)}/device`);
}

export async function oauthStatus(provider: string): Promise<any> {
  return request(`/oauth/${encodeURIComponent(provider)}/status`);
}

/* ── work items ── */

export interface Scope {
  kind: "project" | "repo";
  id: string;
  label: string;
}

export interface WorkItem {
  id: string;
  key: string;
  number?: number;
  title: string;
  type: string;
  status: string;
  state: "open" | "closed" | "other";
  statusStage?: string;
  assignee?: string;
  creator?: string;
  priority?: string;
  tags: string[];
  description?: string;
  descriptionFormat?: "markdown" | "richtext" | "text";
  descriptionHtml?: string;
  images?: string[];
  createdAt?: number;
  updatedAt?: number;
  webUrl?: string;
  scope: Scope;
  extraFields?: Array<{ label: string; value: string }>;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total?: number;
  hasMore: boolean;
}

export interface WorkItemQuery {
  provider: string;
  scope: Scope;
  keyword?: string;
  types?: string[];
  statuses?: string[];
  states?: string[];
  assignee?: string;
  labels?: string[];
  excludeTerminal?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listScopes(provider: string, page = 1, pageSize = 50, q?: string): Promise<Page<any>> {
  return request(`/workitems/scopes${qs({ provider, page, pageSize, q })}`);
}

export async function listWorkItems(query: WorkItemQuery): Promise<Page<WorkItem>> {
  return request(`/workitems${qs({
    provider: query.provider,
    scopeKind: query.scope.kind,
    scopeId: query.scope.id,
    scopeLabel: query.scope.label,
    keyword: query.keyword,
    types: query.types,
    statuses: query.statuses,
    states: query.states,
    assignee: query.assignee,
    labels: query.labels,
    excludeTerminal: query.excludeTerminal,
    page: query.page,
    pageSize: query.pageSize,
  })}`);
}

export async function getWorkItem(provider: string, scope: Scope, id: string): Promise<{ item: WorkItem; usage: any }> {
  return request(`/workitems/${encodeURIComponent(id)}${qs({ provider, scopeKind: scope.kind, scopeId: scope.id, scopeLabel: scope.label })}`);
}

export async function getComments(provider: string, scope: Scope, id: string): Promise<{ comments: any[] }> {
  return request(`/workitems/${encodeURIComponent(id)}/comments${qs({ provider, scopeKind: scope.kind, scopeId: scope.id, scopeLabel: scope.label })}`);
}

/* ── code ── */

export interface Repo {
  id: string;
  name: string;
  path: string;
  /** Display path without provider-internal prefixes (Yunxiao org id); falls back to path. */
  displayPath?: string;
  namespace?: string;
  description?: string;
  defaultBranch?: string;
  webUrl?: string;
  cloneSsh?: string;
  cloneHttp?: string;
  archived?: boolean;
  updatedAt?: number;
}

export interface Branch {
  name: string;
  default: boolean;
  protected: boolean;
  commit?: { id: string; shortId?: string; title?: string; author?: string; date?: string };
}

export async function listNamespaces(provider: string, parentId?: string, page = 1, pageSize = 50, q?: string): Promise<Page<any>> {
  return request(`/code/namespaces${qs({ provider, parentId, page, pageSize, q })}`);
}

export async function listRepos(provider: string, ns?: string, page = 1, pageSize = 50, q?: string, view?: string): Promise<Page<Repo>> {
  return request(`/code/repos${qs({ provider, ns, page, pageSize, q, view })}`);
}

/** Remote repository search across namespaces (public repos included). */
export async function searchRepos(provider: string, q: string, page = 1, pageSize = 30): Promise<Page<Repo>> {
  return request(`/code/search${qs({ provider, q, page, pageSize })}`);
}

export interface WICount {
  open: number;
  changed: number;
  openCapped?: boolean;
  changedCapped?: boolean;
  seenAt?: number | null;
  error?: string;
}

/** Batched work-item counters for the tree badges (client drives batches; request-driven, no polling). */
export async function fetchCounts(provider: string, scopes: Array<{ kind: string; id: string; label?: string }>, refresh = false): Promise<Record<string, WICount>> {
  const r = await request<{ counts: Record<string, WICount> }>(`/workitems/counts`, {
    method: "POST",
    body: { provider, scopes: scopes.map((s) => ({ scopeId: s.id, scopeKind: s.kind, scopeLabel: s.label })), refresh },
  });
  return r.counts || {};
}

export async function markSeen(provider: string, scope: { kind: string; id: string; label?: string }): Promise<void> {
  await request(`/workitems/seen`, {
    method: "POST",
    body: { provider, scopeId: scope.id, scopeKind: scope.kind, scopeLabel: scope.label },
  });
}

export async function listBranches(provider: string, repo: Repo, page = 1, pageSize = 50, q?: string): Promise<Page<Branch>> {
  return request(`/code/branches${qs({
    provider,
    repoId: repo.id,
    repoPath: repo.path,
    repoName: repo.name,
    defaultBranch: repo.defaultBranch,
    repoUrl: repo.webUrl,
    cloneSsh: repo.cloneSsh,
    cloneHttp: repo.cloneHttp,
    page,
    pageSize,
    q,
  })}`);
}

/* ── repo workspace (all POST; no file paths in URLs) ── */

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "submodule";
  size?: number;
  sha?: string;
}

export interface RepoFileResult {
  ok: boolean;
  kind: "text" | "image" | "binary";
  text?: string;
  blobToken?: string;
  size: number;
  path: string;
  truncated?: boolean;
}

export interface RepoCommit {
  sha: string;
  shortSha: string;
  title: string;
  message: string;
  author?: string;
  date?: string;
  stats?: { additions: number; deletions: number; total: number };
}

export interface CommitFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions?: number;
  deletions?: number;
  patch?: string;
  binary?: boolean;
}

export interface CommitDetail extends RepoCommit {
  files: CommitFile[];
}

export interface RepoRefBody {
  provider: string;
  repoId: string;
  repoPath: string;
  repoName?: string;
  defaultBranch?: string;
  cloneSsh?: string;
  cloneHttp?: string;
  ref?: string;
  path?: string;
}

export async function repoTree(body: RepoRefBody): Promise<{ entries: TreeEntry[] }> {
  return request(`/code/tree`, { method: "POST", body });
}

export async function repoFile(body: RepoRefBody & { path: string }): Promise<RepoFileResult> {
  return request(`/code/file`, { method: "POST", body });
}

export async function repoBlobTickets(body: RepoRefBody & { items: Array<{ path: string; download?: boolean }> }): Promise<{ items: Array<{ path: string; token: string; download: boolean }> }> {
  return request(`/code/blob-ticket`, { method: "POST", body });
}

export function repoBlobUrl(token: string): string {
  return apiUrl(`/api/extensions/aiti-codehub/code/blob/${encodeURIComponent(token)}`);
}

export async function repoCommits(body: RepoRefBody & { page?: number; pageSize?: number }): Promise<Page<RepoCommit>> {
  return request(`/code/commits`, { method: "POST", body });
}

export async function repoCommit(body: RepoRefBody & { sha: string }): Promise<{ commit: CommitDetail }> {
  return request(`/code/commit`, { method: "POST", body });
}

export async function repoLocal(body: RepoRefBody & { cwd?: string }): Promise<{ found: boolean; path?: string; remote?: string }> {
  return request(`/code/local`, { method: "POST", body });
}

export async function repoEditorCopy(body: RepoRefBody & { path: string }): Promise<{ path: string }> {
  return request(`/code/editor-copy`, { method: "POST", body });
}

export async function createMR(body: {
  provider: string;
  repo: Repo;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  workItemIds?: string[];
}): Promise<{ mr: any }> {
  return request(`/code/mr`, { method: "POST", body });
}

/* ── state ── */

export async function getState(): Promise<{ favorites: Record<string, any>; recents: any[]; usage: Record<string, any> }> {
  return request(`/state`);
}

export async function toggleFavorite(provider: string, kind: "projects" | "repos" | "branches", id: string): Promise<{ active: boolean }> {
  return request(`/state/favorite`, { method: "POST", body: { provider, kind, id } });
}

export async function markUsage(provider: string, id: string, kind: "ai" | "paste" | "branch", branch?: string): Promise<{ usage: any }> {
  return request(`/state/usage`, { method: "POST", body: { provider, id, kind, branch } });
}

export async function addRecent(provider: string, kind: "workitem" | "project" | "repo" | "branch", id: string, label: string, sub?: string): Promise<void> {
  await request(`/state/recent`, { method: "POST", body: { provider, kind, id, label, sub } });
}
