// File watch registry (server half of the single SSE convergence for page events).
//
// Isomorphic to the file-editor extension's ed-watch pattern, standardized into
// core so host components such as FileViewer can go through the event bus
// (the editor keeps its own implementation — the two id spaces are unrelated;
// they may be merged later):
//   Client POSTs /api/files/ticket { path, type: "watch", wantWatch: true }
//     → the ticket response inlines a watchId; the server starts fs.watch right away (300ms debounce)
//   Changes are published via publishPageEvent("file-watch", { id, evt: "change"|"gone", size, mtimeMs })
//   Clients subscribe to bus type "file-watch" and filter by id (zero dedicated connections for N files)
//   POST /api/files/watch-stop { watchId } / auto-stop after 30min without events (leak prevention)
// Bus whitelist filtering happens at the SSE forwarding layer: when nobody subscribes to
// "file-watch" no frames leave the connection, so publishing is free.
import { watch, type FSWatcher } from "fs";
import { statSync } from "fs";
import { basename, dirname } from "path";
import { publishPageEventToBus } from "./agent-page-events";

interface WatchRecord {
  target: string;
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setInterval> | null;
  lastFire: number;
}

const IDLE_STOP_MS = 30 * 60_000;
const IDLE_SCAN_MS = 60_000;
const DEBOUNCE_MS = 300;

const watches = new Map<string, WatchRecord>();

function publishFileWatch(id: string, data: Record<string, unknown>): void {
  publishPageEventToBus("file-watch", { id, ...data });
}

/** Call after the ticket is issued: registers a watch on the target path (idempotent; repeat calls with the same watchId are no-ops). */
export function startFileWatch(id: string, target: string): void {
  if (watches.has(id)) return;
  const rec: WatchRecord = { target, watcher: null, debounceTimer: null, idleTimer: null, lastFire: Date.now() };
  const fire = () => {
    if (rec.debounceTimer) return;
    rec.debounceTimer = setTimeout(() => { // 300ms debounce: merge burst events from streaming writes
      rec.debounceTimer = null;
      rec.lastFire = Date.now();
      try {
        const s = statSync(target);
        publishFileWatch(id, { evt: "change", size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
      } catch {
        publishFileWatch(id, { evt: "gone" });
      }
    }, DEBOUNCE_MS);
  };
  try {
    rec.watcher = watch(target, fire);
  } catch {
    try {
      rec.watcher = watch(dirname(target), (_e, name) => {
        if (!name || String(name) === basename(target)) fire();
      });
    } catch {
      return; // Cannot watch: client keeps a static view (no bus frames either — subscribers treat it as no change)
    }
  }
  // Auto-stop after 30min without events (prevents leaks if the client forgets to stop); reopening is driven by the client requesting a new ticket with wantWatch
  rec.idleTimer = setInterval(() => {
    if (Date.now() - rec.lastFire > IDLE_STOP_MS) stopFileWatch(id);
  }, IDLE_SCAN_MS);
  rec.idleTimer.unref?.();
  watches.set(id, rec);
}

export function stopFileWatch(id: string): void {
  const rec = watches.get(id);
  if (!rec) return;
  watches.delete(id);
  try { rec.watcher?.close(); } catch { /* noop */ }
  if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
  if (rec.idleTimer) clearInterval(rec.idleTimer);
}
