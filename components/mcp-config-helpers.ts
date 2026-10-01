import type {
  McpAvailability,
  McpCodemodeInfo,
  McpConfigFileInfo,
  McpConfigFileProblem,
  McpErrorResponse,
  McpProjectInfo,
  McpRefusalReason,
  McpResponse,
  McpScope,
  McpServerInfo,
} from "@/lib/api-types";

// Pure helpers for Settings › MCP (components/McpConfig.tsx): what each row
// shows, how the groups are built, and how the overview is loaded. Client-safe:
// types and fetch only. Every state here is derived from the files GET /api/mcp
// read; nothing says whether a session actually connected a server.

/** The sidebar selection of the Code mode row; a server's key always holds a NUL. */
export const MCP_CODEMODE_SELECTION = "codemode";

/** A server's sidebar selection: its scope and name, which are unique within one listing. */
export function mcpServerKey(server: Pick<McpServerInfo, "scope" | "name">): string {
  return `${server.scope}\0${server.name}`;
}

/**
 * What a row says about an entry, from the file alone, most important first:
 * an entry pi refuses, one Pi Web refuses because it references
 * PI_WEB_PASSWORD, one turned off in the file, a project entry of a project
 * whose servers may not be read, a global entry the trusted project's entry of
 * the same name replaces, and MCP being off on this server. `on` means only
 * that a session would connect it; whether one did is not known here.
 */
export type McpServerRowState = "invalid" | "web-password" | "disabled" | "not-trusted" | "replaced" | "mcp-off" | "on";

export const MCP_SERVER_ROW_STATES: readonly McpServerRowState[] = [
  "invalid",
  "web-password",
  "disabled",
  "not-trusted",
  "replaced",
  "mcp-off",
  "on",
];

export interface McpRowContext {
  /** MCP is available on this Pi Web server (not turned off by the operator or a setting). */
  mcpAvailable: boolean;
  /** A session may read the project's `.pi/mcp.json` (see `mcpProjectServersLoad()`). */
  projectServersLoad: boolean;
}

/**
 * Whether sessions read the project's `.pi/mcp.json`: only while a decision,
 * exact or inherited, trusts the folder, as the MCP host's
 * `mayReadProjectConfigNow()` decides on every prompt. Not `trust.trusted`,
 * which is true for a folder that requires no trust; that folder has no
 * `.pi/mcp.json`, and one that appeared after the status was read is not read
 * without a decision. An unreadable trust store counts as untrusted.
 */
export function mcpProjectServersLoad(project: McpProjectInfo | undefined): boolean {
  return project?.trust?.decision === true;
}

export function mcpRowContext(data: Pick<McpResponse, "mcp" | "project">): McpRowContext {
  return { mcpAvailable: data.mcp.available, projectServersLoad: mcpProjectServersLoad(data.project) };
}

export function mcpServerRowState(server: McpServerInfo, context: McpRowContext): McpServerRowState {
  if (server.invalidError !== undefined) return "invalid";
  if (server.webPasswordField) return "web-password";
  if (!server.enabled) return "disabled";
  if (server.scope === "project" && !context.projectServersLoad) return "not-trusted";
  // The project's entry replaces this one only where it is read.
  if (server.scope === "global" && server.shadowedByProject && context.projectServersLoad) return "replaced";
  if (!context.mcpAvailable) return "mcp-off";
  return "on";
}

/** The full state text, for the row's accessible name and the detail pane. */
export const MCP_ROW_STATE_LABEL_KEYS: Record<McpServerRowState, string> = {
  invalid: "mcp.state.invalid",
  "web-password": "mcp.state.web-password",
  disabled: "mcp.state.disabled",
  "not-trusted": "mcp.state.not-trusted",
  replaced: "mcp.state.replaced",
  "mcp-off": "mcp.state.mcp-off",
  on: "mcp.state.on",
};

/**
 * The short text a row shows beside the name, so a state is never told by the
 * dot's color alone. None for `on`, and none for `mcp-off`, which the banner
 * above the list says once for every row.
 */
export const MCP_ROW_STATE_BADGE_KEYS: Partial<Record<McpServerRowState, string>> = {
  invalid: "mcp.stateShort.invalid",
  "web-password": "mcp.stateShort.web-password",
  disabled: "mcp.stateShort.disabled",
  "not-trusted": "mcp.stateShort.not-trusted",
  replaced: "mcp.stateShort.replaced",
};

export type McpStateTone = "on" | "off" | "warning" | "error";

/** How a state is colored: the dot, and the state text in the detail pane. */
export function mcpRowStateTone(state: McpServerRowState): McpStateTone {
  if (state === "on") return "on";
  if (state === "invalid" || state === "web-password") return "error";
  if (state === "not-trusted") return "warning";
  return "off";
}

