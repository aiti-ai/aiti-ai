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

import type { SessionCapabilities, SessionHandle } from "./types.ts";

/** Options accepted by every provider's createSession. */
export interface CreateSessionOptions {
  /** Existing session file to open. Omit to start a fresh session. */
  sessionFile?: string;
  /** Native session id inside the source agent (for resume-style backends). */
  sessionId?: string;
  /** Model to start the session with (cc-switch semantics: applied at creation). */
  model?: { provider: string; id: string };
  /** Named launch profile (cc-switch style, e.g. "deepseek" → backend maps to --settings style injection). */
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

  /**
   * UI listing position (backend dropdowns and other pickers). Lower = earlier;
   * default = 1000 (keeps registration order). Only used to move core backends
   * to the front (e.g. the pi spawn family); extension backends that leave this
   * unset keep registration order (backward compatible).
   *
   * Note the difference from {@link priority}: priority is the "claim resolution
   * priority for the same agentKey" (higher wins), order is the "picker display
   * position" (lower is earlier) — opposite directions.
   */
  readonly order?: number;

  /** Human label for UI pickers. */
  readonly label: string;

  /**
   * Which external agent this backend can DRIVE, using the same agent keys as
   * the all-sessions index ("claude" | "qoder" | "codex" | ... — see the
   * all-sessions agents adapter registry, AgentAdapter.id).
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
   * Static model catalog (fetchable without a session; feeds the picker when
   * choosing a backend on the new-session page). Optional: when absent the
   * catalog is bound to a session (e.g. ACP requires session/new) and the
   * frontend falls back to its local list.
   */
  listModels?(): Promise<Array<{ id: string; provider: string; label?: string }>>;

  /**
   * Manually refresh the model catalog (new-session page "refresh models"
   * button): bypass TTL/cache and force a real probe. Optional: when absent,
   * refresh is unsupported (route responds refreshable:false and the frontend
   * hides the button). Implementations own single-flight/timeout (shared with
   * startup probing); this contract adds no extra debounce.
   */
  refreshModels?(): Promise<Array<{ id: string; provider: string; label?: string }>>;

  /**
   * Bring up a session handle. Implementations should be idempotent per
   * sessionFile where meaningful (returning the same live handle instead of
   * duplicating processes).
   */
  createSession(options: CreateSessionOptions): Promise<SessionHandle>;

  /**
   * Whether this provider claims the given session file (e.g. a TUI bridge
   * registry hit). Claimed = single-writer rule applies: the core must not open
   * it locally and must attach via createSession. The data (registry format)
   * belongs to the extension — the core only asks "who claims it".
   */
  ownsFile?(sessionFile: string): Promise<boolean> | boolean;

  /**
   * Tear down any provider-global resources (socket servers, connection
   * pools). Called on server shutdown.
   */
  shutdown?(): Promise<void>;

  /**
   * Available launch profiles (cc-switch style; e.g. CC scans ~/.claude/<name>.json).
   * Only name/path are returned — profile contents contain credentials and never
   * leave the server.
   */
  listProfiles?(): Promise<Array<{ name: string; path: string }>>;
}

// ============================================================================
// Registry
// ============================================================================

// globalThis storage, same rationale as __piWebExt/__piSessions: under Next.js
// dev/HMR, instrumentation and routes may load different module copies, so a
// module-level Map would split — registration (ext host startup) and lookup
// (API routes) must point at the same instance.
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
  const all = [...providerMap().values()];
  // Stable sort by (order ?? 1000, insertion order) — providers without an
  // explicit `order` keep their registration sequence (backward compatible).
  return all
    .map((p, i) => ({ p, i, order: p.order ?? 1000 }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((x) => x.p);
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
