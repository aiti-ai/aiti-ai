/**
 * aiti-codehub · platform contract (the meta-model shared by every provider).
 *
 * Everything the generic routes / UI / agent tools need is expressed here. Provider
 * adapters only map their own API onto these types; no provider-specific branching is
 * allowed above this layer.
 */

export type ProviderId = "yunxiao" | "github" | "gitee" | "gitlab" | (string & {});

export interface ForgeAccount {
  provider: ProviderId;
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  /** Free-form extras shown in settings (org name, plan, ...). */
  extra?: Record<string, string>;
}

export interface ForgeNamespace {
  id: string;
  name: string;
  path?: string;
  kind: "org" | "group" | "team";
}

export interface ForgeProject {
  id: string;
  name: string;
  key?: string;
  description?: string;
  webUrl?: string;
}

export interface ForgeRepo {
  id: string;
  name: string;
  /** Namespace-qualified path (owner/repo, group/repo, org/group/repo); used for operations. */
  path: string;
  /** User-facing path without provider-internal prefixes (e.g. Yunxiao org id). Falls back to path. */
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

export interface ForgeBranchCommit {
  id: string;
  shortId?: string;
  title?: string;
  author?: string;
  date?: string;
}

export interface ForgeBranch {
  name: string;
  default: boolean;
  protected: boolean;
  commit?: ForgeBranchCommit;
}

export type WorkItemState = "open" | "closed" | "other";

export interface ForgeWorkItemScope {
  kind: "project" | "repo";
  id: string;
  label: string;
}

/** Per-scope work-item counters for the tree badges. */
export interface WICounts {
  open: number;
  /** Items updated after the last "seen" mark; never seen → equals open (all new). */
  changed: number;
  openCapped?: boolean;
  changedCapped?: boolean;
}

export interface ForgeWorkItem {
  id: string;
  /** Human-facing key: Yunxiao serial number, issue number for the others. */
  key: string;
  number?: number;
  title: string;
  type: string;
  status: string;
  state: WorkItemState;
  statusStage?: string;
  assignee?: string;
  creator?: string;
  priority?: string;
  tags: string[];
  description?: string;
  /** Rich description form: "markdown" (render markdown), "richtext" (sanitized HTML in descriptionHtml), "text". */
  descriptionFormat?: "markdown" | "richtext" | "text";
  /** Sanitized-by-client HTML for RICHTEXT providers (raw provider HTML; the client sanitizes it). */
  descriptionHtml?: string;
  /** Image URLs extracted from rich text (for fallbacks / attachment lists). */
  images?: string[];
  /** Work item attachments (metadata only; downloads go through the provider file proxy). */
  attachments?: Array<{ id: string; name: string; size?: number; suffix?: string }>;
  createdAt?: number;
  updatedAt?: number;
  webUrl?: string;
  scope: ForgeWorkItemScope;
  /** Provider-specific read-only fields (Yunxiao custom fields, sprint, participants...). */
  extraFields?: Array<{ label: string; value: string }>;
}

export interface ForgeComment {
  id: string;
  author?: string;
  body: string;
  /** Rich comment body (same semantics as the work item description). */
  bodyFormat?: "markdown" | "richtext" | "text";
  bodyHtml?: string;
  createdAt?: number;
  updatedAt?: number;
  top?: boolean;
}

export interface ForgeTreeEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "submodule";
  size?: number;
  sha?: string;
}

export interface ForgeFileContent {
  /** File bytes: utf8 text, or base64 for providers that only expose base64. */
  content: string;
  encoding: "utf8" | "base64";
  size: number;
  contentType?: string;
}

export interface ForgeCommit {
  sha: string;
  shortSha: string;
  title: string;
  message: string;
  author?: string;
  date?: string;
  parents?: string[];
  stats?: { additions: number; deletions: number; total: number };
}

export interface ForgeCommitFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions?: number;
  deletions?: number;
  patch?: string;
  binary?: boolean;
}

export interface ForgeCommitDetail extends ForgeCommit {
  files: ForgeCommitFile[];
}

export interface ForgeMR {
  id: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl?: string;
  state?: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total?: number;
  hasMore: boolean;
}

export const emptyPage = <T>(page = 1, pageSize = 50): Page<T> => ({
  items: [],
  page,
  pageSize,
  hasMore: false,
});

/* ───────────────────────────── filters ───────────────────────────── */