/** `ConfigStatusDot` props for a tone: the accent for on, dim for off, else a warning or error color. */
export function mcpStatusDot(tone: McpStateTone): { active?: boolean; color?: string } {
  if (tone === "on") return { active: true };
  if (tone === "off") return { active: false };
  return { color: tone === "error" ? "#ef4444" : "#f59e0b" };
}

/** How a validated entry's tools reach the model (the SDK's `exposure`, `codemode` by default). */
export const MCP_EXPOSURE_KEYS: Record<NonNullable<McpServerInfo["exposure"]>, string> = {
  codemode: "mcp.exposure.codemode",
  "codemode-deferred": "mcp.exposure.codemode-deferred",
  deferred: "mcp.exposure.deferred",
  direct: "mcp.exposure.direct",
  hidden: "mcp.exposure.hidden",
};

/** A file problem other than this one means none of the file's servers is listed. */
export function isBlockingFileProblem(problem: McpConfigFileProblem): boolean {
  return problem.reason !== "auto-enable-codemode-invalid";
}

export interface McpServerGroup {
  scope: McpScope;
  /** Absent when the file was not read: a project the route refused (see the load's `projectError`). */
  file?: McpConfigFileInfo;
  servers: McpServerInfo[];
}

/**
 * The sidebar groups: Project first, as in the other panels, but only with a
 * project; Global always. The project group stays when its file is missing or
 * was not read, so the panel says so instead of hiding where project servers go.
 */
export function mcpServerGroups(data: Pick<McpResponse, "files" | "servers">, hasProject: boolean): McpServerGroup[] {
  const scopes: McpScope[] = hasProject ? ["project", "global"] : ["global"];
  return scopes.map((scope) => {
    const file = data.files.find((info) => info.scope === scope);
    return {
      scope,
      ...(file ? { file } : {}),
      servers: data.servers.filter((server) => server.scope === scope),
    };
  });
}

/** Turned-on and total entries, the `n/m` a group heading shows. */
export function mcpGroupCounts(servers: readonly Pick<McpServerInfo, "enabled">[]): { enabled: number; total: number } {
  return { enabled: servers.filter((server) => server.enabled).length, total: servers.length };
}

/** Why a group lists nothing, when it lists nothing. */
export function mcpGroupEmptyKey(group: McpServerGroup): string | undefined {
  if (group.servers.length > 0) return undefined;
  if (!group.file) return "mcp.group.notListed";
  if (group.file.problems.some(isBlockingFileProblem)) return "mcp.group.fileProblem";
  return "mcp.group.empty";
}

/**
 * What the detail pane says with no row selected: to pick one, or, with
 * nothing listed, that a file problem hides the servers or that there are none.
 */
export function mcpEmptyDetailKey(serverCount: number, files: readonly McpConfigFileInfo[]): string {
  if (serverCount > 0) return "mcp.selectItem";
  return files.some((file) => file.problems.some(isBlockingFileProblem)) ? "mcp.emptyFileProblem" : "mcp.empty";
}

/**
 * The row to select after a load: the remembered one while it still exists,
 * else the first server (the project's first), else none, which shows the
 * empty state. Code mode is always there.
 */
export function pickMcpSelection(groups: readonly McpServerGroup[], current: string | null): string | null {
  const keys = groups.flatMap((group) => group.servers.map(mcpServerKey));
  if (current === MCP_CODEMODE_SELECTION || (current !== null && keys.includes(current))) return current;
  return keys[0] ?? null;
}

export interface McpNoticeText {
  key: string;
  params?: Record<string, string>;
}

/** Why no session connects any server: MCP is off, with the reason the route gave. */
export function mcpUnavailableNotice(mcp: McpAvailability): McpNoticeText | undefined {
  if (mcp.available) return undefined;
  if (mcp.reason === "builtin-disabled") {
    return mcp.settingsPath
      ? { key: "mcp.unavailable.builtin-disabled", params: { path: mcp.settingsPath } }
      : { key: "mcp.unavailable.builtin-disabled-unknown" };
  }
  return { key: mcp.reason === "operator-disabled" ? "mcp.unavailable.operator-disabled" : "mcp.unavailable.internals-unavailable" };
}

export type McpTrustNotice =
  /** The project servers do not connect; the trust notice (a button arrives with the trust dialog wiring). */
  | (McpNoticeText & { kind: "untrusted" })
  /** They connect because an ancestor is trusted, which every folder under it shares. */
  | (McpNoticeText & { kind: "inherited" });

