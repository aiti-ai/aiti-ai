/**
 * SessionProvider — Layer 1 factories that create SessionHandles.
 *
 * A provider knows HOW to bring up (or connect to) an agent backend and wrap
 * it in a SessionHandle. The registry below is the single place where new
 * backends get wired in; API routes and UI never import provider modules
 * directly.
 *
 * Providers shipped (built-in):
 *
 *   local   — current pi-web behavior: createAgentSessionFromServices()
 *             in-process, wrapped by AgentSessionWrapper. Full capabilities.
 *
 *   attach  — connect to an already-running agent process (pi TUI + bridge
 *             extension) over a Unix socket. Prompt/abort/events flow through
 *             the socket; deep SDK operations degrade per capabilities.
 *             (Phase 1 target — see docs for the extension side.)
 *
 *   spawn   — launch `pi --mode rpc` as a detached child process and drive it
 *             via the SDK's RpcClient. Long-term multi-agent frontend path;
 *             also the natural adapter point for external CLIs.
 *
 * Extension-registered providers (slot):
 *
 *   pi-web extensions register backends from their server startup hook via
 *   ctx.sessionProviders.register() — see lib/ext/types.ts. Registry keys are
 *   namespaced as "<extensionId>/<type>" so extensions cannot shadow built-ins
 *   or each other, and are auto-unregistered on extension shutdown/reload.
 */

import type { SessionCapabilities, SessionHandle } from "./types";

/** Options accepted by every provider's createSession. */
export interface CreateSessionOptions {
  /** Existing session file to open. Omit to start a fresh session. */
  sessionFile?: string;
  /** Native session id inside the source agent (for resume-style backends). */
  sessionId?: string;
  /** Model to start the session with (cc-switch semantics: applied at creation). */
  model?: { provider: string; id: string };
  /** 命名启动档案（cc-switch 风格，如 "deepseek" → 后端映射为 --settings 等注入）。 */
  profile?: string;
  /** Working directory (required for fresh sessions). */
  cwd?: string;

  // ---- attach/spawn specific ----

  /** Unix socket path to connect to (attach provider). */
  socketPath?: string;
  /** Extra environment for spawned processes (spawn provider). */
  env?: Record<string, string>;
}

export interface SessionProvider {
  /** Registry name, also the SessionHandle.source value. */
  readonly type: string;

  /**
   * Resolution priority when multiple providers claim the same agentKey
   * (openExternalSession candidate ordering). Higher = preferred.
   * Rationale: native CLI drivers beat generic bridges for the same agent.
   */
  readonly priority?: number;

  /** Human label for UI pickers. */
  readonly label: string;

  /**
   * Which external agent this backend can DRIVE, using the same agent keys as
   * the all-sessions index ("claude" | "qoder" | "codex" | ... — see
   * pi-web-ext/session-manager/lib/agents/types.ts AgentAdapter.id).
   *
   * This is the join key between the two registries:
   *
   *   all-sessions row  "claude:<sid>"  (historical, read-only)
   *        │ splitExtId → ("claude", "<sid>")
   *        ▼
   *   findProvidersForAgent("claude") → providers that can resume/drive it
   *        ▼
   *   createSession({ sessionId: "<sid>" }) → live SessionHandle
   *
   * Multiple providers may share one agentKey (e.g. a read-only parser and a
   * CLI-resume spawner); undefined means host-native ("pi") or N/A.
   */
  readonly agentKey?: string;

  /**
   * Upper bound of capabilities this provider can ever offer. Individual
   * handles may report less (e.g. an attached agent lacking model switching).
   */
  readonly maxCapabilities: SessionCapabilities;

  /**
   * Bring up a session handle. Implementations should be idempotent per
   * sessionFile where meaningful (returning the same live handle instead of
   * duplicating processes).
   */
  createSession(options: CreateSessionOptions): Promise<SessionHandle>;

  /**
   * 该 provider 是否认领此会话文件（如 TUI 桥注册表命中）。
   * 认领 = 单写者规则生效：核心不得本地打开，须走 createSession 附着。
   * 数据（注册表格式）归扩展所有——核心只问“谁认领”。
   */
  ownsFile?(sessionFile: string): Promise<boolean> | boolean;

  /**
   * Tear down any provider-global resources (socket servers, connection
   * pools). Called on server shutdown.
   */
  shutdown?(): Promise<void>;