export type FilterSpec =
  | { key: "keyword"; kind: "text"; label?: string }
  | { key: "type" | "status" | "state"; kind: "multi"; options: Array<{ value: string; label: string }>; label?: string }
  | { key: "assignee"; kind: "user"; label?: string }
  | { key: "labels"; kind: "tags"; label?: string }
  | { key: "excludeTerminal"; kind: "bool"; label: string }
  | { key: "created" | "updated"; kind: "range"; label?: string };

/** Normalized filter values collected from the UI / agent tools. */
export interface WorkItemFilter {
  keyword?: string;
  types?: string[];
  statuses?: string[];
  states?: string[];
  assignee?: string;
  labels?: string[];
  excludeTerminal?: boolean;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
}

/* ───────────────────────────── auth ───────────────────────────── */

export interface PatField {
  key: string;
  label: string;
  kind: "text" | "password" | "url";
  required?: boolean;
  placeholder?: string;
  helpUrl?: string;
  helpText?: string;
}

export interface ProviderConfig {
  authType?: "pat" | "oauth" | "gh";
  /** PAT or OAuth access token (server only). gh mode resolves the token on demand. */
  token?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiry?: number;
  orgId?: string;
  baseUrl?: string;
  /** gh CLI mode: host (github.com / GHES) and optional account login. */
  ghHost?: string;
  ghUser?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Redirect URIs registered with the issued client_id (DCR); used to decide on re-registration. */
  clientRedirects?: string[];
  account?: ForgeAccount;
  /** Token is valid but the profile read failed (e.g. missing read_user scope). */
  accountError?: string;
  needsLogin?: boolean;
  /* ── instance layer (multi-account) ── */
  /** Owning platform id (redundant with the file name; kept for robustness). */
  platform?: string;
  /** User-facing alias; the only editable name of an instance. */
  alias?: string;
  /** true until the user edits the alias; auto-filled from the tested account. */
  aliasAuto?: boolean;
  /** Epoch ms (instance ordering). */
  createdAt?: number;
}

/** One configured account (instance) of a platform. */
export interface ProviderInstance {
  /** Stable id: `<platform>` for the default instance, `<platform>~<slug>` otherwise. */
  id: string;
  platform: string;
  /** Display alias (may be empty until the first successful auth test). */
  alias: string;
  createdAt: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiry?: number;
  tokenType?: string;
}

export interface OAuthMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  issuer?: string;
  /** Endpoints may live on a different domain than the API base. */
  extra?: Record<string, string>;
}

export interface OAuthStartInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}

export interface OAuthExchangeInput {
  clientId?: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OAuthRefreshInput {
  clientId?: string;
  clientSecret?: string;
  refreshToken: string;
}

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult = { status: "pending" | "slow_down" } | OAuthTokens;

export interface ForgeOAuthDriver {
  /** dcr-pkce = DCR + PKCE (Yunxiao); device-code = RFC 8628 (GitHub/GitLab); client-credentials = pre-registered app. */
  mode: "dcr-pkce" | "device-code" | "client-credentials";
  /** Static endpoints for providers without discovery. */
  endpoints?: { authorizationEndpoint: string; tokenEndpoint: string };
  /** Built-in shared app client id (public; settings override wins). */
  defaultClientId?: string;
  discover?(cfg: ProviderConfig, http: Http): Promise<OAuthMeta>;
  /** Providers whose endpoints depend on baseUrl (GHES / self-hosted GitLab). */
  metaFor?(cfg: ProviderConfig): OAuthMeta;
  register?(cfg: ProviderConfig, meta: OAuthMeta, redirectUris: string[]): Promise<{ clientId: string; raw?: unknown }>;
  /** device-code: request a device/user code pair. */
  deviceStart?(cfg: ProviderConfig, meta: OAuthMeta, p: { clientId: string; scope?: string }): Promise<DeviceGrant>;
  /** device-code: one poll; the orchestrator handles interval / slow_down / expiry. */
  devicePoll?(cfg: ProviderConfig, meta: OAuthMeta, p: { clientId: string; deviceCode: string }): Promise<DevicePollResult>;
  scope?: string;
  authorizeUrl(cfg: ProviderConfig, meta: OAuthMeta, input: OAuthStartInput): string;
  exchange(cfg: ProviderConfig, meta: OAuthMeta, input: OAuthExchangeInput): Promise<OAuthTokens>;
  refresh?(cfg: ProviderConfig, meta: OAuthMeta, input: OAuthRefreshInput): Promise<OAuthTokens>;
  /** Turn the fresh tokens into the account the UI shows. */
  account(cfg: ProviderConfig, http: Http, tokens: OAuthTokens): Promise<ForgeAccount>;
}

/* ───────────────────────────── http ───────────────────────────── */

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch;
}

