/**
 * Live handle store — server-side registry of SessionHandles created through
 * non-local providers (attach/spawn/extension backends).
 *
 * Local sessions stay in rpc-manager's __piSessions map (AgentSessionWrapper
 * world). Provider handles live here so API routes can resolve them by id,
 * exactly like getRpcSession does for local ones.
 *
 * Stored on globalThis for the same reason as __piSessions: Next.js dev HMR
 * recreates modules; the process-global survives.
 */

import type { SessionHandle } from "./types.ts";
import { hasPlaceholder } from "./placeholder.ts";

// ============================================================================
// firstMessage lazy cache (2026-09-14)
//
// Transient rows of backend handles previously hardcoded firstMessage to
// "(backend session)" — local disk sessions show the real first user message
// (when session.name is empty), but spawn-type backends (omp etc., no
// placeholder file, no agentKey) only got the placeholder text. Here the real
// first user message is lazily cached per handle instance: the first
// /api/sessions warms it up (getMessages capability, timeout-protected) and
// subsequent requests hit the cache synchronously.
// ============================================================================

/** Per-handle-instance firstMessage cache (WeakMap: reclaimed automatically when the handle leaves the store). */
const firstMessageCache = new WeakMap<SessionHandle, string>();
/** Warm-up in-flight dedupe (concurrent GETs on the same handle fetch getMessages only once). */
const firstMessageWarming = new WeakSet<SessionHandle>();

/** content (string | array of text blocks) → text. */
function textFromContent(c: unknown): string {
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    const t = (c as Array<{ type?: unknown; text?: unknown }>).find((b) => b?.type === "text")?.text;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return "";
}

/**
 * Extract the first user message text from a backend getMessages result
 * (shape-adaptive, same discrimination as normalizeHandleMessages): a pi
 * entry ({type,message} nesting) is unwrapped; a direct message shape
 * ({role,content}) is used as-is. Nothing found → "".
 */
export function extractFirstUserText(entries: unknown[]): string {
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    let msg: Record<string, unknown> | undefined;
    if (typeof rec.type === "string" && !("role" in rec)) {
      const m = (rec as { message?: unknown }).message;
      if (m && typeof m === "object") msg = m as Record<string, unknown>;
      else continue;
    } else {
      msg = rec;
    }
    if (msg.role !== "user") continue;
    const text = textFromContent(msg.content);
    if (text) return text;
  }
  return "";
}

/** Warm a single handle (timeout-protected; on failure the placeholder is kept silently). */
async function warmOne(h: SessionHandle, timeoutMs: number): Promise<void> {
  firstMessageWarming.add(h);
  try {
    const entries = await Promise.race([
      h.getMessages!(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("firstMessage warm timeout")), timeoutMs);
      }),
    ]);
    const text = extractFirstUserText(entries as unknown[]);
    if (text) firstMessageCache.set(h, text);
  } catch {
    // read failure/timeout: keep the placeholder, retry on the next GET
  } finally {
    firstMessageWarming.delete(h);
  }
}

/**
 * Warm firstMessage in parallel for live handles missing a cache entry (those
 * with getMessages capability). Cache hits return synchronously; in-flight
 * dedupe prevents concurrent GETs from double-fetching.
 * List/detail routes await this once before assembling rows so the first load
 * already shows the real first message.
 */
export async function warmHandleFirstMessages(timeoutMs = 2000): Promise<void> {
  const targets: SessionHandle[] = [];
  for (const h of store().values()) {
    if (h.alive() && typeof h.getMessages === "function" && !firstMessageCache.has(h) && !firstMessageWarming.has(h)) {
      targets.push(h);
    }
  }
  await Promise.all(targets.map((h) => warmOne(h, timeoutMs)));
}

declare global {
  var __sessionHandles: Map<string, SessionHandle> | undefined;
}