  /**
   * 可用启动档案清单（cc-switch 风格；如 CC 扫 ~/.claude/<name>.json）。
   * 只返回 name/path——档案内容含凭证，永不出服务端。
   */
  listProfiles?(): Promise<Array<{ name: string; path: string }>>;
}

// ============================================================================
// Registry
// ============================================================================

// globalThis 存储与 __piWebExt/__piSessions 同理：Next.js dev/HMR 下
// instrumentation 与各 route 可能拿到不同模块副本，模块级 Map 会分裂——
// 注册（ext 宿主启动时）与查询（API 路由）必须指向同一份。
declare global {
  var __sessionProviders: Map<string, SessionProvider> | undefined;
  var __extSessionProviders: Map<string, Set<string>> | undefined;
}

function providerMap(): Map<string, SessionProvider> {
  if (!globalThis.__sessionProviders) globalThis.__sessionProviders = new Map();
  return globalThis.__sessionProviders;
}

function extOwnedMap(): Map<string, Set<string>> {
  if (!globalThis.__extSessionProviders) globalThis.__extSessionProviders = new Map();
  return globalThis.__extSessionProviders;
}


function assertValidType(type: string): void {
  if (!type || type.includes("/")) {
    throw new Error(`Session provider type must be non-empty and contain no "/": got "${type}"`);
  }
}

/** Register a built-in provider. Later registration with the same type replaces earlier (dev HMR). */
export function registerProvider(provider: SessionProvider): void {
  assertValidType(provider.type);
  if (provider.type.includes(".")) {
    // Dots are reserved for namespaced extension providers — keep the two
    // namespaces visually distinct ("local" vs "my-ext/my-backend").
    throw new Error(
      `Built-in provider type must not contain "." (reserved for extension namespaces): "${provider.type}"`,
    );
  }
  providerMap().set(provider.type, provider);
}

/**
 * Register a provider on behalf of an extension. The effective registry key is
 * `"<extensionId>/<provider.type>"`, so extensions cannot shadow built-ins or
 * each other. Extension providers are auto-unregistered when the extension
 * shuts down or hot-reloads.
 *
 * Returns the full registry key callers must use in createSessionHandle({ providerType }).
 */
export function registerExtensionProvider(extensionId: string, provider: SessionProvider): string {
  assertValidType(provider.type);
  const key = `${extensionId}/${provider.type}`;
  const wrapped: SessionProvider = {
    ...provider,
    type: key,
  };
  providerMap().set(key, wrapped);
  let owned = extOwnedMap().get(extensionId);
  if (!owned) {
    owned = new Set();
    extOwnedMap().set(extensionId, owned);
  }
  owned.add(key);
  return key;
}

/**
 * Unregister every provider an extension registered (shutdown / reload).
 * Invokes each provider's own shutdown() best-effort before removal.
 * Returns the removed keys. Safe to call for unknown extension ids.
 */
export function unregisterExtensionProviders(extensionId: string): string[] {
  const owned = extOwnedMap().get(extensionId);
  if (!owned) return [];
  const removed = [...owned];
  for (const key of removed) {
    const provider = providerMap().get(key);
    providerMap().delete(key);
    try {
      void provider?.shutdown?.();
    } catch {
      // best-effort; provider is already deregistered
    }
  }
  extOwnedMap().delete(extensionId);
  return removed;
}

/** Remove every extension-registered provider (server / registry teardown). */
export async function cleanupAllExtensionProviders(): Promise<void> {
  for (const extId of [...extOwnedMap().keys()]) {
    unregisterExtensionProviders(extId);
  }
}

export function getProvider(type: string): SessionProvider | undefined {
  return providerMap().get(type);
}

/** Remove a specific provider by full registry key. Returns true if existed. */
export function removeProvider(type: string): boolean {
  return providerMap().delete(type);
}

/**
 * All providers that can drive the given external agent (all-sessions agent
 * key, e.g. "claude"). Ordered by registration; first match wins for resume.
 */
export function findProvidersForAgent(agentKey: string): SessionProvider[] {
  return [...providerMap().values()]
    .filter((p) => p.agentKey === agentKey)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function listProviders(): SessionProvider[] {
  return [...providerMap().values()];
}

/**
 * Default provider used when a request doesn't specify one. Kept as "local"
 * so existing behavior is untouched until opt-in backends land.
 */
export const DEFAULT_PROVIDER_TYPE = "local";

/** Shutdown every registered provider (server teardown). */
export async function shutdownAllProviders(): Promise<void> {
  await Promise.all(
    [...providerMap().values()].map((p) => p.shutdown?.().catch(() => {})),
  );
}
