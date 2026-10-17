/**
 * Session abstraction — public surface.
 *
 * Layer map:
 *   types.ts        — SessionHandle, SessionCapabilities, errors (Layer 2)
 *   providers.ts    — provider registry incl. extension slot (Layer 1)
 *   handle-store.ts — live store for provider-created handles
 *   local.ts        — host-native adapter over rpc-manager (the ONLY built-in)
 *
 * Architecture rule (user directive): the core ships NO concrete agent
 * backends beyond the host-native local world. Every real backend — attach
 * (socket to a running agent), spawn (`pi --mode rpc` child), claude-code
 * resume, cc-connect hub, ... — is an extension registering through
 * ctx.sessionProviders at startup. First-party backends ship as separate
 * extension packages (e.g. session-attach, agent-echo); third parties follow
 * the same slot.
 *
 * Usage:
 *   import { createSessionHandle, listProviderInfos, openExternalSession } from "@/lib/session";
 */

// Layer 2 — contracts
export type {
  SessionHandle,
  SessionCapabilities,
  HandleEvent,
  HandleEventListener,
  HandleModel,
  HandleImage,
  HandleBashResult,
  HandleCommandInfo,
  PromptOptions,
} from "./types.ts";
export {
  FULL_CAPABILITIES,
  capabilities,
  guard,
  UnsupportedCapabilityError,
  SessionDeadError,
  BridgeOccupiedError,
} from "./types.ts";

// Layer 1 — registry (incl. extension slot lifecycle)
export type { SessionProvider, CreateSessionOptions } from "./providers.ts";
export {
  registerProvider,
  registerExtensionProvider,
  unregisterExtensionProviders,
  cleanupAllExtensionProviders,
  getProvider,
  findProvidersForAgent,
  listProviders,
  shutdownAllProviders,
  DEFAULT_PROVIDER_TYPE,
} from "./providers.ts";

// Live handle store (provider-created sessions)
export { putHandle, putHandleAt, getHandle, removeHandle, listHandleIds, listAllHandles, getHandleSessionInfos, getRunningHandleIds, extractFirstUserText, warmHandleFirstMessages } from "./handle-store.ts";

// Relay (agent-to-agent)
export { relayToSession, type RelayResult } from "./relay.ts";

// TUI bridge registry (session file → socket-ownership detection)

// Host-native adapter (wraps AgentSessionWrapper from rpc-manager)
export { createLocalHandle } from "./local.ts";

// Wrapper-compatible adapter (lets existing /api/agent/* routes drive handles)
export { HandleSessionAdapter, handleModelToClient, type WrappedSessionLike } from "./handle-adapter.ts";