/**
 * What the panel says about the project's trust, only when the project has a
 * `.pi/mcp.json` (or a problem with one), since that is all trust changes here:
 * that its servers do not connect, naming the folder an inherited `false` was
 * recorded for, or that they connect through an ancestor's trust. The trust
 * dialog never opens for a folder trusted through a parent, so this is where
 * that trust is visible.
 *
 * Nothing is said for a folder that requires no trust, unless a decision
 * marks it untrusted: the reader lists a `.pi/mcp.json` that is a dangling
 * link, while the SDK's `existsSync` follows it, finds nothing, and so has
 * nothing to trust (`POST /api/project-trust` answers `trust-not-required`).
 * The footer's file problem explains that file instead.
 */
export function mcpTrustNotice(project: McpProjectInfo | undefined, projectFile: McpConfigFileInfo | undefined): McpTrustNotice | undefined {
  if (!project || !projectFile || (!projectFile.exists && projectFile.problems.length === 0)) return undefined;
  const { trust } = project;
  if (!trust) return { kind: "untrusted", key: "mcp.trust.unreadable" };
  if (!trust.requiresTrust && trust.decision !== false) return undefined;
  if (trust.decision === true) {
    return trust.inherited && trust.decisionPath
      ? { kind: "inherited", key: "mcp.trust.trustedThrough", params: { path: trust.decisionPath } }
      : undefined;
  }
  if (trust.decision === false && trust.inherited && trust.decisionPath) {
    return { kind: "untrusted", key: "mcp.trust.untrustedThrough", params: { path: trust.decisionPath } };
  }
  return { kind: "untrusted", key: "mcp.trust.untrusted" };
}

/** Every file problem, the global file's first, for the footer. */
export function mcpFileProblems(files: readonly McpConfigFileInfo[]): { file: McpConfigFileInfo; problem: McpConfigFileProblem }[] {
  return [...files]
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "global" ? -1 : 1))
    .flatMap((file) => file.problems.map((problem) => ({ file, problem })));
}

/** The `autoEnableCodemode` a session started now reads, and the file that sets it. */
export type McpAutoEnableCodemode = { value: true; path?: string } | { value: false; path: string };

/**
 * `autoEnableCodemode` as the SDK's `loadMcpConfig()` merges it: the project
 * file's value where a session reads that file, else the global file's, else
 * true. The MCP extension reads it on `session_start`, so it applies to
 * sessions started (or reloaded) afterwards.
 */
export function mcpEffectiveAutoEnableCodemode(data: Pick<McpResponse, "files" | "project">): McpAutoEnableCodemode {
  const project = data.files.find((file) => file.scope === "project");
  if (project?.autoEnableCodemode !== undefined && mcpProjectServersLoad(data.project)) {
    return project.autoEnableCodemode ? { value: true, path: project.path } : { value: false, path: project.path };
  }
  const global = data.files.find((file) => file.scope === "global");
  if (global?.autoEnableCodemode !== undefined) {
    return global.autoEnableCodemode ? { value: true, path: global.path } : { value: false, path: global.path };
  }
  return { value: true };
}

/**
 * Why the tools of a server with `codemode` or `codemode-deferred` exposure,
 * which only Code mode scripts call, may not be callable, most decisive first:
 * the sandbox cannot run (the MCP host then offers them through tool search),
 * `-builtin:codemode` registers no codemode tool (the host keeps their
 * exposure, so only an active tool search reaches them), or Automatic with
 * `autoEnableCodemode: false`, under which the MCP extension never turns Code
 * mode on. Undefined when a session turns Code mode on for them.
 */
export function mcpCodemodeReachNotice(codemode: McpCodemodeInfo, autoEnable: McpAutoEnableCodemode): McpNoticeText | undefined {
  if (codemode.sandbox.state === "unavailable") return { key: "mcp.exposure.sandboxUnavailable" };
  if (codemode.builtinDisabled) return { key: "mcp.exposure.builtinDisabled" };
  if (!autoEnable.value && codemode.preference !== "always") {
    return { key: "mcp.exposure.autoEnableOff", params: { path: autoEnable.path } };
  }
  return undefined;
}

/** The warning under Automatic when the file setting keeps it from ever turning Code mode on. */
export function mcpCodemodeAutomaticNotice(codemode: McpCodemodeInfo, autoEnable: McpAutoEnableCodemode): McpNoticeText | undefined {
  if (codemode.preference !== "automatic" || autoEnable.value) return undefined;
  return { key: "mcp.codemode.autoEnableOff", params: { path: autoEnable.path } };
}

export type McpCodemodeRowState = "automatic" | "always" | "unavailable" | "unknown";

/**
 * The Code mode row's state: unavailable when no session can offer it (its
 * sandbox failed the self-test, or `-builtin:codemode` turns it off), unknown
 * when the global settings file cannot be read, else the preference.
 */
