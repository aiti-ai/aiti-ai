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
  PromptSubmission,
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

import { getProvider, findProvidersForAgent, listProviders, DEFAULT_PROVIDER_TYPE, type SessionProvider } from "./providers.ts";
import type { CreateSessionOptions } from "./providers.ts";
import { BridgeOccupiedError } from "./types.ts";
import type { SessionCapabilities, SessionHandle } from "./types.ts";
import { getHandle as lookupHandle, putHandle, putHandleAt, listAllHandles } from "./handle-store.ts";
import { HandleSessionAdapter, type WrappedSessionLike } from "./handle-adapter.ts";
import { findBridgeSessionFileById, invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "../session-reader.ts"; // relative path + explicit extension: jiti does not resolve the @/ alias, and ESM requires extensions
import { describeDetachSupport, getAgentStarters, getDetachedPreference, getWrapperStarter, selectStarter } from "../agent-starter/index.ts";
import type { DetachSupportInfo } from "../agent-starter/index.ts";
import type { ChildProcess } from "node:child_process";
import { ensurePlaceholder, rebindPlaceholder, aliasPlaceholder, getPlaceholder, isProvisionalExtSid } from "./placeholder.ts";

function listProviderNames(): string[] {
  return listProviders().map((p) => p.type);
}

/** Provider info for UI pickers / discovery endpoints. */
export type ProviderInfo = {
  type: string;
  label: string;
  /** Backend opted in to detachable hosting (agent outlives a pi-web restart). */
  detachable?: boolean;
  /** External agent key this backend can drive (all-sessions join key), if any. */
  agentKey?: string;
  maxCapabilities: SessionCapabilities;
  /** false = dependency (CLI) missing at scan time — entry renders greyed out. */
  available?: boolean;
  /** Install command / download URL shown for unavailable entries. */
  installHint?: string;
};

export function listProviderInfos(): ProviderInfo[] {
  return listProviders().map((p) => ({
    type: p.type,
    label: p.label,
    ...(p.agentKey ? { agentKey: p.agentKey } : {}),
    ...(p.detachable === true ? { detachable: true } : {}),
    maxCapabilities: p.maxCapabilities,
    ...(p.available === false ? { available: false } : {}),
    ...(p.available === false && p.installHint ? { installHint: p.installHint } : {}),
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
 * Host markers every agent process must inherit.
 *
 * Port discovery (service-tunnels) attributes a listening socket to this pi-web
 * instance either through the process tree or through the marker in
 * `/proc/<pid>/environ`. A detached agent leaves the process tree, so the marker
 * is the only remaining link — and agent backends build a curated env (account
 * isolation), which drops it. Re-adding it at the DI seam keeps discovery
 * working for BOTH strategies (it is an opaque id, never a credential).
 */
const HOST_MARKER_ENVS = ["SERVICE_TUNNELS_MARKER", "PI_WEB_CHILD_MARKER"] as const;

function withHostMarkers<T extends { env?: Record<string, string | undefined> }>(options: T): T {
  if (!options.env) return options; // no env override → the child inherits process.env
  const env = { ...options.env };
  let changed = false;
  for (const name of HOST_MARKER_ENVS) {
    const value = process.env[name];
    if (value && env[name] === undefined) {
      env[name] = value;
      changed = true;
    }
  }
  return changed ? { ...options, env } : options;
}

/**
 * Attach the core's chosen agent-process strategy to the createSession options
 * (the DI seam). Providers never import the factory; they call
 * `options.agentStarter.spawn(...)` when present and fall back to their own
 * child_process.spawn when absent (older hosts).
 *
 * Selection is per session and made HERE — never inside a provider:
 *   PI_WEB_AGENT_DETACH=0                   → direct for everyone
 *   provider.detachable === false           → direct (node IPC / non-pipe stdio)
 *   createSession({ detach: false })        → direct for this session
 *   otherwise                               → the wrapper strategy when available
 */
async function withAgentStarter(
  provider: SessionProvider | undefined,
  options: CreateSessionOptions,
): Promise<CreateSessionOptions> {
  if (options.agentStarter) return options;
  try {
    const starters = await getAgentStarters();
    const starter = selectStarter(starters, {
      detach: options.detach,
      providerDetachable: provider?.detachable,
    });
    // Tag the spawn with the owning provider so a reattach after a restart can
    // address exactly the provider that started the process (agentKey alone is
    // ambiguous: several backends can drive "pi").
    const owner = provider?.type;
    const tagged = {
      kind: starter.kind,
      spawn: async (command: string, args: string[], spawnOptions?: Record<string, unknown>) =>
        starter.spawn(command, args, {
          ...withHostMarkers((spawnOptions ?? {}) as { env?: Record<string, string | undefined> }),
          ...(owner ? { owner } : {}),
        }),
    };
    return { ...options, agentStarter: tagged };
  } catch (err) {
    // Never block session creation on a starter probe failure — the provider's
    // own spawn path stays the historical behavior.
    console.warn(`[session] agent-starter unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return options;
  }
}

/**
 * Outcome of the detached-recovery probe.
 *
 *   none      nothing to recover (no registry entry / wrapper gone) → callers
 *             continue with the historical paths
 *   attached  the live agent process is now driven by this handle
 *   blocked   a wrapper holds the session but no provider could adopt it —
 *             callers must FAIL (single-writer rule: a second agent on the same
 *             session file would double-write it)
 */
type DetachedRecovery =
  | { status: "none" }
  | { status: "attached"; handle: SessionHandle }
  | { status: "blocked"; reason: string };

/**
 * Follow a backend that only learns its native session id after start (omp,
 * codebuddy …): the wrapper registry entry is re-keyed so a later recovery can
 * find the still-running process by that id.
 */
function watchBackendRebind(handle: SessionHandle, spawnKey: string): void {
  handle.subscribe((event) => {
    if (event.type !== "session_backend_ready" || typeof event.id !== "string") return;
    const oldId = (event as unknown as { oldId?: unknown }).oldId;
    // An empty oldId means the backend never had an id before the announcement —
    // fall back to the key the session was spawned under.
    const from = typeof oldId === "string" && oldId ? oldId : spawnKey;
    if (!from || from === event.id) return;
    void getWrapperStarter()
      .then((wrapper) => {
        if (!wrapper) return;
        const moved = wrapper.rebind(from, event.id as string);
        if (moved) console.log(`[session] detached registry re-keyed ${from} → ${event.id}`);
      })
      .catch((err) => console.warn(`[session] registry re-key failed: ${err instanceof Error ? err.message : String(err)}`));
  });
}

/**
 * Reattach to a session whose agent process is hosted by a detached wrapper
 * (it outlived a pi-web restart / extension reload).
 *
 * The registry entry names the agent family, so the provider that can drive it
 * is found by agentKey; the child process facade replays the wrapper's journal
 * before any new traffic, so the handle rebuilds the live stream.
 */
// Single-flight for detached (wrapper) attaches: concurrent resolutions of the
// same session (two tabs, POST racing GET, lease + command) would each call
// wrapper.attach — the wrapper supersedes the first client, leaving a zombie
// facade mid-stream whose frames die silently (2026-11-22 steer-loss
// forensics). Share one in-flight attach per native session id. globalThis:
// same dev/HMR rationale as __sessionProviders.
declare global {
  // eslint-disable-next-line no-var
  var __detachedAttachInFlight: Map<string, Promise<DetachedRecovery>> | undefined;
}

function attachDetachedInFlightMap(): Map<string, Promise<DetachedRecovery>> {
  if (!globalThis.__detachedAttachInFlight) globalThis.__detachedAttachInFlight = new Map();
  return globalThis.__detachedAttachInFlight;
}

function attachDetachedSessionOnce(
  sessionId: string,
  sessionFile?: string,
): Promise<DetachedRecovery> {
  const map = attachDetachedInFlightMap();
  const inflight = map.get(sessionId);
  if (inflight) return inflight;
  const attempt = attachDetachedSession(sessionId, sessionFile).finally(() => {
    map.delete(sessionId);
  });
  map.set(sessionId, attempt);
  return attempt;
}

async function attachDetachedSession(
  sessionId: string,
  sessionFile?: string,
): Promise<DetachedRecovery> {
  if (!sessionId) return { status: "none" };
  const wrapper = await getWrapperStarter();
  if (!wrapper) return { status: "none" };
  const entry = wrapper.describe(sessionId);
  if (!entry) return { status: "none" };
  if (!(await wrapper.holds(sessionId))) return { status: "none" };
  // Exact provider first (the one that spawned the process), then other
  // providers that opted into detachable hosting. A backend that ignores
  // `attached` would spawn a SECOND agent on the same session file — never
  // offer the session to it.
  const candidates: SessionProvider[] = [];
  const owner = entry.providerType ? getProvider(entry.providerType) : undefined;
  if (owner && owner.detachable === true) candidates.push(owner);
  for (const provider of findProvidersForAgent(entry.agentKey)) {
    if (provider.detachable === true && !candidates.includes(provider)) candidates.push(provider);
  }
  if (candidates.length === 0) {
    return {
      status: "blocked",
      reason: `session is hosted by a detached ${entry.agentKey} agent, but no installed backend can drive "${entry.agentKey}"`,
    };
  }

  let child: ChildProcess | undefined;
  try {
    child = await wrapper.attach(sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The wrapper may have exited between the probe and the attach → the file
    // resume path is correct after all.
    if (!(await wrapper.holds(sessionId))) return { status: "none" };
    return { status: "blocked", reason: `detached attach failed: ${message}` };
  }
  let lastError: unknown;
  for (const provider of candidates) {
    try {
      const handle = await provider.createSession({
        ...(sessionFile ? { sessionFile } : {}),
        sessionId,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        attached: { child, sessionId, agentKey: entry.agentKey, ...(entry.cwd ? { cwd: entry.cwd } : {}) },
      });
      // A backend that learns its native id late may announce it right after the
      // adopt (omp): keep the registry entry addressable by that id.
      watchBackendRebind(handle, sessionId);
      return { status: "attached", handle };
    } catch (err) {
      lastError = err;
    }
  }
  // No provider could adopt the process: disconnect and leave the agent hosted
  // by its wrapper (killing it would lose the in-flight turn).
  const facade = child as unknown as { release?: () => void };
  try {
    facade.release?.();
  } catch {
    /* already gone */
  }
  return {
    status: "blocked",
    reason: `no backend could adopt the detached ${entry.agentKey} session: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  };
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
  // Resume-without-cwd recovery (composite-id URL restore after a host restart): the
  // caller only knows the session id — the workspace lives in the session file header.
  // Resolve it once so backend children spawn in the session's real workspace instead
  // of the host process's cwd (pi buckets session files per project dir — spawning in
  // the wrong cwd makes --session-id resume miss and create a blank same-id session).
  if (!options.cwd && sid) {
    try {
      const { findSessionHeaderById } = await import("../session-reader.ts");
      const header = await findSessionHeaderById(sid);
      if (header?.cwd) options = { ...options, cwd: header.cwd };
    } catch { /* best-effort: providers fall back to their own workspace resolution */ }
  }
  // Detached recovery first: a wrapper-hosted agent outlived the old instance, so
  // reopening the session must attach to it instead of spawning a second agent.
  const recovery = await attachDetachedSessionOnce(sid);
  if (recovery.status === "blocked") {
    throw new BridgeOccupiedError(compositeId, recovery.reason);
  }
  if (recovery.status === "attached") {
    const revived = recovery.handle;
    putHandle(revived);
    if (requestedId !== revived.id) putHandleAt(requestedId, revived);
    // Same placeholder wiring as the from-scratch path below (external agents only).
    if (findProvidersForAgent(agent).some((p) => p.agentKey)) {
      wireExternalPlaceholder(revived, true, options.cwd, options.name);
    }
    return revived;
  }
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
  // Extracted so the wrapper launch-race recovery below can re-run the same
  // reuse pass after the winning open has registered its handle.
  const reuseAliveHandle = (): SessionHandle | undefined => {
    for (const [key, existing] of listAllHandles()) {
      if (!existing.alive() || existing.id !== compositeId) continue;
      if (key !== compositeId) putHandleAt(compositeId, existing);
      if (requestedId !== compositeId) putHandleAt(requestedId, existing);
      return existing;
    }
    return undefined;
  };
  const reused = reuseAliveHandle();
  if (reused) return reused;
  const candidates = findProvidersForAgent(agent);
  if (candidates.length === 0) return undefined;
  // A hosting switch may have persisted "direct subprocess" for this external
  // agent; otherwise the provider default (wrapper when detachable) applies.
  const hostingPref = getDetachedPreference(sid);
  const prefDetach = hostingPref ? hostingPref.mode !== "subprocess" : undefined;
  let lastError: unknown;
  for (const provider of candidates) {
    try {
      const handle = await provider.createSession(
        await withAgentStarter(provider, {
          ...options,
          sessionId: options.sessionId ?? sid,
          ...(options.detach === undefined && prefDetach !== undefined ? { detach: prefDetach } : {}),
        }),
      );
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
      // Wrapper launch race (2026-11-23): a parallel cold-open of the same session
      // loses the wrapper spawn flight and lands here just after the winner's
      // createSession returned — the loser's 404 then silently degraded the UI to
      // the read-only viewer. Give the winner's putHandle a beat and reuse its
      // handle; if it never registered (crashed mid-flight), one recovery attach
      // adopts the wrapper process it left behind. Neither applies → keep the
      // original error and stop trying other providers (they would hit the same
      // already-hosted wrapper).
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("(launch in flight)")) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const raced = reuseAliveHandle();
        if (raced) return raced;
        const retry = await attachDetachedSessionOnce(sid);
        if (retry.status === "attached") {
          const revived = retry.handle;
          putHandle(revived);
          if (requestedId !== revived.id) putHandleAt(requestedId, revived);
          if (findProvidersForAgent(agent).some((p) => p.agentKey)) {
            wireExternalPlaceholder(revived, true, options.cwd, options.name);
          }
          return revived;
        }
        break;
      }
    }
  }
  throw lastError ?? new Error(`No provider could open ${compositeId}`);
}

/**
 * Stop a wrapper-hosted session (delete path for placeholder/external rows, which
 * bypass the shared cascade engine). Returns false when nothing was hosted.
 */
export async function stopDetachedSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  const wrapper = await getWrapperStarter().catch(() => undefined);
  if (!wrapper) return false;
  if (!wrapper.describe(sessionId)) return false;
  return wrapper.kill(sessionId).catch(() => false);
}

/** Detach availability for UI surfaces (new-session toggle, greying). */
export async function detachSupport(): Promise<DetachSupportInfo> {
  return describeDetachSupport();
}

/**
 * Re-host a cold session that carries a survive-restart preference marker.
 *
 * The marker is written when the user explicitly starts the session detached
 * ("Start · survive restarts"); when that wrapper later exits, the next open
 * re-hosts detached instead of silently downgrading to a plain local child.
 * Uses the provider recorded on the marker, falling back to any detachable
 * provider of the "pi" family. Throws when the spawn fails — callers degrade
 * to their local path (never block opening the session).
 */
export async function openDetachedPreferred(
  sessionId: string,
  sessionFile: string,
): Promise<SessionHandle | undefined> {
  const pref = getDetachedPreference(sessionId);
  const provider =
    (pref?.providerType ? getProvider(pref.providerType) : undefined) ??
    findProvidersForAgent("pi").find((p) => p.detachable === true);
  if (!provider) return undefined;
  return createSessionHandle({
    providerType: provider.type,
    sessionId,
    sessionFile,
    ...(pref?.cwd ? { cwd: pref.cwd } : {}),
    detach: true,
  });
}

/** Does this cold session prefer survive-restart hosting (preference marker present)? */
export function prefersDetached(sessionId: string): boolean {
  const pref = getDetachedPreference(sessionId);
  return !!pref && pref.mode !== "subprocess";
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

/** Options for {@link attachIfBridged}. */
export type AttachIfBridgedOptions = {
  /**
   * false = read-only attach: reuse live handles, adopt live detached wrappers and
   * providers that can only CONNECT to an already-running process (`attachOnly`),
   * but never let a provider create/spawn one. Default true (write paths).
   */
  create?: boolean;
};

/**
 * When a session file is owned by a running TUI bridge, lazily create an attach
 * handle and store it (key = file path). Ownership is negotiated through
 * provider.ownsFile — the registry format belongs to the extension; the core
 * knows nothing about it.
 *
 * Semantics (single-writer invariant, read vs create): see AttachIfBridgedOptions.
 *   - no claim           → undefined (caller takes the local path)
 *   - claimed + attached → adapter
 *   - claimed + failed   → BridgeOccupiedError (refuse local open, never fork silently)
 *
 * Concurrent callers for the SAME session join one in-flight attach (see the
 * inflight map below) instead of each opening their own wrapper client.
 */
export async function attachIfBridged(
  sessionFile: string,
  options: AttachIfBridgedOptions = {},
): Promise<WrappedSessionLike | undefined> {
  // Read paths (session open / history replay) must not pull an agent process up:
  // a provider without `attachOnly` can only satisfy createSession by spawning.
  const create = options.create !== false;
  // Reuse an already-attached handle — otherwise creating a new connection per
  // request would dispose the old handle currently watched by SSE (putHandle's
  // overwrite semantics). A wrapper serves ONE client: re-attaching on every
  // read superseded the existing handle and made detached sessions flicker
  // (messages appear, then state/reset empties the view).
  const existingHandle = lookupHandle(sessionFile);
  if (existingHandle?.alive()) return new HandleSessionAdapter(existingHandle);
  const uuidFromFile = sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];
  const existingByUuid = uuidFromFile ? findAliveHandleById(uuidFromFile) : undefined;
  if (existingByUuid) return new HandleSessionAdapter(existingByUuid);

  // Concurrent-view dedupe: opening a session fires several parallel requests
  // (GET /api/sessions/[id], /state, /context, meta fallback …) and each one
  // used to run its own attach here. A wrapper serves a SINGLE client — every
  // new attach supersedes the previous connection, so the loser fails mid-
  // adoption ("process exited (signal)") and surfaces as a spurious 409
  // ("bridge unreachable") exactly on first view after a restart/reload/handle
  // eviction. Joining one flight makes the race a no-op: one attach, everyone
  // gets the same adapter. Same pattern as startRpcSession's locks.
  // The dedupe key carries the create/attach mode: a read-only caller must never
  // join a write flight (it would get a freshly spawned process) and vice versa.
  const flightKey = `${create ? "create" : "attach"}:${sessionFile}`;
  const inflight = attachInflight().get(flightKey);
  if (inflight) return inflight;
  const flight = attachIfBridgedUncached(sessionFile, { create });
  attachInflight().set(flightKey, flight);
  try {
    return await flight;
  } finally {
    // Only clear while this flight is still the registered one (a newer flight
    // must not be dropped by a late settler).
    if (attachInflight().get(flightKey) === flight) attachInflight().delete(flightKey);
  }
}

declare global {
  var __attachIfBridgedInflight: Map<string, Promise<WrappedSessionLike | undefined>> | undefined;
}

function attachInflight(): Map<string, Promise<WrappedSessionLike | undefined>> {
  if (!globalThis.__attachIfBridgedInflight) globalThis.__attachIfBridgedInflight = new Map();
  return globalThis.__attachIfBridgedInflight;
}

/** The actual attach body, guarded by attachIfBridged's in-flight dedupe. */
async function attachIfBridgedUncached(
  sessionFile: string,
  options: { create: boolean },
): Promise<WrappedSessionLike | undefined> {
  // Detached recovery (core-internal, before any provider probe): a session whose
  // agent is hosted by a wrapper is attached by uuid, and the wrapper's journal
  // replay rebuilds the stream — no extension registry (ownsFile) involved.
  const detachedUuid = sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];
  if (detachedUuid) {
    // Reuse first (2026-11-22 queue-echo regression): a wrapper serves a SINGLE client —
    // every fresh attach supersedes the previous connection, killing the live handle
    // the open SSE stream is subscribed to (queue_update frames died with it; the
    // queue panel only recovered after a full page reload). The file-path reuse below
    // never hits spawn handles (they are keyed by uuid only), so check the uuid key
    // here: an alive handle already attached to this wrapper IS the current client.
    const existingByUuid = lookupHandle(detachedUuid);
    if (existingByUuid?.alive()) return new HandleSessionAdapter(existingByUuid);
    const recovery = await attachDetachedSessionOnce(detachedUuid, sessionFile);
    if (recovery.status === "blocked") {
      // Fail loud: the agent is alive elsewhere, opening locally would double-write.
      throw new BridgeOccupiedError(sessionFile, recovery.reason);
    }
    if (recovery.status === "attached") {
      const revived = recovery.handle;
      putHandle(revived);
      // File-path key only for bridge-held (attach) handles: their file is written by the
      // TUI bridge, so file-keyed lookups must reuse the live attachment. Detachable spawn
      // handles (pi spawn, file-backed) must NOT take the file key — it would shadow the
      // local file read in the state/context routes (attachIfBridged reuse) and degrade
      // them to handle projections: synthesized ext-N entry ids (pi fork/edit-from-here
      // needs the real pi entry ids) and a state shape without capabilities.
      if (revived.source === "aiti-attach-agent/attach") putHandleAt(sessionFile, revived);
      return new HandleSessionAdapter(revived);
    }
  }

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
    // Read-only attach: a provider that may spawn has no way to serve this file
    // without starting a process. Skip it — the caller reads the JSONL from disk
    // (same history/model; a live session still reuses its handle above).
    if (!options.create && provider.attachOnly !== true) continue;
    try {
      // The attach handle's id must be the public session uuid (not the file path) —
      // /api/agent/[id]'s resolveAnySession(id) looks up the handle store by id; a
      // mismatched id makes GET/SSE all 404 and the frontend chat window never sees
      // live state. Double-key registration: uuid (authoritative) + file path
      // (compat with the existing lookupHandle(sessionFile) reuse semantics).
      const sessionUuid = (sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/) ?? [null, sessionFile])[1];
      const handle = await provider.createSession(
        await withAgentStarter(provider, {
          sessionFile,
          sessionId: sessionUuid,
        }),
      );
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
/** Find an alive handle by plain, native or composite id (detached provider handles may be keyed any of these). */
export function findAliveHandleById(id: string): SessionHandle | undefined {
  if (!id) return undefined;
  const direct = lookupHandle(id);
  if (direct?.alive()) return direct;
  const native = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  if (!native) return undefined;
  for (const [key, handle] of listAllHandles()) {
    if (!handle?.alive()) continue;
    if (key === native || key === id || handle.id === native || handle.id === id) return handle;
    if (key.endsWith(`:${native}`) || handle.id.endsWith(`:${native}`)) return handle;
  }
  return undefined;
}

export function resolveAnySession(id: string): WrappedSessionLike | undefined {
  // Local registry is consulted by callers first (they import getRpcSession);
  // this helper is the handle-side fallback.
  const handle = findAliveHandleById(id);
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
  // File-less backends (omp/codebuddy/…): the session has no pi session file, so
  // the only door is the detached-wrapper registry, keyed by the native id.
  const detached = await resolveDetachedSession(id).catch(() => undefined);
  if (detached) return detached;
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
 * Resolve a session whose agent process is hosted by a detached wrapper, by its
 * native id. This is the reattach door for backends WITHOUT a pi session file
 * (omp, codebuddy, ACP bridges): no file means no `attachIfBridged` uuid and no
 * placeholder row, so the wrapper registry is the only place that knows the
 * process is still alive.
 */
export async function resolveDetachedSession(id: string): Promise<WrappedSessionLike | undefined> {
  if (!id) return undefined;
  const existing = lookupHandle(id);
  if (existing?.alive()) return new HandleSessionAdapter(existing);
  // Routes see composite ids ("claude:<sid>") while the registry is keyed by the
  // native id — try both spellings before giving up.
  const candidates = id.includes(":") ? [id, id.slice(id.indexOf(":") + 1)] : [id];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const existingForCandidate = lookupHandle(candidate);
    if (existingForCandidate?.alive()) return new HandleSessionAdapter(existingForCandidate);
    const recovery = await attachDetachedSessionOnce(candidate);
    if (recovery.status === "blocked") throw new BridgeOccupiedError(id, recovery.reason);
    if (recovery.status !== "attached") continue;
    putHandle(recovery.handle);
    if (candidate !== id) putHandleAt(id, recovery.handle);
    return recovery.handle.alive() ? new HandleSessionAdapter(recovery.handle) : undefined;
  }
  return undefined;
}

/**
 * Re-open a spawn/attach-owned session through its claiming provider instead of
 * letting the caller fall through to a local-runtime twin. A provider that
 * answers ownsFile() claims single-writer rights on the file: the correct door
 * is createSessionHandle (adopt the live wrapper, or resume a fresh subprocess
 * with the native id) — NEVER startRpcSession, whose in-process twin would
 * accept prompts into a session whose events and replies bypass the chat page
 * entirely (2026-11-22 steer-loss forensics: a reload disposed the handle, a
 * racing access created the twin, and the steer vanished into it).
 */
export async function resolveProviderOwnedSession(
  id: string,
  filePath: string | undefined,
): Promise<WrappedSessionLike | undefined> {
  if (!filePath) return undefined;
  for (const provider of listProviders()) {
    if (typeof provider.ownsFile !== "function") continue;
    let claimed = false;
    try {
      claimed = await provider.ownsFile(filePath);
    } catch {
      /* a probing provider must never block the others */
      continue;
    }
    if (!claimed) continue;
    try {
      const handle = await createSessionHandle({
        providerType: provider.type,
        sessionId: id,
        sessionFile: filePath,
      });
      if (handle?.alive()) return new HandleSessionAdapter(handle);
    } catch {
      /* this claiming provider could not re-open it — try the next one */
    }
  }
  return undefined;
}

/**
 * Create a session handle through the registry and store it for later lookup.
 * Falls back to the default provider when `providerType` is omitted.
 * Non-default handles are stored in the global handle store; default ("local")
 * sessions stay in rpc-manager's registry.
 *
 * Single-flight per (provider, native id, file): opening a cold session fires
 * several requests at once (get_state, get_commands, prompt, ...), and each one
 * reaching provider.createSession starts its OWN detachable wrapper. Two
 * systemd-run launches for one unit name race: the loser is refused ("unit
 * already loaded") and its failure cleanup unlinks the winner's socket/registry
 * → a live wrapper becomes unreachable while its unit name stays taken, so every
 * reopen fails (2026-11-23 orphan incident). Concurrent callers now share one
 * creation and receive the same handle.
 */
export async function createSessionHandle(
  options: CreateSessionOptions & { providerType?: string },
): Promise<SessionHandle> {
  const type = options.providerType ?? DEFAULT_PROVIDER_TYPE;
  const key = `${type}\u0000${options.sessionId ? `id:${options.sessionId}` : `file:${options.sessionFile ?? ""}`}`;
  const flights = createSessionFlights();
  const inflight = flights.get(key);
  if (inflight) return inflight;
  const flight = createSessionHandleUncached(options, type);
  flights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

declare global {
  // globalThis: same dev/HMR rationale as __sessionProviders and the attach flight map.
  var __createSessionHandleInFlight: Map<string, Promise<SessionHandle>> | undefined;
}

function createSessionFlights(): Map<string, Promise<SessionHandle>> {
  if (!globalThis.__createSessionHandleInFlight) globalThis.__createSessionHandleInFlight = new Map();
  return globalThis.__createSessionHandleInFlight;
}

async function createSessionHandleUncached(
  options: CreateSessionOptions & { providerType?: string },
  type: string,
): Promise<SessionHandle> {
  const provider = getProvider(type);
  if (!provider) {
    throw new Error(
      `Unknown session provider "${type}". Known providers: ${listProviderNames().join(", ")}` +
        (listProviders().length === 0 ? " (none registered — backend extensions not loaded?)" : ""),
    );
  }
  // A detached agent may already host this session (extension reload, recycle,
  // a second door into the same id): adopt it instead of starting a second
  // process on the same session file.
  const detached =
    options.sessionId && type !== DEFAULT_PROVIDER_TYPE
      ? await attachDetachedSessionOnce(options.sessionId, options.sessionFile)
      : ({ status: "none" } as DetachedRecovery);
  if (detached.status === "blocked") {
    throw new BridgeOccupiedError(options.sessionFile ?? options.sessionId ?? type, detached.reason);
  }
  const handle =
    detached.status === "attached"
      ? detached.handle
      : await provider.createSession(await withAgentStarter(provider, options));
  if (type !== DEFAULT_PROVIDER_TYPE) {
    putHandle(handle);
    // A detached wrapper recorded the spawn under the id we asked for; if the
    // backend later reports its real native id, move the registry entry so the
    // session stays recoverable by the id its file carries.
    if (detached.status === "none") watchBackendRebind(handle, options.sessionId ?? handle.id);
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