export interface Http {
  readonly baseUrl: string;
  req<T = unknown>(path: string, opts?: HttpRequestOptions): Promise<HttpResponse<T>>;
  json<T = unknown>(path: string, opts?: HttpRequestOptions): Promise<T>;
}

/* ───────────────────────────── provider ───────────────────────────── */

export interface ProviderCapabilities {
  workItems?: {
    scope: "project" | "repo" | "both";
    filters: FilterSpec[];
    comments: boolean;
  };
  code?: {
    namespaces: boolean;
    repos: boolean;
    branches: boolean;
    mergeRequests: "read" | "write" | false;
    /** Extra repository browsing sources (repos surface view switch). */
    views?: { forks?: boolean; starred?: boolean; search?: boolean };
  };
  auth: Array<"pat" | "oauth" | "gh">;
  clone: Array<"ssh" | "https">;
}

export interface ProviderAuth {
  pat?: {
    fields: PatField[];
    validate(cfg: ProviderConfig, http: Http): Promise<ForgeAccount>;
  };
  oauth?: ForgeOAuthDriver;
  /** Use the logged-in `gh` CLI credential on demand (never persisted). */
  gh?: { label?: string; helpUrl?: string };
}

export interface ProviderWorkItems {
  listScopes(cfg: ProviderConfig, http: Http, page?: { page?: number; pageSize?: number; q?: string }): Promise<Page<ForgeProject | ForgeRepo>>;
  list(cfg: ProviderConfig, http: Http, scope: ForgeWorkItemScope, filter: WorkItemFilter, page?: { page?: number; pageSize?: number }): Promise<Page<ForgeWorkItem>>;
  get(cfg: ProviderConfig, http: Http, scope: ForgeWorkItemScope, id: string): Promise<ForgeWorkItem>;
  comments(cfg: ProviderConfig, http: Http, item: ForgeWorkItem): Promise<ForgeComment[]>;
  /** Open count + changes since the last seen mark (optional; tree badges fall back to hiding without it). */
  counts?(cfg: ProviderConfig, http: Http, scope: ForgeWorkItemScope, seenAt?: number): Promise<WICounts>;
}

export interface ProviderCode {
  listNamespaces?(cfg: ProviderConfig, http: Http, parentId: string | undefined, page?: { page?: number; pageSize?: number; q?: string }): Promise<Page<ForgeNamespace>>;
  listRepos(cfg: ProviderConfig, http: Http, namespace: string | undefined, page?: { page?: number; pageSize?: number; q?: string }): Promise<Page<ForgeRepo>>;
  getRepo?(cfg: ProviderConfig, http: Http, id: string): Promise<ForgeRepo>;
  listBranches(cfg: ProviderConfig, http: Http, repo: ForgeRepo, page?: { page?: number; pageSize?: number; q?: string }): Promise<Page<ForgeBranch>>;
  createMR?(cfg: ProviderConfig, http: Http, repo: ForgeRepo, input: { sourceBranch: string; targetBranch: string; title: string; description?: string; workItemIds?: string[] }): Promise<ForgeMR>;
  cloneUrls?(repo: ForgeRepo): { ssh?: string; http?: string } | null;
  /** Read-only repository browsing. */
  listTree?(cfg: ProviderConfig, http: Http, repo: ForgeRepo, q: { ref?: string; path?: string }): Promise<ForgeTreeEntry[]>;
  getFile?(cfg: ProviderConfig, http: Http, repo: ForgeRepo, q: { ref?: string; path: string }): Promise<ForgeFileContent>;
  listCommits?(cfg: ProviderConfig, http: Http, repo: ForgeRepo, q: { ref?: string; path?: string; page?: number; pageSize?: number }): Promise<Page<ForgeCommit>>;
  getCommit?(cfg: ProviderConfig, http: Http, repo: ForgeRepo, q: { sha: string }): Promise<ForgeCommitDetail>;
  /** Repositories starred by the user (repos surface "★ Star" view). */
  listStarred?(cfg: ProviderConfig, http: Http, page?: { page?: number; pageSize?: number; q?: string }): Promise<Page<ForgeRepo>>;
  /** User's forked repositories (repos surface "Fork" view). */
  listForks?(cfg: ProviderConfig, http: Http, page?: { page?: number; pageSize?: number; q?: string }): Promise<Page<ForgeRepo>>;
  /** Remote repository search across namespaces (public repos included). */
  searchRepos?(cfg: ProviderConfig, http: Http, q: string, page?: { page?: number; pageSize?: number }): Promise<Page<ForgeRepo>>;
}