export function mcpCodemodeRowState(codemode: McpCodemodeInfo): McpCodemodeRowState {
  if (codemode.builtinDisabled || codemode.sandbox.state === "unavailable") return "unavailable";
  return codemode.preference ?? "unknown";
}

export const MCP_CODEMODE_STATE_KEYS: Record<McpCodemodeRowState, string> = {
  automatic: "mcp.codemode.automatic",
  always: "mcp.codemode.always",
  unavailable: "mcp.codemode.unavailable",
  unknown: "i18n.unknown",
};

export function mcpCodemodeTone(state: McpCodemodeRowState): McpStateTone {
  if (state === "unavailable") return "error";
  return state === "unknown" ? "off" : "on";
}

// ---------------------------------------------------------------------------
// Loading GET /api/mcp
// ---------------------------------------------------------------------------

/** Why loading failed: a route refusal carries its `reason`; a network failure has none. */
export interface McpLoadFailure {
  error: string;
  reason?: McpRefusalReason;
  /** No answer within `MCP_OVERVIEW_TIMEOUT_MS`; the request was aborted. */
  timedOut?: boolean;
}

/**
 * How long a load may take, both requests included. Refresh is disabled while
 * one runs, so without a deadline a request that never answers (a stalled
 * compile, a slow scan of large skill folders) would leave the panel loading
 * with no way to retry until Settings is closed.
 */
export const MCP_OVERVIEW_TIMEOUT_MS = 15_000;

export type McpLoadResult =
  | {
      ok: true;
      data: McpResponse;
      /** The route refused the project folder, so only the global file was read. */
      projectError?: McpLoadFailure;
    }
  | { ok: false; error: McpLoadFailure };

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

function isMcpResponse(value: unknown): value is McpResponse {
  if (value === null || typeof value !== "object") return false;
  const data = value as Partial<McpResponse>;
  return typeof data.mcp === "object" && data.mcp !== null && typeof data.codemode === "object" && data.codemode !== null
    && Array.isArray(data.files) && Array.isArray(data.servers);
}

/** The URL of the overview: the global file alone without a project. */
export function mcpOverviewUrl(cwd: string | null): string {
  return cwd ? `/api/mcp?cwd=${encodeURIComponent(cwd)}` : "/api/mcp";
}

async function requestMcpOverview(cwd: string | null, fetchImpl: FetchLike, signal?: AbortSignal): Promise<McpLoadResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(mcpOverviewUrl(cwd), { cache: "no-store", signal });
  } catch (error) {
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: { error: `HTTP ${response.status}` } };
  }
  if (response.ok && isMcpResponse(data)) return { ok: true, data };
  const refusal = (data ?? {}) as Partial<McpErrorResponse>;
  return {
    ok: false,
    error: {
      error: typeof refusal.error === "string" ? refusal.error : `HTTP ${response.status}`,
      ...(typeof refusal.reason === "string" ? { reason: refusal.reason } : {}),
    },
  };
}

const CWD_REFUSALS = new Set<McpRefusalReason>(["cwd-invalid", "cwd-denied", "cwd-not-directory"]);

async function loadWithin(cwd: string | null, fetchImpl: FetchLike, signal: AbortSignal): Promise<McpLoadResult> {
  const first = await requestMcpOverview(cwd, fetchImpl, signal);
  if (first.ok || !cwd || !first.error.reason || !CWD_REFUSALS.has(first.error.reason)) return first;
  const global = await requestMcpOverview(null, fetchImpl, signal);
  return global.ok ? { ...global, projectError: first.error } : global;
}

/**
 * Loads the overview for the panel's project, or the global file alone without
 * one. A project folder the route refuses (removed since, or outside the
 * folders Pi Web may read) does not hide the global servers: they are loaded
 * again without it, and the refusal is kept for the Project group to explain.
 *
 * The whole load ends by `timeoutMs`, aborting what is still on its way. The
 * caller's `signal` is forwarded by hand, not with `AbortSignal.any()`, which
 * Safari supports only from 17.4 (this app supports 16.2). The deadline
 * resolves the race itself, so a fetch that ignores its signal cannot outlast it.
 */
export async function loadMcpOverview(
  cwd: string | null,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  signal?: AbortSignal,
  timeoutMs: number = MCP_OVERVIEW_TIMEOUT_MS,
): Promise<McpLoadResult> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<McpLoadResult>((resolve) => {
    timer = setTimeout(() => {
      // Settled before aborting, so the aborted fetch's failure cannot win the race.
      resolve({ ok: false, error: { error: `GET /api/mcp did not answer within ${timeoutMs} ms`, timedOut: true } });
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([loadWithin(cwd, fetchImpl, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}