import { getProvider, findProvidersForAgent, listProviders, DEFAULT_PROVIDER_TYPE } from "./providers.ts";
import type { CreateSessionOptions } from "./providers.ts";
import { BridgeOccupiedError } from "./types.ts";
import type { SessionCapabilities, SessionHandle } from "./types.ts";
import { getHandle as lookupHandle, putHandle, putHandleAt, listAllHandles } from "./handle-store.ts";
import { HandleSessionAdapter, type WrappedSessionLike } from "./handle-adapter.ts";
import { findBridgeSessionFileById, invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "../session-reader.ts"; // relative path + explicit extension: jiti does not resolve the @/ alias, and ESM requires extensions
import { ensurePlaceholder, rebindPlaceholder, aliasPlaceholder, getPlaceholder, isProvisionalExtSid } from "./placeholder.ts";

function listProviderNames(): string[] {
  return listProviders().map((p) => p.type);
}

/** Provider info for UI pickers / discovery endpoints. */
export type ProviderInfo = {
  type: string;
  label: string;
  /** External agent key this backend can drive (all-sessions join key), if any. */
  agentKey?: string;
  maxCapabilities: SessionCapabilities;
};

export function listProviderInfos(): ProviderInfo[] {
  return listProviders().map((p) => ({
    type: p.type,
    label: p.label,
    ...(p.agentKey ? { agentKey: p.agentKey } : {}),
    maxCapabilities: p.maxCapabilities,
  }));
}

/**
 * Split an all-sessions composite id ("claude:<uuid>") into its parts.
 * Plain ids are host-native pi sessions (agent "pi"). Same convention as
 * session-manager's lib/agents/types.ts splitExtId — keep both in sync.
 */
export function splitHandleId(id: string): { agent: string; sid: string } {
  const i = id.indexOf(":");
  if (i <= 0) return { agent: "pi", sid: id };
  return { agent: id.slice(0, i), sid: id.slice(i + 1) };
}

/**
 * Open a LIVE session for an all-sessions historical row (attach-from-history).
 *
 * Given a composite id like "claude:<sid>", resolves providers whose agentKey
 * matches the agent and creates a driving handle for the native session.
 * Browse old external sessions in All Sessions → open one → keep working in it
 * through pi-web. Returns undefined when no provider can drive that agent
 * (UI falls back to read-only viewer / import-to-pi flow).
 */
export async function openExternalSession(
  compositeId: string,
  options: Omit<CreateSessionOptions, "sessionFile"> & { sessionId?: string; /** Placeholder-file display name (the real title, passed when taking over from All Sessions) */ name?: string } = {},
): Promise<SessionHandle | undefined> {
  const requestedId = compositeId;
  const { agent } = splitHandleId(compositeId);
  let sid = splitHandleId(compositeId).sid;
  // new- placeholder revival guard (observed 2026-09-07): after the handle store is
  // emptied (extension reload/restart), an unmigrated ?session=agent:new-… URL in the
  // browser would hit the fallback branch below and re-instantiate the placeholder id
  // as a brand-new session — duplicate rows for the same session (placeholder row +
  // ephemeral row), and further messages fork a second backend session (history split).
  // A rebound placeholder id keeps an alias in the registry → open the real session
  // instead; no alias (an ephemeral session that never sent a first message, with no
  // content to reuse) → refuse and fall back to the historical behavior (404).
  if (isProvisionalExtSid(sid)) {
    const alias = getPlaceholder(compositeId);
    if (!alias || alias.extId === compositeId) return undefined;
    compositeId = alias.extId;
    sid = splitHandleId(compositeId).sid;
    options = { ...options, sessionId: sid }; // the caller-supplied placeholder sid is voided
  }
  // An alive handle already exists for this backend session (opened through any of
  // its doors: placeholder uuid / composite id / old placeholder alias) — reuse it
  // rather than rebuild: putHandle's overwrite semantics would dispose the previous
  // one, and the two doors would kill each other.
  for (const [key, existing] of listAllHandles()) {
    if (!existing.alive() || existing.id !== compositeId) continue;
    if (key !== compositeId) putHandleAt(compositeId, existing);
    if (requestedId !== compositeId) putHandleAt(requestedId, existing);
    return existing;
  }
  const candidates = findProvidersForAgent(agent);
  if (candidates.length === 0) return undefined;
  let lastError: unknown;
  for (const provider of candidates) {
    try {
      const handle = await provider.createSession({
        ...options,
        sessionId: options.sessionId ?? sid,
      });
      putHandle(handle);
      // Placeholder-alias revival path: the handle is stored under the real composite
      // id and double-registered under the requested id (old placeholder key), so
      // later GET/POST/SSE on /api/agent/<oldId> and /api/sessions/<oldId> hit the
      // table directly.
      if (requestedId !== handle.id) putHandleAt(requestedId, handle);
      // Takeover/restore paths also write a placeholder (resume semantics, extId
      // known): ⚡ taking over a history row, ?session= restore, and composite-id GET
      // all converge here.
      if (provider.agentKey) wireExternalPlaceholder(handle, true, options.cwd, options.name);
      return handle;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error(`No provider could open ${compositeId}`);
}

/** Registry key of the attach provider (registered by the attach extension at startup; undefined when the extension is not installed). */
function findAttachProviderType(): string | undefined {
  return listProviders().find((p) => p.type === "aiti-attach-agent/attach")?.type;
}

/**
 * After the bridge claims a session, shut down an unexpected local wrapper for the
 * same session (single-writer recovery).
 *
 * Background (reproduced 2026-08-30): when the TUI bridge registers later than the
 * web app's first open (opening the session seconds after `pi -c` starts, or a
 * browser SSE reconnect landing in the TUI restart gap), the SSE/prompt routes
 * start a local runtime first via startRpcSession during the registry-miss window.
 * The bridge then finishes registering → split-brain: POST goes to the bridge
 * (attach preferred) while GET/SSE still favor the local twin — users see "first
 * connect fails, switching away and back fixes it". Attaching successfully shuts
 * the twin down; the next poll self-heals.
 */
async function shutdownStrayLocalRuntime(sessionId: string, sessionFile: string): Promise<void> {
  try {
    const { getRpcSession } = await import("../rpc-manager.ts");
    for (const key of new Set([sessionId, sessionFile])) {
      const twin = getRpcSession(key);
      if (twin?.isAlive()) {
        console.warn(`[session] bridge claimed "${sessionFile}" — shutting down stray local runtime (race-window twin)`);
        await twin.shutdown().catch(() => {});
      }
    }
  } catch { /* rpc-manager unavailable (heavily trimmed environments) — skip the cleanup */ }
}

/**
 * When a session file is owned by a running TUI bridge, lazily create an attach
 * handle and store it (key = file path). Ownership is negotiated through
 * provider.ownsFile — the registry format belongs to the extension; the core
 * knows nothing about it.
 *
 * Semantics (single-writer invariant):
 *   - no claim           → undefined (caller takes the local path)
 *   - claimed + attached → adapter
 *   - claimed + failed   → BridgeOccupiedError (refuse local open, never fork silently)
 */
export async function attachIfBridged(
  sessionFile: string,
): Promise<WrappedSessionLike | undefined> {
  // Reuse an already-attached handle — otherwise creating a new connection per
  // request would dispose the old handle currently watched by SSE (putHandle's
  // overwrite semantics)
  const existingHandle = lookupHandle(sessionFile);
  if (existingHandle?.alive()) return new HandleSessionAdapter(existingHandle);

  const candidates = listProviders().filter((p) => p.ownsFile);
  for (const provider of candidates) {
    let claimed = false;
    try {
      claimed = await provider.ownsFile!(sessionFile);
    } catch (e) {
      console.error(`[session] ${provider.type}.ownsFile failed:`, e instanceof Error ? e.message : e);
      continue;
    }
    if (!claimed) continue;
    try {
      // The attach handle's id must be the public session uuid (not the file path) —
      // /api/agent/[id]'s resolveAnySession(id) looks up the handle store by id; a
      // mismatched id makes GET/SSE all 404 and the frontend chat window never sees
      // live state. Double-key registration: uuid (authoritative) + file path
      // (compat with the existing lookupHandle(sessionFile) reuse semantics).
      const sessionUuid = (sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/) ?? [null, sessionFile])[1];
      const handle = await provider.createSession({
        sessionFile,
        sessionId: sessionUuid,
      });
      putHandle(handle);
      if (sessionUuid !== sessionFile) putHandleAt(sessionFile, handle);
      // Single-writer cleanup: the bridge claimed the session → the local twin started
      // in the race window must go (run in the background, don't block the return)
      void shutdownStrayLocalRuntime(sessionUuid, sessionFile);
      return new HandleSessionAdapter(handle);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Ghost-claim defense: ownsFile claims ownership but createSession itself cannot
      // resolve a bridge socket — the claim has diverged from registry reality (stale
      // module graph/stale state); treat it as unclaimed (local open is safe: in a
      // genuine ownership scenario readBridgeRegistry's pid+socket dual liveness check
      // prunes dead entries first).
      if (/no bridge socket/i.test(msg)) {
        console.warn(`[session] ${provider.type} claimed "${sessionFile}" but resolves no bridge socket — treating claim as stale`);
        continue;
      }
      throw new BridgeOccupiedError(sessionFile, msg);
    }
  }
  return undefined;
}

/**
 * When a session file is owned by a running TUI bridge, lazily create an attach
 * handle and store it (key = file path).
 * Single-writer rule: while the TUI owns the session, the web app never opens the
 * file locally.
 * Returns the adapter, or undefined (callers take the local path when there is no
 * bridge / the socket is unreachable).
 */

/**
 * Resolve a live session by id across BOTH registries: local sessions
 * (rpc-manager) win first, then provider handles wrapped in the
 * wrapper-compatible adapter. Returns undefined when neither has it.
 *
 * /api/agent/[id] and /events use this so the existing chat flow drives any
 * backend without frontend changes.
 */
export function resolveAnySession(id: string): WrappedSessionLike | undefined {
  // Local registry is consulted by callers first (they import getRpcSession);
  // this helper is the handle-side fallback.
  const handle = lookupHandle(id);
  if (!handle) return undefined;
  return new HandleSessionAdapter(handle);
}

/**
 * Resolve attach by id (socket first): on handle-store miss, read the bridge
 * registry to reverse-look-up the registry key (= sessionFile, independent of the
 * file having been written) and attach. Empty/unindexed sessions get a live
 * attachment for /api/agent/[id] (GET/SSE) this way; the file is history replay only.
 */
export async function resolveAttachBySessionId(id: string): Promise<WrappedSessionLike | undefined> {
  const bridgeFile = await findBridgeSessionFileById(id);
  if (!bridgeFile) return undefined;
  try {
    const bridged = await attachIfBridged(bridgeFile);
    return bridged?.isAlive() ? bridged : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a session handle through the registry and store it for later lookup.
 * Falls back to the default provider when `providerType` is omitted.
 * Non-default handles are stored in the global handle store; default ("local")
 * sessions stay in rpc-manager's registry.
 */
export async function createSessionHandle(
  options: CreateSessionOptions & { providerType?: string },
): Promise<SessionHandle> {
  const type = options.providerType ?? DEFAULT_PROVIDER_TYPE;
  const provider = getProvider(type);
  if (!provider) {
    throw new Error(
      `Unknown session provider "${type}". Known providers: ${listProviderNames().join(", ")}` +
        (listProviders().length === 0 ? " (none registered — backend extensions not loaded?)" : ""),
    );
  }
  const handle = await provider.createSession(options);
  if (type !== DEFAULT_PROVIDER_TYPE) {
    putHandle(handle);
    // The backend may only learn its real native id after the first message (e.g.
    // lazy CLI initialization) — listen for session_backend_ready and additionally
    // register the handle under the real composite id; the original key is kept and
    // references already handed out stay valid.
    handle.subscribe((event) => {
      if (event.type === "session_backend_ready" && typeof event.id === "string" && event.id !== handleKeyOf(handle)) {
        putHandleAt(event.id, handle);
      }
    });
    // External agent backends (agentKey = the external agent they can drive): write
    // a pi placeholder file (persistent anchor). attach/spawn drive local pi
    // sessions whose files already exist, so no placeholder is written.
    if (provider.agentKey) wireExternalPlaceholder(handle, !!options.sessionId, options.cwd);
  }
  return handle;
}

/**
 * Placeholder-file wiring for external handles (lib/session/placeholder.ts).
 *   - resume (extId known and not a new- placeholder): write on creation;
 *   - fresh (new- placeholder key): write only once the session_backend_ready
 *     rebind yields the real id — an empty session that never sent a first
 *     message leaves no orphan placeholder;
 *   - on rebind the placeholder key migrates along (rebindPlaceholder), kept in
 *     sync with putHandleAt double registration.
 *   - Naming priority: explicit caller name (the real title when taking over from
 *     All Sessions) > truncated first user message from the handle (the new-session
 *     rebind-after-first-turn case) > [agent] sid fallback.
 */
async function placeholderNameFor(handle: SessionHandle, explicit?: string): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();
  try {
    const msgs = (await handle.getMessages?.()) ?? [];
    const first = msgs.find((m) => (m as { role?: unknown }).role === "user") as
      { content?: unknown } | undefined;
    const c = first?.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? ((c as Array<{ type?: unknown; text?: unknown }>).find((b) => b?.type === "text")?.text as string | undefined ?? "")
        : "";
    if (typeof text === "string" && text.trim()) return text.trim().slice(0, 60);
  } catch { /* getMessages missing/failed → fallback name */ }
  return undefined;
}

function wireExternalPlaceholder(handle: SessionHandle, resume: boolean, cwd?: string, name?: string): void {
  const colon = handle.id.indexOf(":");
  if (colon <= 0) return; // not a composite id → no placeholder
  const agent = handle.id.slice(0, colon);
  const provisional = isProvisionalExtSid(handle.id.slice(colon + 1));
  const writeNow = (aliasFrom?: string) => {
    void placeholderNameFor(handle, name)
      .catch(() => undefined)
      .then((resolvedName) => {
        // cwd priority: explicit argument > handle.cwd (the provider resolved the
        // session's original workspace at createSession time; cursor/claude resumes
        // both backfill it) > module-level fallback directory
        const p = ensurePlaceholder({
          extId: handle.id,
          agent,
          ...(resolvedName ? { name: resolvedName } : {}),
          ...(cwd || handle.cwd ? { cwd: cwd || handle.cwd } : {}),
        });
        // fresh-session rebind (no existing placeholder under the new- key): record
        // the placeholder alias so unmigrated ?session=agent:new-… URLs in browsers
        // still resolve back to this session after the store is emptied
        if (p && aliasFrom) aliasPlaceholder(aliasFrom, handle.id);
        if (p) invalidateSessionListCache(); // make the next /api/sessions round see the placeholder row immediately
      });
  };
  if (resume && !provisional) writeNow();
  handle.subscribe((event) => {
    if (event.type !== "session_backend_ready" || typeof event.id !== "string") return;
    const prevEvent = event as unknown as { oldId?: unknown };
    const prevId = typeof prevEvent.oldId === "string" ? prevEvent.oldId : undefined;
    if (prevId && getPlaceholder(prevId)) rebindPlaceholder(prevId, event.id); // rebind + keep the old key as an alias
    else if (!getPlaceholder(event.id)) writeNow(prevId && prevId !== event.id ? prevId : undefined);
    invalidateSessionListCache();
  });
}

/**
 * Placeholder-session resolution: uuid → placeholder file header.extId → real agent
 * backend. Returns undefined for non-placeholder uuids (caller takes the local
 * path, at the cost of one extra header read). The opened handle is
 * double-registered under the placeholder uuid — later synchronous lookups from
 * POST /events hit directly.
 */
export async function resolvePlaceholderSession(id: string): Promise<WrappedSessionLike | undefined> {
  const fp = await resolveSessionPath(id).catch(() => null);
  if (!fp) return undefined;
  const header = readSessionHeader(fp) as unknown as { extId?: string } | null;
  if (!header?.extId || !header.extId.includes(":")) return undefined;
  const existing = resolveAnySession(id);
  if (existing?.isAlive()) return existing;
  const sid = header.extId.slice(header.extId.indexOf(":") + 1);
  const handle = await openExternalSession(header.extId, { ...(sid ? { sessionId: sid } : {}) }).catch(() => undefined);
  if (!handle?.alive()) return undefined;
  putHandleAt(id, handle);
  return resolveAnySession(id);
}

/**
 * Cold-resume composite external ids (e.g. zcode:sess_x) directly, without relying
 * on the placeholder file. During the window after process restart/extension reload
 * when the handle registry is empty, events/POST routes use this to drive a backend
 * resume directly instead of 404ing. Returns undefined = not a composite id, a
 * placeholder sid, no provider able to drive the agent, or the backend won't open.
 */
export async function resolveExternalCompositeSession(id: string): Promise<WrappedSessionLike | undefined> {
  if (!id.includes(":") || id.startsWith("pi:")) return undefined;
  const existing = resolveAnySession(id);
  if (existing?.isAlive()) return existing;
  const { sid } = splitHandleId(id);
  if (!sid || isProvisionalExtSid(sid)) return undefined;
  const handle = await openExternalSession(id, { sessionId: sid }).catch(() => undefined);
  if (!handle?.alive()) return undefined;
  putHandleAt(id, handle);
  return resolveAnySession(id);
}

/** The registry key a handle was first stored under (identity compare). */
function handleKeyOf(handle: SessionHandle): string {
  for (const [key, h] of [...listAllHandles()]) {
    if (h === handle) return key;
  }
  return handle.id;
}
