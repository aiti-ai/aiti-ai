/**
 * backend-queue — shared implementation layer for backend session queues (docs/backend-queue-manager-plan.md §3).
 *
 * Extracts the combination proven in the aiti-zcode-agent handle — "local followUp queue + steer mirror + queueManage
 * full actions + settle-triggered auto follow-up turn + user bubble + steer-failure degradation" — into composable helpers:
 * each backend handle wires in with ≤15 lines (composition, no pi-web core changes).
 *
 * ⚠ Authoritative source: this file (pi-web-ext/_shared/backend-queue.ts). On deploy it is copied into each extension dir
 *   (same precedent as external-cli-governance) — changes must be synced to all copies; keep this header comment.
 *
 * Semantics essentials:
 *  - Routing (routePrompt): running + streamingBehavior==="followUp" → local queue (recalled-able);
 *    running + steer injection available → steer() (protocol-specific, may be absent); steer failure → degrade into the local queue
 *    (R9 generalization: message not lost, original turn not interrupted, no double settled); idle → dispatch (provided by the handle;
 *    support only manages the queue — sending is always done by the handle).
 *  - Queue entries carry images ({text, images}, closing the zcode R4 loop); the queue_update wire still carries text only
 *    (the frontend panel need not know about images); recall/remove's entry/removed carry hasImages/images for retrieval and restoration.
 *  - Independent of the settled-turn ledger: scheduleDrain is called by the handle after settle/finally, idempotent
 *    (no-op while running) — decoupled from each backend's settle timing differences (plan G2).
 *  - rev monotonic version (2026-09-18): the queue_update event and all queueManage results carry the same
 *    number axis, so the frontend can drop stale out-of-order get_state snapshots (root fix for the race overwrite; see BackendQueueManageResult.rev).
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Minimal image shape (plan G5: the shared layer defines only the minimal shape; the handle side adapts its own TurnImage). */
export interface QueueTurnImageLike {
  data: string;
  mimeType: string;
  filename?: string;
}

/** Local followUp queue entry (R4 closure: carries images). */
export interface BackendQueueEntry {
  text: string;
  images?: QueueTurnImageLike[];
  queuedAt: number;
}

export interface BackendQueueOpts {
  /** Running check (the handle's running + alive combination; both drain idempotence and routing depend on it). */
  isRunning(): boolean;
  /** Liveness check (optional, defaults to always true): after dispose, drain/dispatch no longer start. */
  alive?(): boolean;
  /** The real send (handle.runTurn / prompt with full bookkeeping) — both the idle routing branch and follow-up turns go through here. */
  dispatch(text: string, images?: QueueTurnImageLike[]): Promise<void> | void;
  /** Wire event outlet (queue_update broadcast / user bubble message_end). */
  onEvent(ev: Record<string, unknown>): void;
  /**
   * Injection while running (protocol-specific, optional). Default = steer unsupported: sends while running always queue locally
   * (degradation semantics converge in the panel instead of silently dropping messages — plan §1.3).
   * The server-side steer mirror is fed by the handle via protocol event callbacks calling registerSteer/drainSteer.
   */
  steer?(text: string, images?: QueueTurnImageLike[]): Promise<void> | void;
  /** Degradation/anomaly notices (optional). */
  log?(msg: string): void;
  /**
   * Crash-recovery sidecar (optional, docs/aiti-remote-queue-and-sidecar-plan.md §3): once attached,
   * the pending queue survives process restarts (recovered entries are still auto-dispatched after settle — queued = intent to send);
   * dispose = session closed normally → remove() discards. Build the file implementation with createQueueFilePersistence().
   */
  persistence?: BackendQueuePersistence;
}

/** Queue persistence port (save/load/remove all synchronous small-file writes; implementations must write atomically — tmp+rename, Windows compat §0). */
export interface BackendQueuePersistence {
  save(entries: BackendQueueEntry[]): void;
  load(): BackendQueueEntry[];
  remove(): void;
}

