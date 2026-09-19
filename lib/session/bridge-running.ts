/**
 * bridge-running — running-state tracking for TUI bridge sessions (lights up the sidebar
 * spinner without the web app having to claim/attach the session).
 *
 * Background: attach handles are lazily created only when the web app opens a session
 * (attachIfBridged). After a TUI restart the socket path changes and the old handle dies;
 * afterwards, when the TUI runs a turn, nothing on the web side broadcasts running →
 * the sidebar tree's "running" icon goes missing (reproduced in dev E2E on 2026-08-28:
 * /api/agent/running stayed empty for the whole turn until the user re-opened the session).
 *
 * Mechanism: scan the bridge registry (~/.pi/agent/bridge-registry.json, written by the
 * TUI-side bridge connector; format contract in the attach-agent extension's
 * bridge-registry.ts) and hold one read-only listener connection per live entry — the
 * TUI broadcasts agent_start/agent_end etc. to all clients, and each listener connection
 * maintains that session's running set from those frames. Event-driven, zero polling;
 * registry scans are throttled on the request path (5s) and watchers stay alive until
 * the socket closes or the registry entry disappears.
 *
 * Relationship to attach handles: independent of each other, results unioned and
 * deduped. Double counting while both track the same session is harmless (Set merge);
 * after a full attach closes, the watcher remains so the running indicator is not
 * interrupted.
 */

import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Listener = () => void;

interface BridgeWatcher {
  sessionIds: Set<string>;
  close(): void;
}

// Carried on globalThis so next dev hot reload (new module instance) doesn't drop watchers/listeners (same pattern as handle-store)
interface BridgeRunningStore {
  watchers: Map<string, BridgeWatcher>; // key = socket path
  listeners: Set<Listener>;
  lastScanMs: number;
}

const g = globalThis as { __aitiBridgeRunning?: BridgeRunningStore };
const store: BridgeRunningStore = (g.__aitiBridgeRunning ??= {
  watchers: new Map(),
  listeners: new Set(),
  lastScanMs: 0,
});

const SCAN_THROTTLE_MS = 5_000;

/** Subscribe to bridge-side running changes (triggered via watchers on TUI agent_start/end etc.). Returns an unsubscribe function. */
export function subscribeBridgeRunning(listener: Listener): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

function notify(): void {
  for (const l of store.listeners) {
    try { l(); } catch { /* listener errors must not propagate */ }
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface RegistryRow { sessionFile: string; socket: string; sessionId: string }

/** Read the registry and filter by pid liveness (format/self-healing semantics mirror the attach-agent extension's bridge-registry.readBridgeRegistry) */
function readRegistryRows(): RegistryRow[] {
  const registryPath =
    process.env.PI_BRIDGE_REGISTRY
    ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "bridge-registry.json");
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, { socket?: unknown; pid?: unknown }>;
    const rows: RegistryRow[] = [];
    for (const [sessionFile, entry] of Object.entries(reg)) {
      const m = sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/);
      const socket = typeof entry?.socket === "string" ? entry.socket : "";
      const pid = typeof entry?.pid === "number" ? entry.pid : 0;
      // Flat filenames → sessionId derived from the suffix; nested paths (fork subagent
      // .../<childSessionUuid>/run-0/session.jsonl) → sessionId unknown; the watcher
      // seeds with get_state to learn the authoritative session id (bridge-runningSeed).
      if (!socket) continue;
      if (pid && !isPidAlive(pid)) continue;
      rows.push({ sessionFile, socket, sessionId: m ? m[1] : "" });
    }
    return rows;
  } catch {
    return []; // no registry / parse failure → no bridge
  }
}

/** Attach a read-only listener to one registry entry: send one get_state seed on connect, then rely purely on broadcast frames. */
function watchEntry(row: RegistryRow): void {
  const sessionIds = new Set<string>();
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    if (store.watchers.get(row.socket) === watcher) {
      store.watchers.delete(row.socket);
      if (sessionIds.size > 0) notify();
    }
  };

  const socket = connect({ path: row.socket });
  const watcher: BridgeWatcher = {
    sessionIds,
    close: () => { try { socket.destroy(); } catch { /* already closed */ } finish(); },
  };

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      let msg: { id?: unknown; type?: unknown; data?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      // Seed response: get_state gives the authoritative sessionId (nested fork-subagent
      // entries can't be derived from the registry; the seed returns the subagent's
      // runtime session id = the list-row id) + isStreaming
      if (msg.id === "aiti-bridge-running-seed" && msg.type === "response") {
        const data = msg.data as { sessionId?: unknown; isStreaming?: unknown } | null;
        const sid = String(data?.sessionId ?? "") || row.sessionId;
        if (sid && sid !== row.sessionId) row.sessionId = sid;
        const streaming = (data as { isStreaming?: unknown } | null)?.isStreaming === true;
        if (streaming && row.sessionId && !sessionIds.has(row.sessionId)) {
          sessionIds.add(row.sessionId);
          notify();
        }
        continue;
      }
      if (typeof msg.type !== "string") continue;
      if (!row.sessionId) continue; // id unknown before the seed reply; don't maintain the running set yet
      if (msg.type === "agent_start" || msg.type === "turn_start") {
        if (!sessionIds.has(row.sessionId)) {
          sessionIds.add(row.sessionId);
          notify();
        }
      } else if (msg.type === "agent_end" || msg.type === "agent_settled") {
        if (sessionIds.delete(row.sessionId)) notify();
      }
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);

  // Seed once after connect (works whether the TUI started mid-run or we joined mid-run)
  socket.once("connect", () => {
    try {
      socket.write(JSON.stringify({ id: "aiti-bridge-running-seed", type: "get_state" }) + "\n");
    } catch { finish(); }
  });

  store.watchers.set(row.socket, watcher);
}

/** Registry scan (throttled): attach watchers to new entries, close watchers for vanished entries. */
function ensureWatchers(): void {
  const now = Date.now();
  if (now - store.lastScanMs < SCAN_THROTTLE_MS) return;
  store.lastScanMs = now;

  const rows = readRegistryRows();
  const liveSockets = new Set(rows.map((r) => r.socket));
  for (const row of rows) {
    if (!store.watchers.has(row.socket)) watchEntry(row);
  }
  for (const [socketPath, watcher] of store.watchers) {
    if (!liveSockets.has(socketPath)) watcher.close();
  }
}

/** Session ids currently running a turn on the bridge side (unioned with the handle side for the sidebar running indicator). */
export function getBridgeRunningIds(): string[] {
  ensureWatchers();
  const ids = new Set<string>();
  for (const w of store.watchers.values()) {
    for (const id of w.sessionIds) ids.add(id);
  }
  return [...ids];
}