function store(): Map<string, SessionHandle> {
  if (!globalThis.__sessionHandles) {
    globalThis.__sessionHandles = new Map();
    const cleanup = () => {
      for (const h of globalThis.__sessionHandles?.values() ?? []) {
        void h.dispose().catch(() => {});
      }
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__sessionHandles;
}

/** Store a handle under its id. Overwrites any previous handle with the same id (dev HMR safe). */
export function putHandle(handle: SessionHandle): void {
  const prev = store().get(handle.id);
  if (prev && prev !== handle) {
    void prev.dispose().catch(() => {});
  }
  store().set(handle.id, handle);
  watchHandleRunning(handle);
}

export function getHandle(id: string): SessionHandle | undefined {
  const h = store().get(id);
  return h?.alive() ? h : undefined;
}

/** Register the same handle under an additional key (e.g. real native id discovered late). */
export function putHandleAt(key: string, handle: SessionHandle): void {
  store().set(key, handle);
}

/**
 * A03/B4: backend session id rebind — for backends whose ids are generated by
 * a process (omp etc.), an alias key is attached to the handle once the real
 * persisted id is read back (the old provisional key is kept: draft rows and
 * existing references keep working).
 * Idempotent: newId already mapped to the same handle → true; owned by another
 * handle → false (overwrite protection); oldId unavailable → false. Core
 * exposes this to extensions via ctx.core.rebindSessionBackend.
 */
export function rebindHandle(oldId: string, newId: string): boolean {
  if (!oldId || !newId || oldId === newId) return false;
  const h = getHandle(oldId);
  if (!h) return false;
  if (getHandle(newId) === h) return true; // already rebound
  if (getHandle(newId)) return false;      // newId owned by another handle → overwrite protection
  putHandleAt(newId, h);
  return true;
}

/** All live handles as [key, handle] pairs (identity scans). */
export function listAllHandles(): Array<[string, SessionHandle]> {
  return [...store()];
}

/**
 * Dispose every backend handle and clear the store (called after extension reload).
 * Extension hot reload swaps the server code, but live handles are still
 * instances of the old classes (kept alive on globalThis) — without cleanup,
 * existing sessions keep running old logic (observed: a newly added
 * queue_update branch had no effect on old handles). After dispose, the next
 * access rebuilds on demand (createSession → new code); stateful backends like
 * zcode respawn+resume without loss, attach-type backends get
 * disconnect-and-reconnect semantics. Returns the number cleaned up.
 *
 * Running handles are not killed (2026-09-07 incident): reload once disposed an
 * in-flight zcode app-server together with its process and turn — the turn
 * never reached a final state, the UI gave no hint, and the in-memory pending
 * queue was dropped with the instance; from the user's side this looked like
 * "messages get no response". "respawn+resume without loss" only holds between
 * turns. Changed to: an in-flight handle stays in the store with all its alias
 * keys to finish the current turn, then is disposed + removed automatically
 * once settled; only after that does the next access rebuild it with the new
 * code.
 */
export async function disposeAllHandles(): Promise<number> {
  const all = listAllHandles();
  const ids = new Set<string>();
  const deferred = new Set<SessionHandle>();
  for (const [key, h] of all) {
    ids.add(key);
    if (typeof h.isRunning === "function" && h.isRunning()) {
      deferred.add(h);
      continue;
    }
    try { await h.dispose(); } catch { /* best effort */ }
  }
  // Clear the store but keep every key of in-flight handles (placeholder uuid /
  // composite id dual registration)
  const preserved: Array<[string, SessionHandle]> = [];
  for (const [key, h] of store()) {
    if (deferred.has(h)) preserved.push([key, h]);
  }
  store().clear();
  for (const [key, h] of preserved) store().set(key, h);
  for (const h of deferred) armDeferredDispose(h);
  return ids.size;
}

/** In-flight handles that already have the settle hook armed (prevents double subscription when reload fires repeatedly). */
const deferredDisposeArmed = new WeakSet<object>();

/** After an in-flight handle settles, re-check on a delay before removal — a queued follow-up turn right after agent_end may start immediately. */
function armDeferredDispose(h: SessionHandle): void {
  if (deferredDisposeArmed.has(h)) return;
  deferredDisposeArmed.add(h);
  try {
    h.subscribe((event: { type: string }) => {
      const t = event?.type;
      if (t !== "agent_settled" && t !== "agent_end") return;
      setTimeout(() => {
        if (!h.alive()) return;
        if (typeof h.isRunning === "function" && h.isRunning()) return;
        removeHandleEverywhere(h);
      }, 1000);
    });
  } catch { /* on subscription failure it stays in the store; process-exit cleanup is the safety net */ }
}

/** Remove by object identity + dispose (alias keys cleared too). */
function removeHandleEverywhere(h: SessionHandle): void {
  for (const [key, stored] of [...store()]) {
    if (stored === h) store().delete(key);
  }
  void h.dispose().catch(() => {});
  notifyHandleRunningChange();
}

/**
 * Sidebar/session-list rows for live backend sessions (deduped by object).
 * transient:true — no local file backs them.
 */
export function getHandleSessionInfos(): Array<{
  path: string;
  id: string;
  cwd: string;
  name: undefined;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  transient: boolean;
}> {
  const seen = new Set<SessionHandle>();
  const out: Array<ReturnType<typeof getHandleSessionInfos>[number] & { agent?: string }> = [];
  for (const [key, h] of store()) {
    if (!h.alive() || seen.has(h)) continue;
    seen.add(h);
    // Placeholder files now own list display (the disk-scan section) —
    // transient rows bow out to avoid duplicate rows for one session.
    // The check uses handle.id (the real composite id after rebind; the
    // placeholder key migrates with the rebind).
    if (hasPlaceholder(h.id)) continue;
    // agent tag = provider segment of source: "<extId>/claude-code" → "claude-code"
    const agent = h.source.includes("/") ? h.source.split("/")[1] : h.source;
    out.push({
      path: "",
      id: key,
      cwd: h.cwd ?? "",
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      // With a real first user message (cache hit) → same semantics as local
      // disk sessions: show the first message text when there is no name;
      // not warmed / no messages → keep the placeholder
      firstMessage: firstMessageCache.get(h) ?? `(backend session)`,
      transient: true,
      agent,
    });
  }
  return out;
}

export function removeHandle(id: string): void {
  const h = store().get(id);
  if (h) void h.dispose().catch(() => {});
  store().delete(id);
}

export function listHandleIds(): string[] {
  return [...store().keys()];
}

/** Ids of backend sessions currently executing a turn (one data source for the
 * sidebar running indicator). Returns ALL outward ids registered for a handle:
 * Map key + handle.id.
 * The sidebar row id differs per backend:
 *   - attach: outward row id = handle.id (uuid), while the Map key is a session
 *     file path (dirty; `/`-prefixed keys are filtered out)
 *   - external agents (zcode/cursor/…): outward row id = placeholder uuid (the
 *     putHandleAt(uuid) key), while handle.id is the composite id (e.g.
 *     `zcode:sess_xxx`) — the two differ, so returning only handle.id would
 *     never match.
 * Both key and handle.id must therefore be collected so
 * runningSessionIds.has(row.id) hits. `/`-prefixed keys are attach session file
 * paths (internal reuse only), never exposed to running. */
export function getRunningHandleIds(): string[] {
  const ids = new Set<string>();
  for (const [key, h] of store()) {
    if (!h.alive() || !h.isRunning()) continue;
    if (!key.startsWith("/")) ids.add(key);
    if (h.id && !h.id.startsWith("/")) ids.add(h.id);
  }
  return [...ids];
}

// ── handle-side running broadcast (merged into /api/agent/running[events]) ─────────────
type RunningListener = (ids: string[]) => void;
// Carried on globalThis (2026-09-15): the running-set broadcaster
// (lib/running-broadcast.ts, activated by the instrumentation / running snapshot
// route entry) and handle changes (notifyHandleRunningChange) may live in
// different module-graph realms — the listener set must be shared process-wide,
// otherwise cross-realm notifications never reach the broadcaster.
const runningListeners = (): Set<RunningListener> =>
  ((globalThis as { __piHandleRunningListeners?: Set<RunningListener> }).__piHandleRunningListeners ??= new Set());

export function subscribeRunningHandles(listener: RunningListener): () => void {
  runningListeners().add(listener);
  return () => runningListeners().delete(listener);
}

/** Rebuild the handle running set and broadcast (mirrors rpc-manager.notifyRunningChange; broadcasts the merged full set). */
export function notifyHandleRunningChange(): void {
  const ids = getRunningHandleIds();
  const snapshot = JSON.stringify(ids);
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const l of runningListeners()) l(ids);
}
let lastRunningSnapshot = "";

/** Attach a running-event listener to the handle at putHandle time (agent_start/end/settled/turn_*) — attached only once. */
const runningWatched = new WeakSet<object>();
export function watchHandleRunning(handle: { id: string; subscribe(listener: (e: { type: string }) => void): () => void }): void {
  if (runningWatched.has(handle)) return;
  runningWatched.add(handle);
  handle.subscribe((event) => {
    const t = event.type;
    if (t === "agent_start" || t === "agent_end" || t === "agent_settled" || t === "turn_start" || t === "turn_end") {
      notifyHandleRunningChange();
      // Common backend-extension timing (verified on zcode/codex/claude-code/
      // cursor/opencode/qoder): settled/end events fire first, then prompt()'s
      // finally clears the running flag — a synchronous recount still sees
      // isRunning() true, the snapshot equals the previous one and is swallowed
      // by dedupe, and no event ever fires after the flag clears → the running
      // set goes stale and the sidebar spinner never disappears (reproduced
      // 2026-09-16). Recount one tick later to catch the flag flip after the
      // event; snapshot dedupe guarantees no redundant broadcasts.
      const timer = setTimeout(() => notifyHandleRunningChange(), 0);
      timer.unref?.();
    }
  });
}