const QUEUE_SIDECAR_VERSION = 1;
/** Sidecar residue cleanup threshold: 7-day crash-recovery window (same TTL as pi-web agent sessions cleanup). */
const QUEUE_SIDECAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sidecar file name: on Windows the colon is the NTFS ADS stream separator — `claude:new-1.json` would be written as
 * base name `claude` + an anonymous stream (rename/existsSync semantics all break; lesson in backend-queue.test).
 * win32 replaces colons in the id with `_`; the caller (createQueueFilePersistence's getFile)
 * must use the same function, otherwise migration/recovery would not recognize each other.
 */
export function sidecarFileName(id: string): string {
  const safe = process.platform === "win32" ? id.replace(/:/g, "_") : id;
  return `${safe}.json`;
}

/**
 * File-backed queue persistence (<stateDir>/queues/<sessionId>.json). getFile is lazily evaluated —
 * extension handles build the support in a field initializer and the file path is only known in the ctor body;
 * the lazy closure avoids both the init-order problem and the "no path passed = no persistence" default semantics.
 */
export function createQueueFilePersistence(
  getFile: () => string | undefined,
  log?: (msg: string) => void,
): BackendQueuePersistence {
  const read = (): BackendQueueEntry[] => {
    const file = getFile();
    if (!file || !existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: number; entries?: BackendQueueEntry[] };
      if (raw.version !== QUEUE_SIDECAR_VERSION || !Array.isArray(raw.entries)) return [];
      return raw.entries.filter((e) => e && typeof e.text === "string" && typeof e.queuedAt === "number");
    } catch (e) {
      log?.(`[backend-queue] sidecar read failed (recovery ignored): ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  /** Event-driven residue cleanup (no polling): on save, opportunistically scans the sibling directory once, deleting sidecars older than 7 days. */
  const prune = (dir: string): void => {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const p = join(dir, name);
        try {
          if (Date.now() - statSync(p).mtimeMs > QUEUE_SIDECAR_TTL_MS) rmSync(p, { force: true });
        } catch { /* a single-file failure does not affect the rest */ }
      }
    } catch { /* directory missing etc. */ }
  };
  return {
    save(entries) {
      const file = getFile();
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: QUEUE_SIDECAR_VERSION, entries }) + "\n");
        renameSync(tmp, file);
        prune(dirname(file));
      } catch (e) {
        log?.(`[backend-queue] sidecar write failed (queue unaffected, only crash recovery degraded): ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    load: read,
    remove() {
      const file = getFile();
      if (!file) return;
      try { rmSync(file, { force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * Migrates the queue sidecar on id rebinding (placeholder id → real id): handles use the "lazy persistence" mode — the real
 * session id only appears with the first backend frame (claude system/init, zcode/codebuddy rebindSessionId,
 * codex thread.started, cursor extractChatId); entries queued before that land in a random placeholder-id file,
 * and without migration crash recovery would never find them (only the 7-day prune would). Same shape as the renameExtModelState
 * state-file rebinding; called at each handle's real-id capture point. acp has no such window (the id is
 * assigned its real value synchronously before the host gets the handle).
 */
export function migrateQueueSidecar(
  dir: string | undefined,
  fromId: string,
  toId: string,
  log?: (msg: string) => void,
): void {
  if (!dir || !fromId || !toId || fromId === toId) return;
  try {
    const from = join(dir, "queues", sidecarFileName(fromId));
    if (!existsSync(from)) return;
    const to = join(dir, "queues", sidecarFileName(toId));
    // Windows renameSync does not overwrite an existing target: delete first (migration content ⊆ in-memory pending; the final in-memory save wins)
    if (existsSync(to)) rmSync(to, { force: true });
    renameSync(from, to);
    log?.(`[backend-queue] sidecar migrated on id rebinding: ${fromId} → ${toId}`);
  } catch (e) {
    log?.(`[backend-queue] sidecar migration failed (ignored, crash recovery degraded): ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface BackendQueueRouteOpts {
  images?: QueueTurnImageLike[];
  streamingBehavior?: "steer" | "followUp";
}

export interface BackendQueueManageReq {
  action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
  kind?: "steer" | "followUp";
  from?: number;
  to?: number;
  index?: number;
  targetKind?: "steer" | "followUp";
  text?: string;
}

export interface BackendQueueManageResult {
  steering: string[];
  followUp: string[];
  /**
   * Monotonic version of the queue content (cross-repo contract, consumed by pi-web useAgentSession): incremented after
   * any content change; the queue_update event and queueManage/get_state snapshots carry the same axis from the same source. The frontend uses it to
   * drop out-of-order/stale old snapshots (async get_state responses racing the live queue_update —
   * root fix for 2026-09-18 "queue entries not showing until manual refresh").
   */
  rev: number;
  entry?: { text: string; images?: QueueTurnImageLike[] };
  /** The remove action's QueueTrashItem shape (pi-web core SessionHandle.queueManage contract). */
  removed?: { id: string; kind: string; text: string; hasImages: boolean; queuedAt: number };
}

export interface BackendQueue {
  /** Prompt-entry routing (the handle calls it only while running; the idle branch lets the steer/followUp capability methods go straight to dispatch). */
  routePrompt(text: string, opts?: BackendQueueRouteOpts): Promise<"dispatched" | "queued" | "steered">;
  /** Enqueue locally while running (auto follow-up turn after settle, recalled-able); when idle, same as dispatch. */
  enqueueFollowUp(text: string, images?: QueueTurnImageLike[]): void;
  /** @capability queueManage (SessionHandle.queueManage is forwarded here directly). */
  queueManage(req: BackendQueueManageReq): Promise<BackendQueueManageResult>;
  /** Server-side steer mirror feed (zcode: steerQueued/steerDrained/steerDiscarded events; other backends may omit feeding). */
  registerSteer(pendingInputId: string, input: string): void;
  drainSteer(pendingInputIds: string[]): void;
  clearSteerMirror(): void;
  /** Called by the handle after settle (finally / agent_settled) — idempotent, no-op while running. */
  scheduleDrain(): void;
  /** Sync the queue area to the frontend (queue_update contract: the steering/followUp text groups). */
  emitUpdate(): void;
  /** User bubble (message_end role=user, blocks content — the adapter's string defense already tolerates it). */
  userBubble(text: string): void;
  snapshot(): { steering: string[]; followUp: string[] };
  /** Clear pending + mirror + stop pending follow-up turns. */
  dispose(): void;
}

export function createBackendQueueSupport(opts: BackendQueueOpts): BackendQueue {
  const alive = () => (opts.alive ? opts.alive() : true);
  /** Local followUp queue (with images, R4 closure). */
  let pending: BackendQueueEntry[] = [];
  /** Server-side steer queue mirror (inputs already handed to the backend but not yet drained; full snapshot, read-only display). */
  let steerMirror: Array<{ pendingInputId: string; input: string }> = [];
  /** Queue content version (emitUpdate is the only mutation outlet, incremented each time; snapshot reads do not increment). */
  let rev = 0;
  let disposed = false;
  /** Sidecar recovery lazy-load flag (ensureRestored is idempotent; avoids the field-initializer-before-ctor order problem). */
  let restored = false;
  const persist = (): void => { try { opts.persistence?.save(pending); } catch { /* persistence never blocks the queue */ } };
  /** Recovery: entries queued before the crash return to the queue head (nothing has been enqueued in this process yet, so in practice the whole queue is restored). */
  const ensureRestored = (): void => {
    if (restored || disposed) return;
    restored = true;
    try {
      const saved = opts.persistence?.load() ?? [];
      if (saved.length > 0) {
        pending = [...saved.filter((e) => !pending.some((p) => p.queuedAt === e.queuedAt && p.text === e.text)), ...pending];
        opts.log?.(`[backend-queue] sidecar restored ${saved.length} queued messages`);
        emitUpdate();
      }
    } catch { /* recovery failure does not block the queue */ }
  };

  const snapshot = () => ({
    steering: steerMirror.map((s) => s.input),
    followUp: pending.map((e) => e.text),
  });

  const emitUpdate = (): void => {
    rev += 1;
    opts.onEvent({ type: "queue_update", rev, ...snapshot() });
  };

  const enqueueFollowUp = (text: string, images?: QueueTurnImageLike[]): void => {
    ensureRestored();
    pending.push({ text, ...(images && images.length ? { images } : {}), queuedAt: Date.now() });
    persist();
    emitUpdate();
  };

  /** Steer-failure degradation (R9 generalization): back into the local followUp queue — message not lost, original turn not interrupted. */
  const degradeToQueue = (text: string, images?: QueueTurnImageLike[], reason?: unknown): void => {
    opts.log?.(`[backend-queue] steer send failed, moved to the local queue awaiting the follow-up turn: ${reason instanceof Error ? reason.message : String(reason ?? "")}`);
    enqueueFollowUp(text, images);
  };

  const routePrompt = async (
    text: string,
    routeOpts?: BackendQueueRouteOpts,
  ): Promise<"dispatched" | "queued" | "steered"> => {
    if (opts.isRunning()) {
      // followUp: held locally (queue keeper can recall/reorder), auto follow-up turn after settle
      if (routeOpts?.streamingBehavior === "followUp") {
        enqueueFollowUp(text, routeOpts?.images);
        return "queued";
      }
      // steer / default: inject while running if injection is available (the mirror is fed by the handle via protocol events); on failure degrade to the local queue
      if (opts.steer) {
        try {
          await opts.steer(text, routeOpts?.images);
          return "steered";
        } catch (e) {
          degradeToQueue(text, routeOpts?.images, e);
          return "queued";
        }
      }
      enqueueFollowUp(text, routeOpts?.images);
      return "queued";
    }
    // idle: start a new turn directly (the dispatch closure = the handle's full bookkeeping entry, e.g. prompt())
    await opts.dispatch(text, routeOpts?.images);
    return "dispatched";
  };

  const at = (i: number | undefined): number => {
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= pending.length) throw new Error("queue index out of range");
    return n;
  };

  const queueManage = async (req: BackendQueueManageReq): Promise<BackendQueueManageResult> => {
    ensureRestored();
    if (req.action === "list") return { ...snapshot(), rev };
    const kind = req.kind ?? "followUp";
    if (kind === "steer") {
      throw new Error("this entry was already injected into the backend's server-side steer queue (consumed automatically in the current turn's tool gaps); the protocol does not support recall/move; to cancel, stop this turn (stop)");
    }
    let entry: BackendQueueEntry | undefined;
    /** Stash the cleared followUp texts before clear — the pi clearQueue() contract returns "what was cleared",
     * and the frontend's "edit all" (recallAll) relies on it to backfill the input box; omitting it silently loses messages (observed 2026-09-16). */
    let clearedFollowUp: string[] | undefined;
    switch (req.action) {
      case "clear": {
        clearedFollowUp = pending.map((e) => e.text);
        pending = [];
        break;
      }
      case "move": {
        const from = at(req.from);
        const to = at(req.to);
        const [moved] = pending.splice(from, 1);
        pending.splice(to, 0, moved);
        break;
      }
      case "remove":
      case "recall": {
        const i = at(req.index);
        entry = pending.splice(i, 1)[0];
        break;
      }
      case "requeue": {
        const i = Number(req.index);
        const text = String(req.text ?? "");
        if (!Number.isInteger(i) || i < 0 || i > pending.length) throw new Error("queue index out of range");
        if (!text.trim()) throw new Error("requeue requires non-empty text");
        pending.splice(i, 0, { text, queuedAt: Date.now() });
        break;
      }
      case "convert": {
        const i = at(req.index);
        const target = req.targetKind ?? "steer";
        if (target === "followUp") break; // already in the followUp group, no-op
        if (opts.isRunning() && opts.steer) {
          // native steer available: pick and inject immediately
          const picked = pending.splice(i, 1)[0];
          try {
            await opts.steer(picked.text, picked.images);
          } catch (e) {
            degradeToQueue(picked.text, picked.images, e);
          }
        } else if (opts.isRunning()) {
          // no native steer: jump the queue = move to the queue head (scheduleDrain sends it first after settle).
          // zcode 3.11.2 protocol steer observed not delivering (2026-09-10 probe; see the handle steer:false comment),
          // so the local queue head is the only jump-the-queue semantics the protocol can honor.
          const [picked] = pending.splice(i, 1);
          pending.unshift(picked);
        } else {
          // idle: start a new turn
          const picked = pending.splice(i, 1)[0];
          await opts.dispatch(picked.text, picked.images);
        }
        break;
      }
      default:
        throw new Error(`queueManage: unknown action "${req.action}"`);
    }
    persist();
    emitUpdate();
    // idle-with-queue edge case (settle already passed after convert/clear): leave it — idle enqueue is the caller's scheduleDrain's job
    return {
      ...snapshot(),
      // mutating actions' rev was already incremented in emitUpdate — reading it here yields the post-change version, the same value as the
      // queue_update just emitted; the frontend uses it to order the RPC result against the event stream.
      rev,
      // clear: followUp reports the "pre-clear" content (snapshot already empty) — aligned with the pi clearQueue return convention
      ...(clearedFollowUp ? { followUp: clearedFollowUp } : {}),
      ...(entry
        ? {
            entry: { text: entry.text, ...(entry.images ? { images: entry.images } : {}) },
            // remove → QueueTrashItem (pi-web core contract; recall has only entry)
            ...(req.action === "remove"
              ? {
                  removed: {
                    id: `fu-${entry.queuedAt}`,
                    kind: "followUp",
                    text: entry.text,
                    hasImages: !!(entry.images && entry.images.length),
                    queuedAt: entry.queuedAt,
                  },
                }
              : {}),
          }
        : {}),
    };
  };

  const registerSteer = (pendingInputId: string, input: string): void => {
    if (pendingInputId && input && !steerMirror.some((s) => s.pendingInputId === pendingInputId)) {
      steerMirror.push({ pendingInputId, input });
      emitUpdate();
    }
  };

  const drainSteer = (pendingInputIds: string[]): void => {
    const before = steerMirror.length;
    steerMirror = steerMirror.filter((s) => !pendingInputIds.includes(s.pendingInputId));
    if (steerMirror.length !== before) emitUpdate();
  };

  const clearSteerMirror = (): void => {
    if (steerMirror.length) {
      steerMirror = [];
      emitUpdate();
    }
  };

  /** Auto follow-up turn after settle (drains the followUp queue; idempotent — returns directly while running).
   *  The microtask lets agent_settled reach the frontend first (streaming state reset) before starting the new turn (zcode-proven pattern). */
  const scheduleDrain = (): void => {
    if (disposed || !alive() || opts.isRunning()) return;
    ensureRestored();
    const next = pending.shift();
    persist();
    emitUpdate();
    if (next) {
      queueMicrotask(() => {
        if (disposed || !alive()) return;
        void Promise.resolve(opts.dispatch(next.text, next.images)).catch((e) => {
          opts.log?.(`[backend-queue] follow-up dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      });
    }
  };

  const userBubble = (text: string): void => {
    opts.onEvent({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    });
  };

  const dispose = (): void => {
    disposed = true;
    pending = [];
    steerMirror = [];
    // session closed normally: drop the crash-recovery sidecar too (a crash never reaches here → the sidecar remains for recovery)
    try { opts.persistence?.remove(); } catch { /* best effort */ }
  };

  return {
    routePrompt,
    enqueueFollowUp,
    queueManage,
    registerSteer,
    drainSteer,
    clearSteerMirror,
    scheduleDrain,
    emitUpdate,
    userBubble,
    snapshot,
    dispose,
  };
}