export interface ForgeProvider {
  id: ProviderId;
  label: string;
  icon?: string;
  contract: 1;
  capabilities: ProviderCapabilities;
  auth: ProviderAuth;
  /** Build the provider's HTTP client for a config (headers/base URL/auth scheme). */
  httpFor(cfg: ProviderConfig): Http;
  /** Server-side file proxy for authenticated attachments/images (e.g. Yunxiao work-item files). */
  fileProxy?: {
    allowedHosts: string[];
    pathPrefixes: string[];
    authHeaders(cfg: ProviderConfig): Record<string, string>;
    /** Resolve a stable file reference (work item + file id) to a temporary download URL. */
    resolve?(cfg: ProviderConfig, http: Http, p: { workitemId: string; fileId: string }): Promise<{ url: string; name?: string; contentType?: string }>;
  };
  workItems?: ProviderWorkItems;
  code?: ProviderCode;
  web?: {
    workItem?(item: ForgeWorkItem): string | null;
    project?(project: ForgeProject): string | null;
    repo?(repo: ForgeRepo): string | null;
  };
  format?: {
    defaults: { branch: string; paste: string; ai: string };
    branchVars?(item: ForgeWorkItem): Record<string, string>;
  };
  /** Default API base when no explicit baseUrl is configured. */
  defaultBaseUrl?: string;
  /** Allowed hosts for outbound API calls (hostname suffix match). */
  allowedHosts?: string[];
  /** Self-hosted deployments (GHES / GitLab) may use an operator-supplied base URL. */
  allowsCustomBaseUrl?: boolean;
  /** Hosts accepted for clone URLs (exact host or suffix). */
  cloneHosts?: string[];
}

/* ───────────────────────────── public descriptors ───────────────────────────── */

/** Manifest-safe provider description returned by GET /providers. */
export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  icon?: string;
  contract: 1;
  capabilities: ProviderCapabilities;
  auth: {
    pat?: { fields: PatField[] };
    oauth?: { mode: "dcr-pkce" | "device-code" | "client-credentials"; scope?: string; clientFields?: PatField[]; defaultClientId?: string; refresh?: boolean };
    gh?: { label?: string; helpUrl?: string };
  };
  defaultBaseUrl?: string;
  defaults: { branch: string; paste: string; ai: string };
}

export const DEFAULT_TEMPLATES = {
  branch: "{type}_{id}",
  paste: "#{id} {type} {title}\n{description}",
  ai: "#{id} {type} {title}\n{description}",
} as const;

export function describeProvider(p: ForgeProvider): ProviderDescriptor {
  const oauth = p.auth.oauth;
  return {
    id: p.id,
    label: p.label,
    icon: p.icon,
    contract: 1,
    capabilities: p.capabilities,
    auth: {
      ...(p.auth.pat ? { pat: { fields: p.auth.pat.fields } } : {}),
      ...(p.auth.gh ? { gh: p.auth.gh } : {}),
      ...(oauth
        ? {
            oauth: {
              mode: oauth.mode,
              scope: oauth.scope,
              // Whether expired tokens can be renewed in place; the settings UI
              // recommends a PAT when false (sign-in is the only renewal path).
              refresh: typeof oauth.refresh === "function",
              ...(oauth.defaultClientId ? { defaultClientId: oauth.defaultClientId } : {}),
              // For client-credentials providers the UI must ask for an app registration.
              ...(oauth.mode === "client-credentials"
                ? {
                    clientFields: [
                      { key: "clientId", label: "Client ID", kind: "text", required: true },
                      { key: "clientSecret", label: "Client Secret", kind: "password", required: true },
                    ] satisfies PatField[],
                  }
                : oauth.mode === "device-code"
                  ? { clientFields: [{ key: "clientId", label: "Shared App Client ID", kind: "text", required: true }] satisfies PatField[] }
                  : {}),
            },
          }
        : {}),
    },
    defaultBaseUrl: p.defaultBaseUrl,
    defaults: p.format?.defaults ?? DEFAULT_TEMPLATES,
  };
}

/* ───────────────────────────── helpers ───────────────────────────── */

export function scopeOfWorkItem(item: ForgeWorkItem): ForgeWorkItemScope {
  return item.scope;
}

export function stateFromStateString(s: string | undefined | null): WorkItemState {
  const v = String(s || "").toLowerCase();
  if (v === "open" || v === "opened" || v === "reopened") return "open";
  if (v === "closed" || v === "completed" || v === "done") return "closed";
  return "other";
}

/** Human display label for a work item: "#123 title". */
export function workItemRef(item: ForgeWorkItem): string {
  const key = item.key || item.id;
  return `#${key} ${item.title}`;
}
